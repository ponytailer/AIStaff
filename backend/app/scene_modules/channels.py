"""场景的 4 个处理通道（table_match / sop_flow / handoff / script）。

**这是「处理逻辑复用已有引擎」的落点**：4 个通道都不写新的匹配算法，
``table_match`` 直接调 ``app.scenes.matcher.run_match`` 这个纯函数库。

设计边界（arch §2.0）：
- 通道只产出 ``kind`` + ``data``，**绝不产出任何 UI 描述字段**；
- 通道对「配置缺失」要优雅降级（0 张表不是错误状态，是可绑定的合法状态）；
- 通道内部抛异常由 ``runtime._run_scene_frame`` 捕获后降级到标准 Harness 路径，
  所以这里不做兜底捕获（否则会把真 bug 吞成一句泛泛的文本）。
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import TYPE_CHECKING, Any

from sqlmodel import Session, select

from app.db.models import SceneTable, SceneTableRow
from app.scene_modules.types import SceneRunResult, SceneUiBlock

# 预设生效逻辑（L2 层）。放在这里 import 而不是函数内：channels 与 presets
# 没有循环依赖（presets 只依赖 models），提前导入能让「拼错函数名」在启动时
# 就报错，而不是等到某次场景触发才 500。
from app.scenes.presets import effective_ui_config

# 展示用数字格式化：去掉无意义的小数尾巴，`None` → 「—」。
# 空结果文案里要把用户填的原始槽位值嵌进句子，直接用 f-string 会打出
# 「没有 None 人的方案」或「4000.0 元」。复用 normalize 的同一份实现，
# 保证「卡片里的 4000」和「试跑面板里的 4000」是同一个字符串。
from app.scenes.normalize import format_number, normalize

if TYPE_CHECKING:  # 只用于类型标注，运行期不 import（避免 api → runtime 的循环链）
    from app.db.models import Scene

# ---------------------------------------------------------------------------
# 行级注入键（框架内部，不对外）
#
# 沿用 ``api/scenes.py`` 既有 ``ROW_ID_KEY`` 的命名纪律：双下划线前缀 = 内部字段。
# 响应里统一由 ``hit_payload()`` 剥掉所有 ``__`` 前缀键。
# ---------------------------------------------------------------------------

#: 行主键
ROW_ID_KEY = "__row_id__"
#: 该行来自哪张表（多表合并后行归属靠它）
SOURCE_TABLE_ID_KEY = "__source_table_id__"
#: 表名，结果卡「来自：滑雪价目-华北」直接读它
SOURCE_TABLE_NAME_KEY = "__source_table_name__"

_INTERNAL_ROW_KEYS = (ROW_ID_KEY, SOURCE_TABLE_ID_KEY, SOURCE_TABLE_NAME_KEY)

#: 场景表单的标题兜底（前端 `SlotFormCard` 已消费 ``build_slot_form`` 的输出）
_DEFAULT_FORM_TITLE = "请补充以下信息"


# ============================================================
# 列定义归一化（与 api/scenes.py 的 `_col_payload` 逐行一致）
# ============================================================


def normalize_column(raw: dict[str, Any]) -> dict[str, Any]:
    """列定义容错：老数据/手写配置可能缺字段，不能让整个场景 500。

    这是 ``api/scenes.py`` 原 ``_col_payload`` 的唯一实现。搬到这里是为了让
    ``_resolve_slot_columns`` 与表预览接口共用同一份归一化逻辑——两份实现
    必然漂（一份多了 ``unit`` 兜底、另一份没加，列 key 就对不上了）。
    """
    return {
        "key": str(raw.get("key") or ""),
        "label": str(raw.get("label") or raw.get("key") or ""),
        "type": raw.get("type") if raw.get("type") in ("number", "text", "url", "date") else "text",
        "unit": str(raw.get("unit") or ""),
        "aliases": list(raw.get("aliases") or []),
        "required": bool(raw.get("required")),
        "filterable": bool(raw.get("filterable")),
        "order": int(raw.get("order") or 0),
    }


def columns_signature(raw_columns: list[dict[str, Any]] | None) -> str:
    """列结构指纹：``列key+type+unit`` 的有序序列哈希。

    用途只有一个：第二张表上传时**秒判同构**（PRD §12.2）。多表合并的前提是
    所有表共用同一套列语义，否则合并池里会出现「同一列名两种含义」。

    生成逻辑与同构校验必须共用本函数（impl-map §4 第 2 条：不能各写一份）。
    """
    parts: list[str] = []
    for raw in raw_columns or []:
        col = normalize_column(raw)
        parts.append(f"{col['key']}:{col['type']}:{col['unit']}")
    digest = hashlib.sha1("\u0001".join(parts).encode("utf-8")).hexdigest()
    return digest


def columns_diff(
    expected: list[dict[str, Any]] | None,
    actual: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """逐列对比两张表的结构，返回 ``[{column, kind, expected, actual}]``。

    ``kind`` 取值：
    - ``missing``：主表有、新表没有
    - ``extra``：新表多出来的列
    - ``type_changed`` / ``unit_changed``：同名不同义

    返回空列表 = 同构，可以并入同一个合并池。
    """
    left = [normalize_column(c) for c in (expected or [])]
    right = [normalize_column(c) for c in (actual or [])]
    right_by_key = {c["key"]: c for c in right}
    left_keys = {c["key"] for c in left}
    diffs: list[dict[str, Any]] = []
    for col in left:
        other = right_by_key.get(col["key"])
        if other is None:
            diffs.append(
                {
                    "column": col["key"],
                    "kind": "missing",
                    "expected": col["key"],
                    "actual": "",
                }
            )
            continue
        if other["type"] != col["type"]:
            diffs.append(
                {
                    "column": col["key"],
                    "kind": "type_changed",
                    "expected": col["type"],
                    "actual": other["type"],
                }
            )
        if other["unit"] != col["unit"]:
            diffs.append(
                {
                    "column": col["key"],
                    "kind": "unit_changed",
                    "expected": col["unit"],
                    "actual": other["unit"],
                }
            )
    for col in right:
        if col["key"] not in left_keys:
            diffs.append(
                {
                    "column": col["key"],
                    "kind": "extra",
                    "expected": "",
                    "actual": col["key"],
                }
            )
    return diffs


# ============================================================
# 表加载：唯一的合并点
# ============================================================


def load_scene_tables(db: Session, scene_id: str) -> list[dict[str, Any]]:
    """加载一个场景的全部数据表（含行），按 ``order_index`` 排好。

    返回 ``[{id, name, order_index, columns, rows}]``。

    行上注入两个内部键（见 arch §4.4）：
    - ``__source_table_id__`` / ``__source_table_name__``

    **注意 ``**dict(r.row_json)`` 在后面**：用户表里真有叫 ``__row_id__``
    的列时会覆盖注入值——这是安全的，因为 ``matcher._row_id()`` 只在该键
    真的不存在时才回退到表里的 ``id`` 列；反过来的写法会把用户的 ``id``
    列悄悄换成主键（``api/scenes.py`` 注释里踩过的坑）。

    ``scene_id`` 为空的孤儿表（v2 及以前没有归属）永远不会被这个查询命中，
    所以存量脏数据不影响运行时。
    """
    if not scene_id:
        return []
    tables = db.exec(
        select(SceneTable)
        .where(SceneTable.scene_id == scene_id)
        .order_by(SceneTable.order_index, SceneTable.created_at)  # type: ignore[attr-defined]
    ).all()
    out: list[dict[str, Any]] = []
    for table in tables:
        row_records = db.exec(
            select(SceneTableRow)
            .where(SceneTableRow.table_id == table.id)
            .order_by(SceneTableRow.row_index)  # type: ignore[attr-defined]
        ).all()
        out.append(
            {
                "id": table.id,
                "name": table.name,
                "order_index": table.order_index,
                "columns": list(table.columns_json or []),
                "rows": [
                    {
                        ROW_ID_KEY: record.id,
                        SOURCE_TABLE_ID_KEY: table.id,
                        SOURCE_TABLE_NAME_KEY: table.name,
                        **dict(record.row_json or {}),
                    }
                    for record in row_records
                ],
            }
        )
    return out


# ============================================================
# 槽位列解析（从 api/scenes.py 原样迁入，只改第二参类型）
# ============================================================


def _resolve_slot_columns(
    scene: "Scene",
    columns: list[dict[str, Any]],
) -> tuple[str, str, str]:
    """把槽位映射到实际的列 key。

    **函数体逐行照抄自 ``api/scenes.py:655-684``**（唯一改动是第二参从
    ``SceneTable`` 换成 ``columns`` 列表 —— 因为要多表）。1 张表时输出与
    改造前**逐位一致**，这是 R1 红线的前提。

    ⚠️ **返回仍是三元组，不要改成 dict**：调用点是
    ``people_key, days_key, budget_key = _resolve_slot_columns(...)``。
    返回恰好 3 个 key 的 dict 时 Python **不报错**，但解包出的是 3 个
    *key 字符串*（``"people"``）而不是 3 个*列名*（``"人数"``）→ matcher 拿
    ``"people"`` 去查中文表的 ``"人数"`` 列 → 全取空 → 命中数从 2 变 0，
    全程无异常。这是最难查的一种静默错误。

    四层兜底原样保留（每一条都是实战踩出来的，删一条就会有表配不上列）：
      ① 槽位声明里的 ``role`` 命中（新能力，仅对显式声明了 role 的场景生效）
      ② ``slot.target`` 命中现有列 key
      ③ 同名 key 命中
      ④ ``label_hints`` 模糊命中（列 key 或列 label 含该 hint）
      ⑤ 一个都匹配不上 → 返回 ``slot_key`` 本身，让 matcher 拿空值走
         「跳过该层」，而不是在这里抛 500 把整个场景搞崩

    ①~④ 的全序：``role`` 是新增的一层，**只有存在 ``role`` 字段才会命中**；
    存量 ``slots_json``（只有 ``{key, target}``）走的是原来的路径，一个字节都不变。
    """
    normalized = [normalize_column(c) for c in (columns or [])]
    keys = {c["key"] for c in normalized}
    slots = list(scene.slots_json or [])

    def _target_of(slot: dict[str, Any]) -> str:
        return str(slot.get("target") or "").strip()

    def pick(slot_key: str, label_hints: tuple[str, ...]) -> str:
        # ① role 声明优先（新能力）。存量数据没有 role 字段 → 这一轮必然落空。
        for slot in slots:
            if str(slot.get("role") or "") == slot_key:
                target = _target_of(slot)
                if target and target in keys:
                    return target
        # ②~③ 原有链路：同名 slot 的 target → 同名 key
        for slot in slots:
            if str(slot.get("key") or "") == slot_key:
                target = _target_of(slot)
                if target and target in keys:
                    return target
        if slot_key in keys:
            return slot_key
        # ④ label_hints 模糊命中
        for hint in label_hints:
            for col in normalized:
                if hint in col["key"] or hint in col["label"]:
                    return col["key"]
        # ⑤ 一个都匹配不上时用同名 key——让 matcher 拿到空值走「跳过该层」，
        #    而不是在这里抛 500 把整个场景搞崩
        return slot_key

    return (
        pick("people", ("人数", "人")),
        pick("days", ("天数", "天", "晚")),
        pick("budget", ("预算", "价格", "费用", "金额", "价")),
    )


def unit_by_slot_of(scene: "Scene") -> dict[str, str]:
    """从槽位声明里收集「每个语义槽位期望单位」。

    这是 ``run_match(unit_by_slot=...)`` 的第三级回落的**第一级来源**：
    - 槽位显式声明了 ``unit`` → 用它（新能力，``adoptSemanticSlots`` 会写 人/天/元）
    - 没有声明 → 不放进 dict，让 ``run_match`` 回落到 ``_EXPECTED_UNIT_BY_SLOT``

    存量夹具的槽位是 ``{key, target, required}``，**没有 unit** → 返回 ``{}``
    → ``run_match`` 走原硬编码默认 → ``5→4`` 的漏斗数字天然不变。
    这正是「回落默认」这个设计的价值：R1 不依赖工程师记得检查夹具。
    """
    out: dict[str, str] = {}
    for slot in scene.slots_json or []:
        key = str(slot.get("key") or "").strip()
        unit = str(slot.get("unit") or "").strip()
        if key and unit:
            out[key] = unit
    return out


# ============================================================
# 结果行 → 对外 hit 载荷
# ============================================================


def hit_payload(match_row: Any) -> dict[str, Any]:
    """把 matcher 的 ``MatchRow`` 转成对外 hit。

    ``values`` 必须是「纯表格行」：所有 ``__`` 前缀的内部键都要剥掉，
    否则前端会把它当成表格里真实存在的列（模板占位符校验会算它、
    命中卡会多渲染一格空列）。
    """
    values = {k: v for k, v in dict(match_row.row or {}).items() if not k.startswith("__")}
    return {
        "row_id": match_row.id,
        "values": values,
        "score": round(match_row.score, 4),
        "days_dev": round(match_row.days_dev, 4),
        "budget_dev": round(match_row.budget_dev, 4),
        "fused": round(match_row.fused, 4) if match_row.fused is not None else None,
        "source_table": str((match_row.row or {}).get(SOURCE_TABLE_NAME_KEY) or ""),
    }


def _visible_funnel(trace: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """空卡上要展示的漏斗：**截到第一层归零为止**。

    没有行能穿过某一层时，后面的层只会继续 `0 → 0`。这些 0 不是信息，
    是噪音 —— 用户会以为被连续拒绝了三次。

    规则：
      - 保留第 1 步（「读表 5」是基数，没有它后面的数字没有参照）；
      - 逐层往下，**包含**第一个 `to == 0` 的层（它就是答案：卡在这一层）；
      - 遇到归零层就停，后面的全丢掉。

    例（本轮用户截图里的真实情况，3 人 / 4 天 / 4000 元）：

        完整 5 步                        空卡上显示
        ─────────────────────────────    ─────────────────
        5 → 读表                          5 → 读表
        5 → 人数对上   ← 归零             5 → 人数对上   ← 归零
        0 → 天数对上                      （丢掉）
        0 → 预算接近                      （丢掉）
        0 → 最终给出                      （丢掉）

    ⚠️ 这是**纯展示裁剪**，不参与任何计算。`detail.steps` 与
    `SceneRun.trace_json` 仍然保存完整版 —— 排障时要看得到流程跑完了。
    """
    if not trace:
        return []
    visible: list[dict[str, Any]] = []
    for index, step in enumerate(trace):
        visible.append(step)
        if index == 0:
            continue  # 第一步永远保留（它是基数，哪怕表本来就是 0 行）
        if int(step.get("to") or 0) == 0:
            break  # 归零层已交代清楚，后面的 0 都是必然的
    return visible


def _as_number(value: Any) -> float | None:
    """把槽位原始值转成数字，转不出来就 `None`。

    只用于**文案拼装**（`format_number(_as_number(...))`）。为什么不直接
    `format_number(slots.get("people"))`：表单提交的是数字，但历史数据里
    可能是字符串（``"4"``），而 `format_number` 内部有
    ``float(value) == int(value)`` —— 传字符串会抛 TypeError，把「渲染空结果卡」
    变成 500。这个函数把脏值收敛成 `None`，`format_number` 再显示成「—」，
    最坏情况是文案里出现一个破折号，不会整轮消息失败。
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # 排除 NaN


def empty_reason_for(result: Any, slots: dict[str, Any]) -> str:
    """空结果卡里的完整解释（``data.reason``）。

    ## 文案要能被「没看过配置的用户」读懂

    旧版写的是一串内部术语：

        表里没有 3 人的方案（5 行都在人数这层被排除）。

    三个问题：① 「人数这层」是什么层，用户没见过；② 「被排除」像被系统拒了，
    语气生硬；③ 用户真正想知道的是「那我怎么办」，全句一个出路都没给。

    现在每句都写成「时间 + 原因 + 出路」：

        表里这 5 个方案没有 3 人的，最少的是 2 人、最多 6 人。
        → 换个接近的人数，或者看看下面最接近的几个。

    **必须保留 `empty_summary_for` 的分层一致**：两处若漂移，就会出现
    「正文说卡人数、卡片说卡天数」的矛盾。改这里要同步改那边。

    ``slots`` 里的值是**用户填的原始值**（可能是 0），不是归一化后的数字 ——
    所以这里统一走 ``format_number`` 兜一下，避免出现 ``None 人``。
    """
    if result.total == 0:
        return "这张表里还没有数据，先把方案表传上来我再帮你筛。"
    if result.unconvertible and result.unconvertible >= result.total:
        # 这是数据侧故障，不是用户填错。要明确指出去修表，别让用户反复试条件。
        return (
            "表里的数字读不出来（可能是列映射错了，或者整列是文本）。"
            "需要先在数据表里把人数、天数、预算指到正确的列。"
        )
    if result.invalid_budget:
        return "预算要填大于 0 的金额。改好之后我再按预算帮你排一次。"

    norm_step = next((s for s in result.steps if s.key == "normalize"), None)
    people_step = next((s for s in result.steps if s.key == "people"), None)
    days_step = next((s for s in result.steps if s.key == "days"), None)
    score_step = next((s for s in result.steps if s.key == "score"), None)

    people_text = format_number(_as_number(slots.get("people")))
    days_text = format_number(_as_number(slots.get("days")))

    if people_step and people_step.to == 0 and people_step.from_ > 0:
        return (
            f"表里这 {people_step.from_} 个方案里没有 {people_text} 人的。"
            "换个接近的人数，或者看看下面最接近的几个。"
        )
    if days_step and days_step.to == 0 and days_step.from_ > 0:
        # 容差从 detail 里读不出来，但**不能写死 ±1** —— 那会在管理员
        # 把 days_tolerance 调成 2 之后变成假话。这里改为描述「前后都算过」，
        # 具体天数由 detail 承担（展开可见）。
        return (
            f"人数对上了，但没有 {days_text} 天左右的方案"
            f"（前后各放宽了一点也没找到）。"
            "把天数改一下，或者看看下面最接近的几个。"
        )
    if score_step and score_step.to == 0 and score_step.from_ > 0:
        return (
            "人数和天数都对上了，但预算差得太远，已经全部排除。"
            "把预算调高一些，或者看看下面最接近的几个。"
        )
    if norm_step and norm_step.to == 0:
        return "表里的数字读不出来，需要检查数据表的列映射。"
    return "这组条件没对上。下面是最接近的几个，可以拿来参考。"


def empty_summary_for(result: Any, slots: dict[str, Any]) -> str:
    """空结果的**消息正文**（`result.text`），一句话说清卡在哪一层。

    为什么需要它、且不能直接复用 :func:`empty_reason_for`：

    空结果原先被发了**三处**（``channels.py`` 曾同时有 ``text`` 块、
    空卡 ``data.reason``、以及 ``text_out = empty_reason``）。前端渲染顺序是
    「正文 → blocks」，于是同一句话在气泡和卡片里各说一遍 —— 用户截图里
    能看到「表里没有 3 人的方案…」连着出现两次。

    这与引导语那次是**同一个病**：一句话被拆成两份发。但那次的结论不能
    直接照搬到这里，因为 ``result.text`` 就是 ``reply_fragment``
    （见 ``core/engine/turn_frames.py`` 的 ``reply = result.text``），而
    **企微 / 微信 / 短信只吃 `text`，根本收不到 blocks**。所以正文不能退化成
    「先看卡片」这种废话 —— 那样非 UI 渠道的用户就永远不知道为什么没匹配上。

    所以这里的分工是「各说一半，都不许省略关键信息」：
      - 卡片内 ``data.reason``：完整的量化原因，紧挨着 ``steps`` 漏斗；
      - 正文（本函数）：一句更短的同义话，独立可读，非 UI 渠道靠它。

    分支判断与 :func:`empty_reason_for` **刻意保持一致**，两处若漂移，
    就会出现「正文说卡在天数、卡片说卡在人数」的矛盾。

    ⚠️ 正文里**不许出现 `±1` 这类写死的容差**：容差是可配的
    （`days_tolerance` / `people_tolerance`），写死之后管理员一改配置，
    这句话就变成假话。要提容差就描述成「前后各放宽了一点」。
    """
    if result.total == 0:
        return "这张表还没有数据，先上传一份再试。"
    if result.unconvertible and result.unconvertible >= result.total:
        return "表里的数字读不出来，需要检查数据表的列映射。"
    if result.invalid_budget:
        return "预算金额不合法，填一个大于 0 的数再试。"

    norm_step = next((s for s in result.steps if s.key == "normalize"), None)
    people_step = next((s for s in result.steps if s.key == "people"), None)
    days_step = next((s for s in result.steps if s.key == "days"), None)
    score_step = next((s for s in result.steps if s.key == "score"), None)

    people_text = format_number(_as_number(slots.get("people")))
    days_text = format_number(_as_number(slots.get("days")))

    if people_step and people_step.to == 0 and people_step.from_ > 0:
        return f"没找到 {people_text} 人的方案，表里的人数都对不上。"
    if days_step and days_step.to == 0 and days_step.from_ > 0:
        return f"人数对上了，但没有 {days_text} 天左右的方案。"
    if score_step and score_step.to == 0 and score_step.from_ > 0:
        return "人数和天数都对上了，但预算差得太远，全被排除了。"
    if norm_step and norm_step.to == 0:
        return "表里的数值解析不了，卡在数据表的数字列。"
    return "这组条件没对上，下面是最接近的几个。"


def _show_empty_funnel(scene: "Scene", db: Session) -> bool:
    """空结果卡要不要展示漏斗（`5 → 读表` 那几行）。

    **默认 False。** 这是个纯展示开关，不是功能开关 —— 关闭时
    `detail.steps` / `result.trace` 仍然完整，试跑面板与排障都不受影响。

    为什么默认关：`reason` 已经把「卡在哪层 + 下一步怎么办」说完了，
    漏斗是同一件事的另一种写法。用户看到「5 → 读表」第一反应是
    「5 是什么？」，而那个 5 是他自己台账的行数 —— 与他无关。

    取值走 `effective_ui_config` 的 `params`（与 `show_source_table` 同一个
    位置），所以超管在预设页或场景里都能打开；存量场景不受改默认值影响，
    因为这里按 `False` 兜底、只认显式 `true`。
    """
    try:
        params = dict(effective_ui_config(scene, db).get("params") or {})
    except Exception:
        # 配置读不出来不该让「渲染空结果卡」失败 —— 这是错误路径，
        # 在错误路径上再崩一次是最糟的体验。退回默认（不展示）。
        return False
    return params.get("show_empty_funnel") is True


# ===========================================================================
# 空结果建议按钮
# ===========================================================================


#: 槽位 key → 标签里用的单位后缀。只用于拼按钮文案。
_PATCH_UNIT: dict[str, str] = {"people": "人", "days": "天"}


def _patch_label(
    patch: dict[str, Any],
    fallback: str,
) -> str:
    """把 `patch` 拼成「按 4 人 / 5 天 / ¥3000 找」这样的按钮文案。

    ## 为什么要把所有改动的槽都说出来

    用户点的是「换人数」，但 `patch` 里常常还有天数与预算（只改一项救不回
    一个方案 —— 见 `_rerun_patch`）。如果标签只写「按 4 人找」，点下去
    结果卡上却是「5 天、¥3000」，他会觉得**系统偷偷改了他没同意的条件**。

    这跟「放宽了要声明」是同一条原则：任何替用户做的决定都必须让他看见。
    所以标签把每一项都列出来，用户在点之前就知道会发生什么。

    顺序固定为 人数 → 天数 → 预算（与表单字段顺序一致）。
    """
    parts: list[str] = []
    for key in ("people", "days"):
        value = patch.get(key)
        if value is None:
            continue
        parts.append(f"{format_number(value)} {_PATCH_UNIT[key]}")
    budget = patch.get("budget")
    if budget is not None:
        parts.append(f"¥{format_number(budget)}")
    if not parts:
        return fallback
    return f"按 {' / '.join(parts)} 找"


def _rerun_patch(
    result: Any,
    slots: dict[str, Any],
    slot: str,
) -> dict[str, Any]:
    """算出一组**点下去一定能出结果**的槽位调整（可能不止一个槽）。

    这是「按钮要真能承上」的实现。核心洞察：**只改一个槽常常不够**。

    真实案例（用户截图那次）：3 人 / 4 天 / 4000 元 全空，卡在人数层。
    把人数从 3 改成 4 依然空 —— 表里 4 人方案的天数是 5/6，用户填的是 4 天，
    天数层接着归零。用户点一次按钮，得到另一个空结果，比不给建议更糟。

    所以这里从 `result.row_combos`（表里三列都有效的**整行**）里挑一组
    **成套**的取值，保证「人数 → 天数」两层都能过：

      1. 只在用户点的那一列上做近似（他点的就是「换人数」，别动他不想动的）；
      2. 其余列直接取那一行的真实值 —— 否则组合不成立；
      3. 预算不碰：它不是硬约束（走打分 + 闸门），抬高由专门的按钮负责。

    返回 `{槽位: 值}`；空 dict 表示算不出（调用方退回纯文本按钮）。
    """
    combos = list(getattr(result, "row_combos", None) or [])
    if not combos:
        # 表里没有一行三列都有效 —— 数据侧问题，改槽救不回来
        return {}

    def _num(key: str) -> float | None:
        norm = normalize(slots.get(key))
        return norm.num if norm is not None and norm.ok and norm.num > 0 else None

    want_people = _num("people")
    want_days = _num("days")

    # 只在**用户点击的那一列**上做距离排序，其余列取该行的真值。
    #
    # 为什么不能对两列同时求距离后再挑：那样会选出「人数差 0.5、天数差 0.5」
    # 的行，而用户点的是「换人数」，他接受的是人数变化、不接受天数偷偷变
    # 得更多。以被点的那列为第一关键字，能让建议更符合他的预期。
    if slot == "days":
        def key(row: dict[str, float]) -> tuple[float, float, float]:
            return (
                abs(row["days"] - want_days) if want_days is not None else 0.0,
                abs(row["people"] - want_people) if want_people is not None else 0.0,
                row["budget"],
            )
    else:
        def key(row: dict[str, float]) -> tuple[float, float, float]:
            return (
                abs(row["people"] - want_people) if want_people is not None else 0.0,
                abs(row["days"] - want_days) if want_days is not None else 0.0,
                row["budget"],
            )

    best = min(combos, key=key)

    def _clean(value: float) -> int | float:
        return int(value) if value == int(value) else value

    patch: dict[str, Any] = {}
    # 被点的那一列一定下发（哪怕值没变，也要让标签上的"按 X 找"名副其实）
    if slot in ("people", "days"):
        patch[slot] = _clean(best[slot])
    # 另外的硬约束列一并用该行的真值补齐 —— 这是「组合成立」的关键。
    # 用户没填过的列不替他填（那是另一个语义：补空槽，不是放宽）。
    for other in ("people", "days"):
        if other == slot:
            continue
        if (want_people if other == "people" else want_days) is None:
            continue
        patch[other] = _clean(best[other])

    # 预算也要一起抬：人数和天数都对上、最后被预算闸门淘汰的**是常态**。
    #
    # 真实案例：9 人 / 1 天 / 100 元 → patch 出「6 人 5 天」，重跑仍然空 ——
    # 因为 100 元远低于表里最便宜的 980 元，整行在闸门被淘汰。此时标签
    # 写「按 6 人找」而结果还是空，就是**骗人**：用户点第二次会怀疑功能坏了。
    #
    # 所以这里把预算一并抬到该行的真实预算。这不是「偷偷改条件」——
    # 标签本来就说明了会换人数/天数，重跑的结果卡片上也会显示新预算。
    if "budget" in best and best["budget"] > 0:
        want_budget = _num("budget")
        # 只在用户填过预算时补（没填就不该凭空塞一个）
        if want_budget is not None and abs(best["budget"] - want_budget) > 1e-9:
            patch["budget"] = _clean(round(best["budget"]))
    return patch


def _empty_suggestions(
    result: Any,
    slots: dict[str, Any],
    mode: str,
) -> list[dict[str, Any]]:
    """空卡下方的「放宽建议」按钮，**按卡住的那一层给**。

    原先这里是写死的两颗（「放宽预算再试」/「换个人数」）—— 无论卡在
    人数、天数还是预算，都给同样两颗。用户点了「放宽预算」，而问题明明
    是「表里没有 3 人方案」，等于把他往错方向推。

    现在按漏斗里**第一个归零的层**生成建议，并且：

      - `clarify` 模式多给一颗「都不改，就看看最接近的」，因为这一档的
        语义就是「反问能不能放宽」，用户需要一条「不想放宽」的退路；
      - 只给 `nearest` / `clarify` 用。`none` 的调用方（空结果分支）
        根本不会调用本函数 —— 「只说明没有结果」就是不给建议按钮。

    ## 每颗按钮都带 `slot_patch`（2026-11-26 补）

    早期这里只给 `label` + `send_text`，于是按钮做了「一句话」而不是
    「一个动作」：`send_text` 是「天数可以再灵活一点」，进了普通对话，
    没有任何触发关键词，后端落回 `standard` 模式，一个方案都没重算。
    用户点完只看到模型开始闲聊 —— 这就是截图里的第二处问题。

    现在每颗按钮多给 `{"slot": "days", "value": 6}`，前端拿到后直接改
    槽位重跑（走 `submitSlots` + `forcedSceneId`），不经过模型。

    `send_text` 仍然保留：非 UI 渠道（企微/微信/短信）只吃文本，
    历史回看也只有文本，它们是**降级路径**而不是被删掉的旧逻辑。
    """
    people_step = next((s for s in result.steps if s.key == "people"), None)
    days_step = next((s for s in result.steps if s.key == "days"), None)
    score_step = next((s for s in result.steps if s.key == "score"), None)

    suggestions: list[dict[str, Any]] = []
    if result.total == 0 or (result.unconvertible and result.unconvertible >= result.total):
        # 数据侧的问题，放宽条件没用 —— 给的都是「去修数据」的动作。
        # ⚠️ 这颗**不能**带 slot_patch：改槽位救不了数据故障，
        # 带上了会让用户反复点，每次都空。
        suggestions.append({"label": "检查数据表", "send_text": "帮我看看数据表的列映射"})
        return suggestions

    if result.invalid_budget or (score_step and score_step.to == 0):
        # ⚠️ 只有**预算层真的跑到了**才给这颗按钮（`score_step` 存在）。
        # 卡在人数层时 `score_step` 也可能是 `0 → 0`（打过卡但没行进来），
        # 此时「预算再高一点」是错误引导 —— 用户改了预算依然 0 人，
        # 他会觉得系统在乱指路。这一条正是 `_empty_suggestions` 注释里
        # 说要修的那个病（原来写死两颗，不分卡在哪层）。
        score_reached = score_step is not None and score_step.from_ > 0
        if result.invalid_budget or (score_reached and score_step.to == 0):
            # 预算不是硬约束（走打分 + 闸门），「改成多少」取决于差多少。
            # 取近似项里的最低预算，往上留 10% 余量 —— 直接给近似项的最低值
            # 会卡在闸门边界上（`score <= max_score` 恰好等于时能过，浮点误差
            # 可能让它过不去），留一点余量比「点了还是空」好。
            budget_value: int | float | None = None
            nearest_rows = list(getattr(result, "nearest", []) or [])
            budgets = [
                float(r.nb.num)
                for r in nearest_rows
                if getattr(r, "nb", None) is not None and r.nb.ok and r.nb.num > 0
            ]
            if budgets:
                budget_value = round(min(budgets) * 1.1)
            # 与人数/天数一致：标签说清改成多少。预算用「元」这个单位，
            # 用户判断得比「再高一点」准确得多。
            #
            # 这里不走 `_patch_label` —— 那颗按钮只改预算一个槽，
            # 而该函数的句式是「按 X / Y / ¥Z 找」，套在预算单改上会拧。
            item: dict[str, Any] = {
                "label": (
                    f"预算提到 ¥{format_number(budget_value)}"
                    if budget_value is not None
                    else "预算再高一点"
                ),
                "send_text": "预算可以再高一点",
            }
            if budget_value is not None:
                item["patch"] = {"budget": budget_value}
            suggestions.append(item)

    if people_step and people_step.to == 0 and people_step.from_ > 0:
        patch = _rerun_patch(result, slots, "people")
        # 标签把**所有**会变的槽都列出来，不只用户点的那一个 ——
        # 点下去结果卡上出现「5 天、¥3000」而标签只写「按 4 人找」，
        # 用户会以为系统偷偷改了他没同意的条件。
        item: dict[str, Any] = {
            "label": _patch_label(patch, "换个人数"),
            "send_text": "人数可以换一下",
        }
        if patch:
            item["patch"] = patch
        suggestions.append(item)

    if days_step and days_step.to == 0 and days_step.from_ > 0:
        patch = _rerun_patch(result, slots, "days")
        item = {
            "label": _patch_label(patch, "天数灵活一点"),
            "send_text": "天数可以再灵活一点",
        }
        if patch:
            item["patch"] = patch
        suggestions.append(item)

    if not suggestions:
        # 兜底：卡在两个已知层都不成立的地方（比如规范化层），
        # 与其给一句空建议，不如给「重填条件」这个通用出口。
        # 这颗同样不带 patch —— 没有明确的可调项时，让用户自己重填表。
        suggestions.append({"label": "换个条件再找", "send_text": "我想换个条件再找一次"})

    if mode == "clarify":
        # 「就看最接近的」是纯展示动作，不改任何槽位
        suggestions.append({"label": "就看最接近的", "send_text": "看看最接近的几条"})
    return suggestions[:3]


def _clarify_hint_for(result: Any, slots: dict[str, Any]) -> str:
    """`on_empty="clarify"` 时正文末尾那句**反问**。

    为什么不能写「要不要放宽条件？」这种通用句：用户上一轮刚抱怨过
    「我选了这个，但对话的时候仍然让我换个条件再试试」。空泛的反问
    正是他讨厌的东西。所以这里必须**点名哪一条能放宽、放宽到多少**：

        没有 3 人的方案，要不要按 4 人的方案看？

    与 :func:`empty_summary_for` 一样按漏斗分层，两处若漂移就会出现
    「正文说卡人数、反问句说放宽天数」的矛盾。
    """
    people_step = next((s for s in result.steps if s.key == "people"), None)
    days_step = next((s for s in result.steps if s.key == "days"), None)
    score_step = next((s for s in result.steps if s.key == "score"), None)

    if result.total == 0:
        return "先上传一份数据表，我再帮你筛。"
    if result.invalid_budget:
        return "预算填一个大于 0 的数，我按预算帮你排一次。"
    if people_step and people_step.to == 0 and people_step.from_ > 0:
        return "要不要换个人数，或者直接看最接近的几个方案？"
    if days_step and days_step.to == 0 and days_step.from_ > 0:
        return "要不要把天数放宽一点再试？"
    if score_step and score_step.to == 0 and score_step.from_ > 0:
        return "要不要把预算放宽一点再试？"
    return "要不要换个条件再找一次？"


def _render_template(template: str, values: dict[str, Any]) -> str:
    """把 ``{{列key}}`` 占位符换成实际值。未知占位符整段抹掉（不留 ``{{xxx}}``）。"""
    text = str(template or "")
    for key, value in (values or {}).items():
        text = text.replace("{{" + str(key) + "}}", str(value if value is not None else ""))
    while "{{" in text and "}}" in text:
        start = text.index("{{")
        end = text.index("}}", start)
        text = text[:start] + text[end + 2 :]
    return text.strip()


# ============================================================
# 通道 1：table_match
# ============================================================


def _slot_form_block(
    scene: "Scene",
    slots: dict[str, Any],
    db: Session | None = None,
) -> SceneUiBlock | None:
    """缺必填槽位时产一张 ``form`` block（复用 ``build_slot_form()``）。

    ``data`` 的形状**冻结**（arch §2.2）：前端 ``SlotFormCard`` 已在消费
    ``build_slot_form`` 的输出（``kind="slot_form"`` / ``fields`` / ``title`` /
    ``submit_label``），重造一套字段 schema 会让「定制 module 自己画表单」
    与通用表单走两条路，提交行为不一致。
    """
    from app.core.sop.slots.form import build_slot_form

    missing: list[str] = []
    labels: dict[str, str] = {}
    # 场景槽位自己声明的类型与单位。**必须优先于 `build_slot_form` 的推断**：
    # 那个函数是按字段名的后缀猜类型的（`*_amount` → number、`is_*` → 开关），
    # 而场景槽位的 key 是 `people` / `days` / `budget` —— 一个后缀都不命中，
    # 于是三个数值字段统统被编译成 `type: "text"`。
    #
    # 后果不是「难看」而是「错」：前端拿不到 number 就画不出分段按钮，且提交
    # 出去的值会是字符串，后端 matcher 按数值比区间时把它判成不可转换直接丢掉。
    declared: dict[str, dict[str, Any]] = {}
    for slot in scene.slots_json or []:
        key = str(slot.get("key") or "").strip()
        if not key:
            continue
        labels[key] = str(slot.get("label") or slot.get("target") or key)
        declared[key] = {
            "type": str(slot.get("type") or "").strip(),
            "unit": str(slot.get("unit") or "").strip(),
            "prompt": str(slot.get("prompt") or slot.get("ask") or "").strip(),
            "label_raw": str(slot.get("label") or "").strip(),
        }
        if not bool(slot.get("required")):
            continue
        if slots.get(key) in (None, "", [], {}):
            missing.append(key)
    if not missing:
        return None
    ui_config = effective_ui_config(scene, db)
    params = dict(ui_config.get("params") or {})
    # 表单标题优先取顶层 `form_title`，其次 params 里的同名键。
    # 两处都认的理由：`form_title` 是本次预设改造新增的位置（它不属于 module
    # 参数，而是表单本身的文案），存量场景则把它存在 params 里。
    #
    # 三处都没配时用「场景名 · 请补充条件」而不是写死的通用句：demo 的卡头是
    # 「行程规划 · 请补充条件」，用户点的是「滑雪行程推荐」，表单标题带场景名
    # 才对得上「我点的那条」；写成「请补充以下信息」会让人怀疑走错了地方。
    title = (
        str(ui_config.get("form_title") or "").strip()
        or str(params.get("form_title") or "").strip()
        or (f"{str(scene.name or '').strip()} · 请补充条件" if str(scene.name or "").strip() else "")
        or _DEFAULT_FORM_TITLE
    )
    # 卡头副标题（demo `.card-head .sub`）：用户点开胶囊后**贴着字段**的那句话。
    #
    # 它和 `ask_prompt`（卡**上方**的引导语）不是同一件事，demo 里两者同时存在：
    #
    #     <p>先确认三个条件，我按人数硬约束 → 天数 ±1 → 预算偏差逐层筛方案表：</p>
    #     <div class="card-head">
    #       <h3>行程规划 · 请补充条件</h3>
    #       <div class="sub">填好这三项，我按方案表逐条比对</div>
    #     </div>
    #
    # 分工是：引导语（卡外、长）回答「为什么现在要问你」；副标题（卡内、短）
    # 回答「填完这张表会发生什么」。少了副标题，卡头只剩一个标题 + 一张表 ——
    # 这就是「只有表格显得很单调」的由来。
    #
    # 三级兜底与 `title` 同构：顶层 `form_subtitle` → `params.form_subtitle`
    # → 按场景类型给的默认句。默认句刻意不带数量词（「这几项」而不是「这三项」），
    # 因为缺槽数量随用户已填内容变化，写死数字会在第二次问时对不上。
    default_subtitle = (
        "填好这几项，我按方案表逐条比对"
        if str(getattr(scene, "scene_type", "") or "") == "table_match"
        else "填好这几项，我接着往下办"
    )
    subtitle = (
        str(ui_config.get("form_subtitle") or "").strip()
        or str(params.get("form_subtitle") or "").strip()
        or default_subtitle
    )
    form = build_slot_form(missing, labels=labels, title=title)
    if not form:
        return None

    # 用场景声明覆盖推断结果（只覆盖「场景说了」的项，没说的保留推断）。
    #
    # 三个额外的键（`unit` / `prompt` / `label_raw`）是**加法**：
    # `SlotFormCard` 不认它们也不会坏（它只读 name/label/type/required/
    # placeholder/options），而定制 module（`travel.itinerary`）需要它们才能
    # 画出「人数（人）」和按 demo 的 placeholder。
    for field in form.get("fields") or []:
        name = str(field.get("name") or "")
        spec = declared.get(name) or {}
        unit = spec.get("unit") or ""
        if unit:
            field["unit"] = unit
            # 单位拼进 label（「人数（人）」），除非槽位自己已经写了括号。
            raw_label = spec.get("label_raw") or str(field.get("label") or "")
            if raw_label and not re.search(r"[（(]", raw_label):
                field["label"] = f"{raw_label}（{unit}）"
        if spec.get("prompt"):
            field["placeholder"] = spec["prompt"]
        # 类型只在「场景显式声明且是合法控件」时覆盖。`confirm` 不覆盖成
        # 数值控件没意义，所以只认 number / text / date 三类。
        declared_type = spec.get("type") or ""
        if declared_type in {"number", "text", "date", "time", "datetime", "select"}:
            field["type"] = declared_type
    # 提交按钮文案按场景类型给动词，而不是 SOP 那套通用「提交」。
    #
    # 为什么不改 `build_slot_form`：它是 SOP 链路共用的，那里「提交」是准确的
    # （用户在办一件事）；场景这边是「描述需求 → 我去查/我去排」，动词必须说清
    # 下一步会发生什么。demo 用的是「开始匹配」，同一个意思。
    if str(getattr(scene, "scene_type", "") or "") == "table_match":
        form["submit_label"] = "开始匹配"
    # 副标题塞在 form 的 `data` 里（跟着表单走，不另开一个键）。
    #
    # 为什么不做成 `build_slot_form()` 的参数：那个函数是 SOP 链路共用的，
    # 「卡头下方的一句说明」是场景消息卡的版式需求，SOP 那边没有这张卡。
    # 加参数会让两边都要为一个只有一边用的字段签名 —— 事后塞 key 更诚实。
    #
    # `SlotFormCard`（通用表单）不认 `subtitle` 也不会坏；它在卡头渲染
    # `step_name`，两处语义不同不会打架 —— 见 `SlotFormCard` 的注释。
    form["subtitle"] = subtitle
    return SceneUiBlock(kind="form", data=form)


def _run_table_match(
    db: Session,
    *,
    scene: "Scene",
    slots: dict[str, Any] | None = None,
    message: str = "",
    session_id: str = "",
    user_id: str | None = None,
    persist: bool = False,
    action_overrides: dict[str, Any] | None = None,
) -> SceneRunResult:
    """查表推荐通道：加载 0..N 张表 → 合并行 → ``run_match`` → 结果/空态块。

    **0 张表是合法状态**（PRD §9.2「可绑定但该场景尚未配表」），不是错误：
    此时产一条 ``text``（框架替它说明配置缺失）+ 一个 ``empty`` 块，
    ``status = "no_match"``，不抛异常、不 500。

    ``action_overrides``：试跑面板的 ``use_decision_model`` 临时代替配置值。
    只在试跑链路出现（``SceneRunRequest.use_decision_model``），
    聊天链路永远传 ``None``。
    """
    from app.scenes.matcher import MatchAction, run_match

    slots = dict(slots or {})
    tables = load_scene_tables(db, scene.id)
    blocks: list[SceneUiBlock] = []
    trace: list[dict[str, Any]] = []

    if not tables:
        reason = "这个场景还没有配置数据表。"
        blocks.append(SceneUiBlock(kind="text", data={"content": reason}))
        blocks.append(
            SceneUiBlock(
                kind="empty",
                data={"reason": reason, "steps": [], "funnel": [], "suggestions": []},
            )
        )
        return SceneRunResult(
            blocks=blocks,
            text=reason,
            trace=trace,
            status="no_match",
            detail={
                "hits": [],
                "ranked": [],
                "steps": [],
                "total": 0,
                "normalized_count": 0,
                "unconvertible": 0,
                "gate_out": 0,
                "reranked": False,
                "model_used": False,
                "invalid_budget": False,
                "empty_reason": reason,
            },
        )

    action = MatchAction.from_json(scene.match_action_json)
    for key, value in (action_overrides or {}).items():
        if hasattr(action, key) and value is not None:
            setattr(action, key, value)
    # 多表合并池共用同一套列语义（导入时已做同构校验），所以主表的列对全池有效
    columns = list(tables[0]["columns"] or [])
    people_key, days_key, budget_key = _resolve_slot_columns(scene, columns)

    rows: list[dict[str, Any]] = []
    for table in tables:
        rows.extend(table["rows"])

    result = run_match(
        rows,
        slots,
        action,
        people_key=people_key,
        days_key=days_key,
        budget_key=budget_key,
        # 单位期望：显式（槽位声明的 unit）→ 缺省回落到 _EXPECTED_UNIT_BY_SLOT
        unit_by_slot=unit_by_slot_of(scene) or None,
    )
    trace = result.steps_json()

    hits = [hit_payload(r) for r in result.hits]
    ranked = [hit_payload(r) for r in result.ranked]
    empty_reason = "" if hits else empty_reason_for(result, slots)

    # ---- 输出块 ----
    form_block = _slot_form_block(scene, slots, db)

    respond = dict(scene.respond_action_json or {})
    intro = str(respond.get("intro") or "").strip()
    max_items = max(1, int(respond.get("max_items") or action.top_k or 3))

    # 缺必填槽位时**只问不查**（对齐 `docs/scenes/scene-demo.html` 的交互）。
    #
    # 为什么不能「边问边给结果」：空槽位下 matcher 的每一层都是放行的
    # （`matcher.py` 的 `slot_people is None → return True`），于是「恰好前 3 行」
    # 会被当成匹配结果发出来，前端再按 `score <= 0 → 完全吻合` 标成绿色的
    # 「完全吻合」。用户看到的是「我刚点开还没填，它就说这三个完全符合我的要求」。
    # 这比「什么都没给」更坏 —— 它在用一条错误的推荐引导用户做决定。
    #
    # 因此这里的顺序是：有缺槽 → 只发 form（+ 一句引导），直接返回。
    # `detail` 仍然照常透出（试跑面板要看得见「这次是空槽位，不是没数据」）。
    if form_block is not None:
        # 引导语 = **这条消息的正文**（`text`），不是 blocks 里的一个 text 块。
        #
        # 为什么会踩两次坑，记在这里免得第三次：
        #
        # ① 最初是 `blocks = [form, text(ask_prompt)]` —— 引导语掉到表格下面。
        #    用户的原话是「我写了引导语，反而在最下边」。
        #
        # ② 修成 `[text(ask_prompt), form]` 之后仍然不对，因为**正文是另一句**：
        #    前端气泡的渲染顺序是「正文 → blocks」，于是用户看到的是
        #
        #        请先补充条件。            ← text_out（硬编码，谁也没配过）
        #        ┌─────────────────┐
        #        │ 表单卡           │
        #        └─────────────────┘
        #        好的，我来帮你安排…       ← ask_prompt（用户配的），在最下边
        #
        #    也就是说「配的那句在最下面」和「上面多出一句没配过的」是**同一个 bug**：
        #    一句话被拆成两份发，硬编码那份占了正文位。
        #
        # 现在合成一处：`text` 就是 ask_prompt 本身，blocks 里**不再放** text 块。
        # 这是 demo 的真实结构 —— `<p>先确认三个条件…</p>` 本来就是气泡正文，
        # `<div class="card">` 才是块。两处都发 = 同一句话说两遍。
        #
        # 顺带的好处：非 UI 渠道（企微/微信/短信）只吃 `text`，原先它们拿到的
        # 是「请先补充条件。」这句空话，真正的引导语在 blocks 里被丢掉。
        ask_prompt = str(respond.get("ask_prompt") or "").strip()
        if not ask_prompt:
            # 默认句按场景类型给，且**与卡头副标题不重复**：
            # 这里说「按什么规则筛」（策略），副标题说「填完会发生什么」（动作）。
            ask_prompt = (
                "先确认这几个条件，我按方案表逐层筛："
                if str(getattr(scene, "scene_type", "") or "") == "table_match"
                else "先确认这几个条件："
            )
        blocks.append(form_block)
        text_out = ask_prompt
        missing_reason = "awaiting_input"
        return SceneRunResult(
            blocks=blocks,
            text=text_out,
            trace=trace,
            # `no_match` 而不是新增状态：`awaiting_input` 不是「失败」也不是
            # 「成功出结果」，`SceneRunResult` 的注释明确说「还在等用户由
            # block 的 kind 表达，不需要第四个状态位」。用 no_match 保证既有
            # 读 `status` 的地方（会话收尾、统计）行为不变。
            status="no_match",
            detail={
                "hits": [],
                "ranked": [],
                "steps": trace,
                "total": 0,
                "normalized_count": result.normalized_count,
                "unconvertible": result.unconvertible,
                "gate_out": result.gate_out,
                "reranked": False,
                "model_used": False,
                "invalid_budget": False,
                "empty_reason": missing_reason,
                "awaiting_input": True,
            },
        )

    text_out = ""
    if hits:
        if intro:
            blocks.append(SceneUiBlock(kind="text", data={"content": intro}))
        items = hits[:max_items]
        blocks.append(
            SceneUiBlock(
                kind="result",
                data={"total": result.total, "items": items, "max_items": max_items},
            )
        )
        template = str(respond.get("template") or "").strip()
        if template:
            text_out = _render_template(template, hits[0]["values"])
        else:
            titles = [str(i["values"].get("计划内容") or "") for i in items[:3]]
            text_out = "为你找到以下方案：" + "、".join(t for t in titles if t)

        # 有命中但存在需要向用户交代的前提，正文里必须补一句，不能装没事：
        #   ① 预算填了 0/负数 → 本次**没按预算筛**，只按天数排的；
        #   ② 人数是靠容差放宽才进来的 → 不是精确匹配，用户有权知道。
        # 这两句加在正文尾部而不是塞进卡片：非 UI 渠道（企微/短信）只吃 text。
        caveats: list[str] = []
        if result.invalid_budget:
            caveats.append("你填的预算不是正数，本次没有按预算筛选，只按天数排序。")
        if result.people_widened:
            caveats.append(
                f"其中 {result.people_widened} 个方案的人数和你要的不完全一致，"
                f"是按人数容差放宽后命中的。"
            )
        if caveats:
            text_out = f"{text_out}{'' if text_out.endswith('。') else '。'}" + "".join(caveats)
    else:
        # 空结果只发**一个** `empty` 块，`empty_reason` 只出现在卡片的
        # `data.reason` 里（它紧挨着下面的 `steps` 漏斗，两者相互解释）。
        #
        # 这里原先是三处都在发：
        #   ① `blocks.append(text 块, content=empty_reason)`
        #   ② 空卡 `data.reason = empty_reason`
        #   ③ `text_out = empty_reason`
        # 前端渲染顺序是「正文 → blocks」，所以用户看到同一句话接连出现两遍。
        # 这与引导语那次是同一个病（一句话拆成两份发），处置方式也一致：
        # **正文与块各说一次，不许重复**。① 直接删掉，② 保留，③ 换成
        # `empty_summary_for` 给的短句。
        #
        # 为什么正文不干脆留空：`result.text` 就是 `reply_fragment`
        # （`core/engine/turn_frames.py: reply = result.text`），而企微 / 微信 /
        # 短信只吃 text、收不到 blocks。留空或写成「看卡片」会让这些渠道
        # 彻底丢失「为什么没匹配上」这个信息。
        # 空卡上的漏斗只留「有信息量」的那几层。
        #
        # 传完整 `trace` 的话，卡上会出现截图里那三行连着的 `0 →`：
        #     0 → 天数对上
        #     0 → 预算接近
        #     0 → 最终给出
        # 它们是**必然的 0**（上一层已经归零，后面不可能再进新行），
        # 用户读起来像被连拒三次，还占掉卡片一半高度。
        #
        # ⚠️ 只裁**空卡**用的这一份。`detail.steps` / `trace` / 试跑面板
        # 仍然拿完整的 5 步 —— 管理员需要看到「流程跑完了、没崩」，
        # 排障也需要每一层的真实数字。两处用不同的数据是**有意的**。
        visible_trace = _visible_funnel(trace)
        empty_data: dict[str, Any] = {
            "reason": empty_reason,
            # 漏斗**默认不下发给用户卡**（2026-11-26 用户要求）。
            #
            # 原先 `steps` / `funnel` 都发，卡上就出现三行：
            #     5 → 读表
            #     5 → 人数对上
            #     0 → 天数对上
            # 用户的原话是「这些文字没必要给用户看」。判断成立：
            #   · `reason` 已经说了卡在哪层 + 下一步怎么做，漏斗是它的
            #     **另一种写法**，不是新信息；
            #   · 「5 → 读表」里的 5 是表的行数，用户根本不关心台账有几行；
            #   · 「人数对上 / 天数对上」是筛选器内部的分层命名，用户
            #     没见过这套词。
            #
            # 但**完整 trace 仍然在 `detail.steps` 与 `result.trace` 里**，
            # 试跑面板（`SceneEditor` 的 RunPanel 读 `result.steps`）照旧
            # 拿到 5 步 —— 排障要看每层的真实数字。两处用不同数据是有意的：
            # **管理员要漏斗，用户要一句话。**
            #
            # 想恢复展示时，在场景 `ui_config.params` 里设
            # `show_empty_funnel: true`（走下面的条件，不用改代码）。
        }

        if _show_empty_funnel(scene, db):
            # 保留这条通路：多层级筛选的诊断场景（比如管理员自己配的
            # 内部工具）确实需要看到每层淘汰了多少。
            empty_data["steps"] = visible_trace
            empty_data["funnel"] = [
                {"label": s["label"], "from": s["from"], "to": s["to"]}
                for s in visible_trace
            ]

        # `on_empty` 三态在这里真正分叉（matcher 只负责 `nearest` 有没有产项）：
        #
        #   nearest → 近似项 + 两个放宽建议（让用户能继续）
        #   clarify → 不给近似项，只留放宽建议 —— 这一档的意图是「反问」，
        #             所以正文要**明确问一句**，而不是陈述「没找到」
        #   none    → 既不给近似项也不给建议按钮，正文只说明结果
        #
        # 三档都必须写进 `data.on_empty`，前端据此决定
        # 空卡下半部分（建议区）渲不渲染 —— 否则「只说明没有结果」
        # 会渲染出两颗「放宽条件」的按钮，配置等于没生效。
        on_empty_mode = str(getattr(action, "on_empty", "nearest") or "nearest")
        empty_data["on_empty"] = on_empty_mode
        if on_empty_mode != "none":
            empty_data["suggestions"] = _empty_suggestions(result, slots, on_empty_mode)

        # 当前这一轮生效的**完整槽位**，随空卡一起下发。
        #
        # 为什么前端需要它：建议按钮只改一个槽（`days: 6`），但下一轮必须
        # 带着人数和预算一起重算 —— 只发 `{days: 6}` 的话，新帧的
        # `slots_json` 是空的（`frames.py` 里 `base_slots` 从 session 取，
        # 而场景轮不走 session 槽位），等于把另外两个条件抹掉了。
        #
        # 放在 `empty` 块而不是消息 metadata：这个数据只对这一块有意义，
        # metadata 是整条消息共享的，且会被分享页读到。
        #
        # 只下发**有值的**槽位（空串/None 会让 matcher 当成 0 处理）。
        empty_data["slots"] = {
            str(k): v
            for k, v in (slots or {}).items()
            if v is not None and str(v).strip() != ""
        }
        # 槽位 key → 中文名。前端拿它拼「人数：4」而不是「people：4」。
        #
        # 为什么必须下发：建议按钮走 `submitSlots` 会往会话里落一条**用户消息**，
        # 那条消息的文本由 `slotSubmissionText()` 按字段 label 拼。没有 label
        # 时它会退回字段名，用户在气泡里看到 `people：4；days：6` —— 一个
        # 纯英文键名，与界面其他地方的中文完全不一致。
        empty_data["slot_labels"] = {
            str(slot.get("key")): str(slot.get("label") or slot.get("target") or slot.get("key"))
            for slot in (scene.slots_json or [])
            if str(slot.get("key") or "").strip()
        }

        # `on_empty="nearest"`：给差距最小的一批供参考。
        # 单独放在 `nearest` 字段而不是混进 `items`：前端据此渲染成
        # 「都不是符合条件的，只是最接近的」，不会误当成命中。
        nearest_items = [hit_payload(r) for r in getattr(result, "nearest", [])]
        if nearest_items:
            empty_data["nearest"] = nearest_items

        blocks.append(SceneUiBlock(kind="empty", data=empty_data))

        text_out = empty_summary_for(result, slots)
        if on_empty_mode == "clarify":
            # 反问句要**贴着卡在哪一层**问，否则就是「换个条件再试试」这种
            # 用户已经抱怨过的空话（他刚说过「我选了这个，但仍让我换个条件」）。
            text_out = f"{text_out}{_clarify_hint_for(result, slots)}"
        elif nearest_items:
            text_out = f"{text_out}下面这几个最接近，但不是完全符合条件。"

    # 既有试跑面板与 11 个后端用例读的是 SceneRunRead 的老字段（hits/ranked/
    # steps/...）。这些字段从 blocks 反推不出来（days_dev/budget_dev 只在
    # MatchRow 上有），所以随结果一并透出，不在 API 层重跑 matcher。
    detail: dict[str, Any] = {
        "hits": hits,
        "ranked": ranked,
        "steps": trace,
        "total": result.total,
        "normalized_count": result.normalized_count,
        "unconvertible": result.unconvertible,
        "gate_out": result.gate_out,
        "reranked": bool(result.reranked),
        "model_used": bool(result.model_used),
        "invalid_budget": bool(result.invalid_budget),
        "empty_reason": empty_reason,
        # 人数容差放宽命中的行数（0 = 严格模式，与历史行为一致）
        "people_widened": int(getattr(result, "people_widened", 0) or 0),
        # on_empty="nearest" 时的近似结果，**不是命中**，别混进 hits
        "nearest": [hit_payload(r) for r in getattr(result, "nearest", [])],
        "people_key": people_key,
        "days_key": days_key,
        "budget_key": budget_key,
    }
    return SceneRunResult(
        blocks=blocks,
        text=text_out,
        trace=trace,
        status="ok" if hits else "no_match",
        detail=detail,
    )


# ============================================================
# 通道 2：sop_flow
# ============================================================


def _run_sop_flow(
    db: Session,
    *,
    scene: "Scene",
    slots: dict[str, Any] | None = None,
    message: str = "",
    session_id: str = "",
    user_id: str | None = None,
    persist: bool = False,
    action_overrides: dict[str, Any] | None = None,
) -> SceneRunResult:
    """流程办理通道：把 ``flow_json`` 的步骤摊成 ``step`` 块。

    P0 只做最小链路（PRD §14.3 C 段把 sop_flow 端到端排到 P1）：
    渲染「当前走到哪一步 + 缺哪些字段」，不驱动真实 SOP 引擎的节点跳转。
    ``data`` 形状按 arch §2.2 的 **P0 宽松** 口径给，过早冻结会锁死 P1 设计。
    """
    flow = dict(scene.flow_json or {})
    steps = [s for s in (flow.get("steps") or []) if isinstance(s, dict)]
    slots = dict(slots or {})
    if not steps:
        reason = "这个场景还没有配置流程步骤。"
        return SceneRunResult(
            blocks=[SceneUiBlock(kind="text", data={"content": reason})],
            text=reason,
            trace=[{"key": "flow", "detail": "flow_json.steps 为空"}],
            status="no_match",
        )

    total = len(steps)
    blocks: list[SceneUiBlock] = []
    current_index = 0
    for index, step in enumerate(steps):
        name = str(step.get("name") or step.get("title") or f"第 {index + 1} 步")
        required = [str(f) for f in (step.get("required_slots") or []) if str(f).strip()]
        missing = [field for field in required if slots.get(field) in (None, "", [], {})]
        status = "pending"
        if missing:
            status = "awaiting_input"
            current_index = index
        elif index == 0:
            status = "done"
        blocks.append(
            SceneUiBlock(
                kind="step",
                data={
                    "step_name": name,
                    "step_index": index,
                    "step_total": total,
                    "status": status,
                    "missing": missing,
                },
            )
        )
        if missing:
            break

    head = str(flow.get("intro") or "").strip() or "办理进度如下："
    blocks.insert(0, SceneUiBlock(kind="text", data={"content": head}))
    trace = [
        {
            "key": "sop_flow",
            "current_step": current_index,
            "step_total": total,
            "status": "no_match" if current_index else "ok",
        }
    ]
    return SceneRunResult(
        blocks=blocks,
        text=head,
        trace=trace,
        status="ok",
    )


# ============================================================
# 通道 3：handoff
# ============================================================


def _run_handoff(
    db: Session,
    *,
    scene: "Scene",
    slots: dict[str, Any] | None = None,
    message: str = "",
    session_id: str = "",
    user_id: str | None = None,
    persist: bool = False,
    action_overrides: dict[str, Any] | None = None,
) -> SceneRunResult:
    """转人工通道：产 ``handoff`` 块，并在有会话上下文时真的建单。

    ``data`` 形状按 arch §2.2 **P0 宽松**：``ticket_id`` / ``context`` 的形状
    取决于工单接口，P1 定了再冻。

    建单只在 ``persist=True`` 且 ``session_id`` 非空时发生——试跑面板
    （无会话）不该在库里留下一条真实工单。
    """
    from app.db.models import HumanHandoffRequest, utc_now

    config = dict(scene.handoff_json or {})
    slots = dict(slots or {})
    target = str(config.get("target") or "人工同事").strip()
    summary = str(config.get("summary") or "").strip() or "用户请求人工协助。"
    ticket_id = ""

    if persist and session_id:
        ticket = HumanHandoffRequest(
            tenant_id=scene.tenant_id,
            session_id=session_id,
            agent_id=str(config.get("agent_id") or "") or None,
            requester_user_id=user_id,
            trigger_skill_id=None,
            context_summary=summary,
            pending_question=str(message or "").strip() or None,
            status="pending",
            metadata_json={
                "source": "scene_module",
                "scene_id": scene.id,
                "scene_name": scene.name,
                "slots": slots,
            },
            created_at=utc_now(),
            updated_at=utc_now(),
        )
        db.add(ticket)
        db.commit()
        db.refresh(ticket)
        ticket_id = ticket.id

    content = f"已为你转接{target}，稍后会有同事在这里回复你。"
    blocks = [
        SceneUiBlock(kind="text", data={"content": content}),
        SceneUiBlock(
            kind="handoff",
            data={
                "target": target,
                "summary": summary,
                "ticket_id": ticket_id,
                "context": {"scene_id": scene.id, "slots": slots},
            },
        ),
    ]
    trace = [{"key": "handoff", "target": target, "ticket_id": ticket_id}]
    return SceneRunResult(blocks=blocks, text=content, trace=trace, status="ok")


# ============================================================
# 通道 4：script
# ============================================================


def _run_script(
    db: Session,
    *,
    scene: "Scene",
    slots: dict[str, Any] | None = None,
    message: str = "",
    session_id: str = "",
    user_id: str | None = None,
    persist: bool = False,
    action_overrides: dict[str, Any] | None = None,
) -> SceneRunResult:
    """固定话术通道：按关键词直出一条话术（复用 ``app/faq`` 的词法口径）。

    口径与 FAQ 一致（任意 1 个关键词命中即算命中）：要求 ≥2 个同时命中会让
    用户只说一个核心词时永远不命中，误命中风险由运营维护词表来兜。

    没有关键词命中时不装作命中，返回 ``no_match`` + 全部话术的目录提示，
    让用户知道这个场景存在哪些答案（比一句「没找到」有用）。
    """
    from app.faq.service import normalize_text

    scripts = [s for s in (scene.scripts_json or []) if isinstance(s, dict)]
    query = normalize_text(message)
    if not scripts:
        reason = "这个场景还没有配置话术。"
        return SceneRunResult(
            blocks=[SceneUiBlock(kind="text", data={"content": reason})],
            text=reason,
            trace=[{"key": "script", "detail": "scripts_json 为空"}],
            status="no_match",
        )

    best: dict[str, Any] | None = None
    best_hits: list[str] = []
    for item in scripts:
        keywords = [str(k).strip() for k in (item.get("keywords") or []) if str(k).strip()]
        hits = [k for k in keywords if normalize_text(k) and normalize_text(k) in query]
        if hits and (best is None or len(hits) > len(best_hits)):
            best = item
            best_hits = hits

    if best is None:
        catalogue = "、".join(
            str(item.get("title") or item.get("name") or "").strip()
            for item in scripts
            if str(item.get("title") or item.get("name") or "").strip()
        )
        reason = f"没有匹配到你问的内容。这个场景可以回答：{catalogue}" if catalogue else "没有匹配到你问的内容。"
        return SceneRunResult(
            blocks=[SceneUiBlock(kind="text", data={"content": reason})],
            text=reason,
            trace=[{"key": "script", "hit_keywords": [], "script_count": len(scripts)}],
            status="no_match",
        )

    reply = str(best.get("reply") or best.get("answer") or "").strip()
    content = _render_template(reply, dict(slots or {})) if reply else ""
    if not content:
        content = "这条话术还没有配置回复内容。"
    chips = [
        {"label": str(c.get("label") or ""), "send_text": str(c.get("send_text") or "")}
        for c in (best.get("chips") or [])
        if isinstance(c, dict) and str(c.get("label") or "").strip()
    ]
    data: dict[str, Any] = {"content": content}
    if chips:
        data["chips"] = chips
    return SceneRunResult(
        blocks=[SceneUiBlock(kind="text", data=data)],
        text=content,
        trace=[{"key": "script", "hit_keywords": best_hits, "script_count": len(scripts)}],
        status="ok",
    )


# ============================================================
# 通道 5：tool_submit
# ============================================================


#: 调用工具时能用的默认超时。工具的 `execution_policy` 优先，这里只是兜底。
#: 与 `settings.tool_timeout_seconds` 的默认值同量级 —— 场景是**同步**链路
#: （用户等着看提交结果），不能像异步任务那样给几十秒。
_TOOL_SUBMIT_TIMEOUT = 8.0


def _submission_params(
    config: dict[str, Any],
    slots: dict[str, Any],
) -> dict[str, Any]:
    """把槽位值映射成工具参数。

    两种映射方式，**显式优先**：

    1. `config.param_map`：`{工具参数名: 槽位 key}`，适合「表单字段叫 `guest_name`
       而接口要 `guestName`」这类改名；
    2. 缺省直传：槽位 key 与接口参数同名时不用配任何东西（最常见）。

    `param_map` 里指向不存在的槽位**不填 None**：少传一个 key 会让接口按
    「未提供」处理，传 None 可能被拼成字符串 `"None"` 落进对方的库。
    """
    raw_map = config.get("param_map")
    if not isinstance(raw_map, dict) or not raw_map:
        return {str(k): v for k, v in slots.items() if v not in (None, "", [], {})}

    params: dict[str, Any] = {}
    for target, source in raw_map.items():
        target_key = str(target or "").strip()
        source_key = str(source or "").strip()
        if not target_key or not source_key:
            continue
        value = slots.get(source_key)
        if value in (None, "", [], {}):
            continue
        params[target_key] = value
    return params


def _tool_reply_text(
    config: dict[str, Any],
    *,
    payload: Any,
    slots: dict[str, Any],
) -> str:
    """把工具返回值拼成一句给用户的话。

    `config.reply_template` 用 `{{某字段}}` 占位（复用 `_render_template`，
    与 script 通道同一套口径）。占位符**既能取返回值里的字段，也能取槽位值** ——
    真实场景里这句话常常两边都要（「已为 {{room_no}} 房送出 {{item}}，
    预计 {{eta_minutes}} 分钟送达」）。

    模板里没写到的坑：返回值可能是 `{"data": {...}}` 这类包了一层的形状。
    这里先展开一层 `data`，再合并槽位，**槽位优先**（用户自己填的东西比接口
    回显的更可信）。展开只做一层：多层嵌套要让管理员自己写 `a.b`，
    那是另一个特性，不做「猜路径」。
    """
    values: dict[str, Any] = {}
    if isinstance(payload, dict):
        inner = payload.get("data")
        if isinstance(inner, dict):
            values.update(inner)
        values.update(payload)
    values.update({str(k): v for k, v in (slots or {}).items()})

    template = str(config.get("reply_template") or "").strip()
    if template:
        text = _render_template(template, values)
        if text:
            return text

    # 没配模板：用返回值里最常见的几个「人话字段」拼一句。
    #
    # 为什么要有这个兜底：管理员常常先建场景看效果，模板留空。此时返回一句
    # 「提交成功」也比抛异常或空白好 —— 空卡的教训是**错误路径上再崩一次
    # 是最糟的体验**。
    for key in ("message", "msg", "summary", "result_text"):
        candidate = str(values.get(key) or "").strip()
        if candidate:
            return candidate
    return "已提交，请稍候。"


def _run_tool_submit(
    db: Session,
    *,
    scene: "Scene",
    slots: dict[str, Any] | None = None,
    message: str = "",
    session_id: str = "",
    user_id: str | None = None,
    persist: bool = False,
    action_overrides: dict[str, Any] | None = None,
    agent_id: str | None = None,
) -> SceneRunResult:
    """表单提交通道：收槽位 → 调一个已配置的工具 → 把返回值回复给用户。

    这是四步通用模板的第 3、4 步落地（1 意图触发、2 发表单由框架与 `form`
    块负责）：**场景本身不含任何业务逻辑，业务全部在被调用的工具里**。
    换一个业务只换 `tool_api_json`，不写代码。

    ## 三种状态，与 `table_match` 同构

    - **缺必填槽位** → 只发 `form` 块，不问不调。绝不能「边问边提交」：
      槽位不全时调出去的就是一条脏单（`room_no` 为空也照样送到客房部），
      而用户此刻还没确认。
    - **调用成功** → `result` 块（结构化返回值，前端画成回执）+ `text`。
    - **调用失败** → `empty` 块 + `text`，**必须说清下一步**。失败不能只报
      「调用失败」：用户不知道是该重试、该找人、还是自己填错了。

    ## 为什么 `persist` 不参与判断

    `table_match` 的 `persist` 只影响落库；这里的工具调用**有副作用**
    （真的下单/送物），但试跑面板也应该真的调用 —— 否则「试跑通过、线上失败」
    这类问题永远发现不了。所以 `persist` 在这里不解耦调用，只由调用方在
    试跑时自己决定用哪个场景（`/run` 路由本来就不落 `SceneRun`）。
    """
    from app.tools.tool_executor import ToolExecutor
    from app.tools.tool_schema import ToolCall

    slots = dict(slots or {})
    config = dict(scene.tool_api_json or {})
    tool_name = str(config.get("tool_name") or "").strip()

    # ① 配置缺失 → 可行动的原因，不是「暂无数据」
    if not tool_name:
        reason = "这个场景还没有配置要调用的接口。"
        return SceneRunResult(
            blocks=[SceneUiBlock(kind="text", data={"content": reason})],
            text=reason,
            trace=[{"key": "tool_submit", "detail": "tool_api_json.tool_name 为空"}],
            status="no_match",
        )

    # ② 缺必填槽位 → 只发表单。顺序在调用之前，这是硬要求（见 docstring）。
    form_block = _slot_form_block(scene, slots, db)
    if form_block is not None:
        respond = dict(scene.respond_action_json or {})
        ask_prompt = str(respond.get("ask_prompt") or "").strip() or (
            "填写下面的信息，我马上帮你提交："
        )
        return SceneRunResult(
            blocks=[form_block],
            text=ask_prompt,
            trace=[{"key": "tool_submit", "detail": "缺必填槽位，先发表单"}],
            status="ok",
        )

    # ③ 调工具
    params = _submission_params(config, slots)
    timeout = config.get("timeout_seconds")
    try:
        executor = ToolExecutor(db)
        tool_result = executor.execute(
            scene.tenant_id,
            ToolCall(name=tool_name, arguments=params),
            # **必须传 `agent_id`**，这是本通道唯一的越权拦截点。
            #
            # 上一版这里故意不传，理由是「场景本身已经过了员工绑定校验」——
            # 那个理由不成立：`resolve_scene_hit` 校验的是**场景**绑没绑在这个
            # 员工身上，而不是场景要调的**工具**绑没绑。两者完全独立：员工可以
            # 只绑场景、一个工具都不绑，此时场景能正常命中、表单能正常发出，
            # 点提交却把请求发到了他没权限的接口上。这就是那个权限漏洞。
            #
            # 传进去之后 `ToolExecutor.execute` 会拿 `visible_tool_rows` 比对：
            # 未绑 / 已停用 → `NOT_ALLOWED`，走下面的失败分支给用户一句话。
            #
            # 试跑面板仍然传 `None`（它没有员工语境，是管理员在验配置），
            # 所以「刚建好还没绑员工」的场景照样能试跑 —— 见
            # `run_scene_instance` 的 docstring。
            agent_id=agent_id or None,
            timeout_seconds_override=(
                float(timeout) if isinstance(timeout, (int, float)) and timeout > 0 else _TOOL_SUBMIT_TIMEOUT
            ),
        )
    except Exception as exc:  # noqa: BLE001 - 工具层异常不该让整轮消息失败
        # `ToolExecutor.execute` 内部已经把 httpx 异常转成 `ToolResult`，
        # 走到这里的只可能是「连 ToolExecutor 都没构造起来」这类真 bug。
        # 显式写日志而不是静默返回 —— 否则线上只有一句「提交失败」无从排查。
        #
        # 与下面的 ``tool_result.success == False`` 分支同构：只发空卡，
        # 正文给短句（非 UI 渠道靠正文，见 ``empty_summary_for`` 的说明）。
        return SceneRunResult(
            blocks=[
                SceneUiBlock(
                    kind="empty",
                    data={
                        # 同上：不给 ``title`` 会沿用「没有找到符合条件的结果」。
                        "title": "提交没有成功",
                        "reason": (
                            "这不是填写内容的问题。稍后再试一次，持续失败请联系工作人员。"
                        ),
                        "suggestions": [],
                        "on_empty": "none",
                    },
                )
            ],
            text="提交时出了点问题，请稍后再试或联系工作人员。",
            trace=[
                {
                    "key": "tool_submit",
                    "tool_name": tool_name,
                    "error": "executor_raised",
                    "detail": str(exc)[:500],
                }
            ],
            status="error",
            # 场景是好的、表也填对了，只是工具层炸了。这句话必须原样送达，
            # 不能降级给模型自由发挥（详见 ``SceneRunResult.degradable``）。
            degradable=False,
        )

    if not tool_result.success:
        error = tool_result.error
        code = str(getattr(error, "code", "") or "")
        detail = str(getattr(error, "message", "") or "")
        # 失败文案分三类，因为**用户的下一步动作不同**：
        # - 超时 / 网络 / 5xx：可以重试 → 告诉他重试；
        # - 参数错 / 业务拒绝：重试没用 → 让他检查信息或找人；
        # - 无权限（`NOT_ALLOWED`）：**重试和改填写内容都没用**，要管理员去
        #   员工档案把这个工具勾上。归到第三类之前它一直落在 else 分支，
        #   于是用户看到「请检查填写内容后重试」，反复改房间号也永远提交不成功。
        #
        # ## 为什么每类拆成「卡片标题 + 卡片 reason + 正文」
        #
        # 与 ``table_match`` 的空结果同源（见 ``empty_summary_for`` 的注释）：
        # 前端渲染顺序是「正文 → blocks」，同一句话两处都发就会接连出现两遍。
        # 但正文又不能留空 —— ``result.text`` 就是 ``reply_fragment``，企微 /
        # 微信 / 短信只吃 text、收不到 blocks，留空等于这些渠道彻底丢失原因。
        #
        # ## 为什么必须显式给 ``title``
        #
        # ``SceneEmptyCard`` 的兜底标题是「没有找到符合条件的结果」—— 那是给
        # ``table_match``（筛不出行）写的。提交失败时沿用它会变成一张写着
        # 「没有找到符合条件的结果」的卡，下面却是「提交超时了」：标题在说搜索，
        # 正文在说提交，用户读不懂到底发生了什么。标题必须由知道语义的一方给。
        #
        # reason 里**不再重复标题那句话**，只说「为什么 + 下一步怎么办」。
        if code in {"TIMEOUT", "EXECUTION_ERROR"}:
            title = "提交没有成功"
            content = "可能是接口一时没响应。再点一次提交试试，反复失败请联系工作人员。"
            summary = "提交超时了，请再试一次。"
        elif code in {"HTTP_ERROR"}:
            title = "接口暂时不可用"
            content = "这不是填写内容的问题。稍后再试一次，或者联系工作人员处理。"
            summary = "接口暂时不可用，请稍后再试或联系工作人员。"
        elif code == "NOT_ALLOWED":
            title = "还没有提交权限"
            content = (
                "请联系管理员，在员工档案里勾选这个场景要用的工具，"
                "开通后就能提交了。"
            )
            summary = "这个助手还没有开通提交权限，请联系管理员在员工档案里勾选对应工具。"
        else:
            title = "提交没有成功"
            content = "请检查填写内容后重试，还是不行就联系工作人员。"
            summary = "这条信息没能提交成功，请检查填写内容后重试。"
        return SceneRunResult(
            blocks=[
                # **只发空卡，不发 text 块**。以前这里是 `[text, empty]` 两块，
                # 因为整段结果被 `_run_scene_frame` 丢弃了，重复没人看得见。
                # 现在它原样送达（`degradable=False`），text 块的 `content` 会和
                # 正文、卡片的 `reason` 三处同文 —— 一句话说三遍。
                #
                # 空卡的 `reason` 已经承担了这句话（黄色卡片、贴在操作区旁边）。
                SceneUiBlock(
                    kind="empty",
                    data={
                        # 覆盖 `SceneEmptyCard` 的「没有找到符合条件的结果」。
                        "title": title,
                        "reason": content,
                        # 失败态不给「放宽条件」那类建议：这里的失败与
                        # table_match 的「筛选太窄」完全不同，是外部接口问题。
                        "suggestions": [],
                        "on_empty": "none",
                    },
                ),
            ],
            text=summary,
            trace=[
                {
                    "key": "tool_submit",
                    "tool_name": tool_name,
                    "error": code,
                    "detail": detail[:500],
                }
            ],
            status="error",
            # 同上：超时 / 无权限 / 接口 5xx，用户拿到的是这句话术的场景化版本。
            # 降级会让模型编一个「已记录」的假回执 —— 用户就不重试了。
            degradable=False,
        )

    # ④ 成功 → 结构化回执 + 一句人话
    content = _tool_reply_text(config, payload=tool_result.data, slots=slots)
    blocks = [
        SceneUiBlock(
            kind="result",
            data={
                # `result` 块的 `items` 是列表口径（table_match 的命中行）。
                # 这里只有一条「提交回执」，用单元素列表保持形状一致 ——
                # 让前端 module 可以用同一套 `resultHits()` 读。
                "total": 1,
                "items": [
                    {
                        "row_id": str(config.get("receipt_id_key") or "receipt"),
                        "values": _receipt_values(tool_result.data, params),
                        "source_table": "",
                    }
                ],
                # 字段中文名。放在**块级**而不是塞进 `values`，因为 `values`
                # 是「字段 → 值」的业务数据，混进显示名会让前端无法区分
                # 「这个 key 是字段」还是「这个 key 是别人的名字」。
                "labels": _receipt_labels(scene),
                "max_items": 1,
            },
        )
    ]
    return SceneRunResult(
        blocks=blocks,
        text=content,
        trace=[
            {
                "key": "tool_submit",
                "tool_name": tool_name,
                "params": params,
                "success": True,
            }
        ],
        status="ok",
    )


#: 回执里**不该出现**的键：接口协议层的自检字段，不是给用户看的信息。
#:
#: 这些字段回答了「这次调用成功了吗」—— 那是程序的问题，而回执能画出来本身
#: 就说明成功了。把它们画进卡片的结果是用户看到 `accepted 是`、
#: `status accepted`、`created_at 2026-11-26T07:29:09` 三行噪音，
#: 真正有用的「单号」「预计送达」被挤到后面。
_RECEIPT_SKIP_KEYS = frozenset(
    {
        "success",
        "ok",
        "accepted",
        "status",
        "code",
        "error",
        "error_code",
        "message",
        "msg",
        "created_at",
        "created_time",
        "updated_at",
        "timestamp",
        "request_id",
        "trace_id",
    }
)


def _receipt_values(payload: Any, params: dict[str, Any]) -> dict[str, Any]:
    """把返回值摊成「字段 → 值」的扁平字典，供前端画回执。

    ## 两条取舍，都是为了「这不是一坨 JSON」

    1. **只收标量**：嵌套的 dict / list 塞进回执卡只会显示成 `[object Object]`，
       不如不显示 —— 要展示明细应该由业务接口给一个已格式化的字符串字段。
    2. **剔掉协议字段**（`_RECEIPT_SKIP_KEYS`）：`accepted` / `status` /
       `created_at` 是接口自检用的，画进卡片只是噪音。尤其 `message` ——
       它已经被 `reply_template` 说成了正文（`text`），卡片里再来一遍就是
       同一句话说两次。

    请求参数一并带上（`总计 3 件` 这类回执里，用户填的东西就是最好的证明），
    用 `setdefault`：走到这里说明接口已经受理了，它回显的才是它真正记下的。
    """
    values: dict[str, Any] = {}
    if isinstance(payload, dict):
        source = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        for key, value in source.items():
            name = str(key)
            if name in _RECEIPT_SKIP_KEYS:
                continue
            if isinstance(value, (str, int, float, bool)) and value != "":
                values[name] = value
    for key, value in (params or {}).items():
        name = str(key)
        if name in _RECEIPT_SKIP_KEYS:
            continue
        if isinstance(value, (str, int, float, bool)) and value != "":
            values.setdefault(name, value)
    return values


def _receipt_labels(scene: "Scene") -> dict[str, str]:
    """``{字段 key: 中文名}`` —— 回执卡的字段显示名。

    ## 三级来源，从「管理员已经填过」到「手写」

    1. **场景槽位的 `label`**（主力）：`room_no → 房间号` 这种映射管理员在
       定义器里已经填过了。槽位的 `label` 与接口 key 对得上，是因为
       `param_map` 缺省时槽位 key 就是参数名 —— 最常见的配置方式。
    2. **`tool_api_json.field_labels`**（补位）：只出现在**响应**里、场景没有
       对应槽位的字段（`eta_minutes → 预计送达(分钟)`）。这类字段没有别的
       事实来源，只能让管理员手写一份。
    3. 都没有 → 不给 label，前端退回显示原始 key。

    第 3 级是刻意的：显示 `eta_minutes` 不好看，但能看出是哪个字段；编一个错的
    中文名（比如把「数量」标成「件数」）会让用户以为那是别的东西。

    合并顺序是「后覆盖前」：手写的 `field_labels` 优先于槽位 label —— 手写是
    为了改写某个字段的显示名，如果被槽位覆盖就永远改不动。
    """
    labels: dict[str, str] = {}
    for slot in scene.slots_json or []:
        if not isinstance(slot, dict):
            continue
        key = str(slot.get("key") or "").strip()
        label = str(slot.get("label") or "").strip()
        if key and label and label != key:
            labels[key] = label

    config = scene.tool_api_json if isinstance(scene.tool_api_json, dict) else {}
    manual = config.get("field_labels")
    if isinstance(manual, dict):
        for key, label in manual.items():
            name = str(key).strip()
            text = str(label or "").strip()
            if name and text:
                labels[name] = text
    return labels


#: 通道名 → 实现。
#:
#: ⚠️ **这不是分派注册表**——``dispatch_scene`` 用 ``match`` 语句显式写每个
#: ``case``（arch §2.5：已知常量分支时 ``match`` 能让类型检查器做穷尽性
#: 提醒，dict 查表会把「少注册一个」变成运行期 ``KeyError``）。
#: 这个映射只服务于「按名取实现」的测试与诊断，**新增类型时不要只加这里**。
CHANNEL_RUNNERS = {
    "table_match": _run_table_match,
    "sop_flow": _run_sop_flow,
    "handoff": _run_handoff,
    "script": _run_script,
    "tool_submit": _run_tool_submit,
}


def _json_default(value: Any) -> str:
    """``json.dumps`` 的兜底序列化（trace 里偶尔会出现非基本类型）。"""
    return str(value)


def trace_signature(trace: list[dict[str, Any]] | None) -> str:
    """trace 的稳定指纹（排障时对比两次执行是否走了同一条路径）。"""
    return hashlib.sha1(
        json.dumps(trace or [], ensure_ascii=False, sort_keys=True, default=_json_default).encode(
            "utf-8"
        )
    ).hexdigest()


__all__ = [
    "CHANNEL_RUNNERS",
    "ROW_ID_KEY",
    "SOURCE_TABLE_ID_KEY",
    "SOURCE_TABLE_NAME_KEY",
    "_resolve_slot_columns",
    "_run_handoff",
    "_run_script",
    "_run_sop_flow",
    "_run_table_match",
    "columns_diff",
    "columns_signature",
    "empty_reason_for",
    "empty_summary_for",
    "hit_payload",
    "load_scene_tables",
    "normalize_column",
    "unit_by_slot_of",
]