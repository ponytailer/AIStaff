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
from typing import TYPE_CHECKING, Any

from sqlmodel import Session, select

from app.db.models import SceneTable, SceneTableRow
from app.scene_modules.types import SceneRunResult, SceneUiBlock

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


def empty_reason_for(result: Any, slots: dict[str, Any]) -> str:
    """空结果必须量化说明差在哪，不能只说「没找到」。

    用户刚填完表单，一句「没有符合条件的方案，换个条件试试」
    等于把问题丢回给他。要告诉他到底卡在哪一层。

    **这段文案逐字照抄自 ``api/scenes.py:_empty_reason``**——`SceneRunRead`
    的 ``empty_reason`` 被前端试跑面板与 11 个后端用例同时读，措辞里有
    断言依赖（``"99"`` / ``"人"`` / ``"天数"`` / ``"±"`` / ``"没有数据"``）。
    """
    if result.total == 0:
        return "这张表里没有数据行，请先上传数据。"
    if result.unconvertible and result.unconvertible >= result.total:
        return "表里的数值全都无法解析（可能是列映射错了或整列是文本），请检查数据表。"
    if result.invalid_budget:
        return "预算填的不是正数，无法计算偏差。填一个大于 0 的金额再试。"

    norm_step = next((s for s in result.steps if s.key == "normalize"), None)
    people_step = next((s for s in result.steps if s.key == "people"), None)
    days_step = next((s for s in result.steps if s.key == "days"), None)
    score_step = next((s for s in result.steps if s.key == "score"), None)

    if people_step and people_step.to == 0 and people_step.from_ > 0:
        return f"表里没有 {slots.get('people')} 人的方案（{people_step.from_} 行都在人数这层被排除）。"
    if days_step and days_step.to == 0 and days_step.from_ > 0:
        tol = 1
        return f"人数对上了，但表里没有 {(slots.get('days') or 0)}±{tol} 天的方案。"
    if score_step and score_step.to == 0 and score_step.from_ > 0:
        return (
            "人数天数都对上了，但这些方案的预算和你给的目标差距太大（超过闸门阈值），"
            "已全部排除。可以放宽预算或看看下面的近似结果。"
        )
    if norm_step and norm_step.to == 0:
        return "表里的数值无法解析，请检查数据表的数字列。"
    return "按这组条件没有能对上的行。下面是差距最小的一批，供你参考。"


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
    for slot in scene.slots_json or []:
        key = str(slot.get("key") or "").strip()
        if not key:
            continue
        labels[key] = str(slot.get("label") or slot.get("target") or key)
        if not bool(slot.get("required")):
            continue
        if slots.get(key) in (None, "", [], {}):
            missing.append(key)
    if not missing:
        return None
    ui_config = dict(scene.ui_config_json or {})
    params = dict(ui_config.get("params") or {})
    title = str(params.get("form_title") or "").strip() or _DEFAULT_FORM_TITLE
    form = build_slot_form(missing, labels=labels, title=title)
    if not form:
        return None
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
    form_block = _slot_form_block(scene, slots)
    if form_block is not None:
        blocks.append(form_block)

    respond = dict(scene.respond_action_json or {})
    intro = str(respond.get("intro") or "").strip()
    max_items = max(1, int(respond.get("max_items") or action.top_k or 3))

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
    else:
        if empty_reason:
            blocks.append(SceneUiBlock(kind="text", data={"content": empty_reason}))
        blocks.append(
            SceneUiBlock(
                kind="empty",
                data={
                    "reason": empty_reason,
                    # `steps` 与 `funnel` 同时给：视觉契约（v3 §2）读 `data.steps`
                    # 拿完整漏斗，arch §2.2 冻的是精简的 `funnel`。两个都发是
                    # 加法，不破坏任何一侧的读法。
                    "steps": trace,
                    "funnel": [
                        {"label": s["label"], "from": s["from"], "to": s["to"]}
                        for s in trace
                    ],
                    "suggestions": [
                        {"label": "放宽预算再试", "send_text": "预算可以再高一点"},
                        {"label": "换个人数", "send_text": "人数可以换一下"},
                    ],
                },
            )
        )
        text_out = empty_reason

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


#: 通道名 → 实现。
#:
#: ⚠️ **这不是分派注册表**——``dispatch_scene`` 用 ``match`` 语句显式写 4 个
#: ``case``（arch §2.5：已知 4 个常量分支时 ``match`` 能让类型检查器做穷尽性
#: 提醒，dict 查表会把「少注册一个」变成运行期 ``KeyError``）。
#: 这个映射只服务于「按名取实现」的测试与诊断，**新增第 5 类时不要只加这里**。
CHANNEL_RUNNERS = {
    "table_match": _run_table_match,
    "sop_flow": _run_sop_flow,
    "handoff": _run_handoff,
    "script": _run_script,
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
    "hit_payload",
    "load_scene_tables",
    "normalize_column",
    "unit_by_slot_of",
]