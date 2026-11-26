"""场景预设（L2 层）：出厂值、读取、实时继承。

## 三层职责（改这块之前先读）

| 层 | 谁定 | 存在哪 | 用户能改吗 |
|---|---|---|---|
| L1 module 实现 | 开发者写代码 | `src/scenes/modules/<module_key>/` | 不能 |
| L2 预设（本模块） | 超管在 `/enterprise/scene-presets` 改 | `scene_presets.preset_json` | 不能（普通用户） |
| L3 场景实例 | 用户建场景时填 | `scenes` 行 | 名称 / 图标 / 描述 / 槽位 / 匹配策略 |

## 两种生效方式（这是本文件存在的理由）

``preset_json`` 里的字段按「用户能不能改」分成两类，生效方式**刻意不同**：

- ``ui_config`` / ``trigger`` —— 用户不能改，**每次渲染实时回读预设**。
  超管把「选这个」改成「立即预订」，全租户所有存量场景下一句话就变了。
- ``slots`` / ``match_action`` —— 用户能改，**只在建场景时抄一份**，之后归用户。
  实时回读会把用户自己映射好的槽位冲掉（他换过表、列名不一样）。

把两类混成一种（全实时 / 全快照）都会坏：全实时会冲掉用户的槽位映射，
全快照则「改文案要逐个场景点一遍保存」，正是本次要消灭的手工。

## 出厂预设不落库、不写种子脚本

``BUILTIN_PRESETS`` 是代码里的常量，读取时「库里没有就用它」而不是启动时
INSERT 一次。理由：种子脚本只在 `init_db` 跑，而 `init_db` 的唯一 schema 动作
是 `create_all`（见 `app/db/database.py` 的约定）——往那里塞数据动作会让
「新库」和「老库升级上来的库」拥有不同的初始数据，且没人说得清差异从哪来。
库里没有 = 用出厂值；超管第一次保存才落行。这样任何时刻都能用出厂值重置。
"""

from __future__ import annotations

from typing import Any

from sqlmodel import Session, select

from sqlalchemy.exc import OperationalError

from app.db.models import ScenePreset, utc_now

#: 用户不能改、每次渲染实时回读的键。**新增字段想实时生效就加到这里。**
REALTIME_KEYS: tuple[str, ...] = ("ui_config", "trigger")

#: 只在建场景时抄一份、之后归用户的键。
SNAPSHOT_KEYS: tuple[str, ...] = ("slots", "match_action")


# ============================================================
# 出厂预设
# ============================================================

#: `travel.itinerary` 的出厂预设。
#:
#: 这里是**全租户的默认值**，改了它等于改所有还没被超管覆盖的租户。数值来源：
#: - `ui_config.params`：`src/scenes/modules/travel.itinerary/params.ts` 的
#:   `TRAVEL_ITINERARY_PARAM_DEFAULTS`（两份必须一致，前端那份是「拿不到 params
#:   时的最后兜底」，后端这份是「场景真的配了什么」）
#: - `match_action`：与 `app/scenes/schema.py::DEFAULT_MATCH_ACTION` 一致
#: - `slots`：三个语义槽位，`key` 被匹配层直接消费（不能改），`target` 留空由
#:   用户按自己的表头指一下
_ITINERARY_PARAMS: dict[str, Any] = {
    "schema_version": 1,
    "description": "根据人数、天数、预算，从价目表里推荐合适的行程",
    # 新建场景时图标下拉可选的项（第一个是默认值）
    "icons": ["🎿", "🏔️", "🗺️", "✈️", "🧳", "📊"],
    "ui_config": {
        "fallback_text": "找到了合适的行程，详情看上方的卡片",
        "params": {
            # 没有 primary_action_label / secondary_action_label：
            # `travel.itinerary` 的卡上已经不放「选这个 / 看详情」这两颗按钮了
            # （行程推荐是终态，点下去只是复述一句话再转一圈）。
            # 与前端 `itineraryData.ts` 的 TRAVEL_ITINERARY_PARAM_DEFAULTS 对齐。
            "price_note": "/人 · 含住宿、雪票、教练、接送",
            "show_source_table": True,
            # 列映射留空 = 按表头同名兜底（`COLUMN_CANDIDATES`）。
            # 超管在这里填死某一列，就锁住了「标题取哪列」，用户改不了。
            "title_column": "",
            "price_column": "",
            "people_column": "",
            "days_column": "",
            "budget_column": "",
            "destination_column": "",
            "schedule_column": "",
        },
        "form_title": "告诉我们你的需求",
        # 卡头副标题：员工新建场景时的**预填值**（可以在定义器里改）。
        # 与 `channels.py::_slot_form_block` 的兜底句一致 —— 一致不是巧合：
        # 预填值改空后走兜底，如果两边文案不同，用户会看到「清空一下文案就变了」。
        "form_subtitle": "填好这几项，我按方案表逐条比对",
    },
    # 引导语（表格上方那句）。放在 `respond_action` 的语境里而不是 `ui_config`：
    # 它说的是「为什么现在要问你」，属于场景实例自己的回答策略。
    # 这里只是**建议值**，员工在定义器里随手改，改完以场景上的为准。
    "respond_action": {
        "ask_prompt": "先确认这几个条件，我按方案表逐层筛：",
    },
    "trigger": {
        # 用户不配触发条件：默认按钮触发 + 跳过意图路由（最稳的一条路）。
        "shortcut": True,
        "shortcut_label": "",
        "examples": [],
        "keywords": [],
        "require_slots": True,
        "bypass_llm_router": True,
    },
    "slots": [
        {
            "key": "people",
            "label": "人数",
            "target": "",
            "type": "number",
            "unit": "人",
            "required": True,
            "prompt": "你们几个人去？",
        },
        {
            "key": "days",
            "label": "天数",
            "target": "",
            "type": "number",
            "unit": "天",
            "required": True,
            "prompt": "计划玩几天？",
        },
        {
            "key": "budget",
            "label": "预算",
            "target": "",
            "type": "number",
            "unit": "元",
            "required": True,
            "prompt": "人均预算大概多少？",
        },
    ],
    "match_action": {
        "days_weight": 1.5,
        "budget_weight": 1.0,
        "days_tolerance": 1,
        "people_tolerance": 0,
        "max_score": 2.0,
        "top_k": 3,
        "rule_weight": 0.5,
        "use_decision_model": False,
        "on_empty": "nearest",
    },
}

#: 出厂预设清单。新增定制 module 时在这里加一项，超管页面就会出现它。
#:
#: 只登记**定制 module**（有真 UI 代码的那种）。四个 `generic.*` 不进这里：
#: 它们没有可配参数，登记了只会在超管页面里挂四个空表单。
BUILTIN_PRESETS: list[dict[str, Any]] = [
    {
        "module_key": "travel.itinerary",
        "display_name": "行程规划",
        "scene_type": "table_match",
        "icon": "🎿",
        "enabled": True,
        "order_index": 0,
        "preset_json": _ITINERARY_PARAMS,
    },
]


def builtin_preset(module_key: str) -> dict[str, Any] | None:
    """取出厂预设（找不到返回 ``None``）。返回的是深拷贝，调用方可安全修改。"""
    target = str(module_key or "").strip()
    if not target:
        return None
    for row in BUILTIN_PRESETS:
        if row["module_key"] == target:
            return _deepcopy_dict(row)
    return None


def _deepcopy_dict(value: dict[str, Any]) -> dict[str, Any]:
    """深拷贝一份 JSON 结构。

    不用 ``copy.deepcopy``：这里的值全是 JSON 可表达的（dict / list / str /
    number / bool / None），手写递归比 deepcopy 快一个数量级，也不会把将来
    误塞进来的不可拷贝对象带过边界。
    """
    out: dict[str, Any] = {}
    for key, item in value.items():
        out[key] = _deepcopy_value(item)
    return out


def _deepcopy_value(value: Any) -> Any:
    if isinstance(value, dict):
        return _deepcopy_dict(value)
    if isinstance(value, list):
        return [_deepcopy_value(item) for item in value]
    return value


# ============================================================
# 读取
# ============================================================


def list_presets(db: Session, *, only_enabled: bool = False) -> list[dict[str, Any]]:
    """列出全部预设：库里有的覆盖出厂值，库里没有的用出厂值补齐。

    ## 为什么是「合并」而不是「整份以库为准」

    出厂预设在代码里、用户改过的在库里。如果只读库，那么「新版本加了一个
    定制 module」不会出现在超管页面（没人保存过它）——表现为「开发说做了个
    新场景，管理员看不到」。反过来只读代码，超管一改就丢。

    所以按 ``module_key`` 做外连接：代码里的清单决定「有哪些」，库里的行决定
    「值是什么」。
    """
    rows = list(db.exec(select(ScenePreset)).all())
    by_key: dict[str, ScenePreset] = {row.module_key: row for row in rows}

    merged: list[dict[str, Any]] = []
    seen: set[str] = set()

    # 先走出厂清单，保证「代码里新增了 module」立刻可见
    for spec in BUILTIN_PRESETS:
        key = spec["module_key"]
        seen.add(key)
        row = by_key.get(key)
        if row is None:
            merged.append(_deepcopy_dict(spec))
            continue
        merged.append(_preset_row_to_dict(row))

    # 再补库里多出来的（手工建的 / 已从代码删掉但库里还留着的）
    for row in rows:
        if row.module_key in seen:
            continue
        merged.append(_preset_row_to_dict(row))

    if only_enabled:
        merged = [item for item in merged if item.get("enabled", True)]

    merged.sort(key=lambda item: (int(item.get("order_index") or 0), str(item.get("module_key") or "")))
    return merged


def _preset_row_to_dict(row: ScenePreset) -> dict[str, Any]:
    return {
        "module_key": row.module_key,
        "display_name": row.display_name,
        "scene_type": row.scene_type,
        "icon": row.icon,
        "enabled": bool(row.enabled),
        "order_index": int(row.order_index or 0),
        "preset_json": _deepcopy_dict(dict(row.preset_json or {})),
        "updated_at": row.updated_at.isoformat() if row.updated_at else "",
        "updated_by": row.updated_by or "",
    }


def get_preset(db: Session, module_key: str) -> dict[str, Any] | None:
    """取单个预设（库里的优先，没有则出厂值）。找不到返回 ``None``。

    ## 为什么吞掉「表不存在」这一类 DB 错误

    预设是**增强能力**，不是场景运行的必要条件：没有预设时用出厂值（代码里
    有常量），场景照常跑。而 ``scene_presets`` 是新表，``create_all`` 只在
    建新库时创它 —— 线上老库在跑过一次建表之前，任何 ``SELECT`` 都会抛
    ``no such table``。如果这里不吞，表现是「升级后所有场景渲染 500」，
    也就是一个纯配置能力把核心链路带崩。

    降级后的行为完全正确：返回 ``None`` → 调用方回落 ``builtin_preset()``
    → 用户看到的就是出厂预设，和「表存在但没存行」一模一样。

    ## 为什么只吞 OperationalError 的 limited 情形

    ``except OperationalError`` 会把连接超时、锁等待也一起吞掉（那些应当报出来）。
    所以额外判消息里有没有 ``no such table`` / ``does not exist``（PG 的措辞），
    其余 OperationalError 原样抛出。这样「表没建」降级，「数据库挂了」仍然报错。
    """
    key = str(module_key or "").strip()
    if not key:
        return None
    try:
        row = db.get(ScenePreset, key)
    except OperationalError as error:
        if _is_missing_table_error(error):
            db.rollback()
            return builtin_preset(key)
        raise
    if row is not None:
        return _preset_row_to_dict(row)
    return builtin_preset(key)


def _is_missing_table_error(error: Exception) -> bool:
    """判断是不是「表不存在」这一类错误（SQLite 与 PG 措辞不同，两种都认）。"""
    text = str(getattr(error, "orig", error) or "").lower()
    return "no such table" in text or "does not exist" in text or "undefinedtable" in text


def list_presets_safe(db: Session, *, only_enabled: bool = False) -> list[dict[str, Any]]:
    """``list_presets`` 的降级版本：表不存在时只返回出厂预设。

    超管页面用这个（不能因为表没建就白屏），见 ``get_preset`` 的降级说明。
    """
    try:
        return list_presets(db, only_enabled=only_enabled)
    except OperationalError as error:
        if not _is_missing_table_error(error):
            raise
        db.rollback()
        rows = [builtin_preset(spec["module_key"]) for spec in BUILTIN_PRESETS]
        merged = [row for row in rows if row is not None]
        if only_enabled:
            merged = [item for item in merged if item.get("enabled", True)]
        merged.sort(key=lambda item: (int(item.get("order_index") or 0), str(item.get("module_key") or "")))
        return merged


def get_preset_json(db: Session, module_key: str) -> dict[str, Any]:
    """只取 ``preset_json``，永远返回 dict（找不到则空 dict）。"""
    preset = get_preset(db, module_key)
    if not preset:
        return {}
    payload = preset.get("preset_json")
    return dict(payload) if isinstance(payload, dict) else {}


# ============================================================
# 实时继承（渲染时调用）
# ============================================================


def effective_ui_config(scene: Any, db: Session | None = None) -> dict[str, Any]:
    """算出这个场景**实际生效**的 ``ui_config``。

    优先级：场景自己显式配了的键 → 预设里的对应键 → 空。

    ## 为什么是「按键合并」而不是「整份用预设」

    场景的 ``ui_config_json`` 里可能有历史存量值（本次改造之前建的场景都存了
    一份）。如果整份用预设，那些场景的 ``fallback_text`` 会突然变空 ——
    而它是发布校验的阻断项，等于「升级后老场景都变成不可发布」。
    按层合并则是：老场景有值就用老值，没有就吃预设，不破坏任何存量。

    ``db`` 传 ``None`` 时只用场景自身配置（单测/纯函数场景可这样调）。
    """
    own = dict(getattr(scene, "ui_config_json", None) or {})
    if db is None:
        return own

    preset = get_preset_json(db, str(getattr(scene, "module_key", "") or ""))
    base = preset.get("ui_config")
    if not isinstance(base, dict):
        return own

    merged = _deepcopy_dict(base)
    own_params = own.get("params")
    if isinstance(own_params, dict) and own_params:
        # params 按键合并：场景显式配了某列就用它（用户可能已经在定义器里
        # 指过列），没配的列继续吃预设（超管刚锁的那列要生效）。
        preset_params = merged.get("params")
        next_params = dict(preset_params) if isinstance(preset_params, dict) else {}
        for key, value in own_params.items():
            if value not in (None, ""):
                next_params[key] = value
        merged["params"] = next_params
    # 顶层非 params 的键（fallback_text / form_title）场景有值就盖掉预设
    for key, value in own.items():
        if key == "params":
            continue
        if value not in (None, "", {}, []):
            merged[key] = value
    return merged


def effective_trigger(scene: Any, db: Session | None = None) -> dict[str, Any]:
    """算出实际生效的 ``trigger``。语义与 ``effective_ui_config`` 一致。

    触发条件用户不配（默认按钮触发），所以这里基本恒等于预设值；
    保留自己的值是为了兼容存量场景（它们可能存了关键词）。
    """
    own = dict(getattr(scene, "trigger_json", None) or {})
    if db is None:
        return own

    preset = get_preset_json(db, str(getattr(scene, "module_key", "") or ""))
    base = preset.get("trigger")
    if not isinstance(base, dict):
        return own

    merged = _deepcopy_dict(base)
    for key, value in own.items():
        if value not in (None, "", [], {}):
            merged[key] = value
    return merged


def initial_scene_fields(db: Session, module_key: str) -> dict[str, Any]:
    """用预设初始化一份「新建场景」的字段默认值。

    返回 ``{scene_type, icon, ui_config, trigger, slots, match_action,
    respond_action, name_hint}``。
    定义器拉到它就能直接铺好表单，用户只需要改名称/图标/描述。

    ## 为什么 ``slots`` / ``match_action`` 也一起给

    它们是**初始值**（用户建完之后归用户），但「初始值来自预设」这件事必须成立
    ——否则「超管把默认容差从 1 天改成 2 天」对新建场景不生效。
    """
    preset = get_preset(db, module_key)
    payload = dict(preset.get("preset_json") or {}) if preset else {}
    ui_config = payload.get("ui_config")
    return {
        "module_key": str(module_key or ""),
        "display_name": str((preset or {}).get("display_name") or ""),
        "scene_type": str((preset or {}).get("scene_type") or "table_match"),
        "icon": str((preset or {}).get("icon") or ""),
        "description": str(payload.get("description") or ""),
        "icons": list(payload.get("icons") or []),
        "ui_config": _deepcopy_dict(ui_config) if isinstance(ui_config, dict) else {},
        "trigger": _deepcopy_dict(payload.get("trigger")) if isinstance(payload.get("trigger"), dict) else {},
        "slots": _deepcopy_value(payload.get("slots")) if isinstance(payload.get("slots"), list) else [],
        "match_action": _deepcopy_dict(payload.get("match_action"))
        if isinstance(payload.get("match_action"), dict)
        else {},
        # 「表单引导语」在预设里是**建议值**（`ask_prompt`），场景建好后归员工。
        #
        # 必须从 `payload.respond_action` 取而不是凭空造一个顶层 key：场景上
        # 它存在 `respond_action_json.ask_prompt`，预设这边保持同一条路径，
        # 定义器拿到的结构和它最终保存的结构才是一致的（少一层映射就少一处漂移）。
        "respond_action": _deepcopy_dict(payload.get("respond_action"))
        if isinstance(payload.get("respond_action"), dict)
        else {},
    }


# ============================================================
# 写入
# ============================================================


def upsert_preset(
    db: Session,
    *,
    module_key: str,
    display_name: str = "",
    scene_type: str = "",
    icon: str = "",
    enabled: bool = True,
    preset_json: dict[str, Any] | None = None,
    order_index: int = 0,
    updated_by: str = "",
) -> ScenePreset:
    """新建或整份覆盖一条预设。

    ``preset_json`` 是**整份覆盖**语义（不是字段合并）：超管页面编辑的就是完整
    JSON，字段合并会让「删掉一个参数」永远删不掉——它下次会被旧值补回来。
    """
    key = str(module_key or "").strip()
    if not key:
        raise ValueError("module_key 不能为空")

    row = db.get(ScenePreset, key)
    if row is None:
        row = ScenePreset(module_key=key)
        db.add(row)

    fallback = builtin_preset(key) or {}
    row.display_name = str(display_name or fallback.get("display_name") or key)
    row.scene_type = str(scene_type or fallback.get("scene_type") or "table_match")
    row.icon = str(icon or fallback.get("icon") or "")
    row.enabled = bool(enabled)
    row.order_index = int(order_index or 0)
    row.preset_json = _deepcopy_dict(preset_json or {})
    row.updated_by = str(updated_by or "")
    row.updated_at = utc_now()
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def reset_preset(db: Session, module_key: str) -> dict[str, Any] | None:
    """删掉库里的覆盖，回到出厂值。返回重置后的预设（没有出厂值则 ``None``）。"""
    key = str(module_key or "").strip()
    row = db.get(ScenePreset, key)
    if row is not None:
        db.delete(row)
        db.commit()
    return get_preset(db, key)


__all__ = [
    "BUILTIN_PRESETS",
    "REALTIME_KEYS",
    "SNAPSHOT_KEYS",
    "builtin_preset",
    "effective_trigger",
    "effective_ui_config",
    "get_preset",
    "get_preset_json",
    "initial_scene_fields",
    "list_presets",
    "list_presets_safe",
    "reset_preset",
    "upsert_preset",
]