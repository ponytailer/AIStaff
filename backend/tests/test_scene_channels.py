"""4 条场景通道 + 分派降级的护栏。

``scene_modules`` 是整块新增代码，既有 145 条用例零覆盖 —— 通道写错不会
被任何既有用例顶出来。这里按「每条通道都能产出至少一个块」的最小标准兜住，
再单独锁住两个最容易写错、且不会抛异常的点：

1. **未知 ``scene_type`` 不能抛异常**（必须是降级的 ``text`` 块）。抛异常的后果
   是用户在对话里看到一个 500，而不是「这个场景的类型暂不支持」。
2. **``_resolve_slot_columns`` 必须返回三元组**（不是 dict）。返回 3-key dict
   时 Python 解包**不报错**，但解出来的是 key 字符串而不是列名 →
   matcher 拿 ``"people"`` 去查中文表的 ``"人数"`` 列 → 全取空 → 命中从 2 变 0，
   全程无异常。这是本次重构里最难查的一种静默错误。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlmodel import select

sys.path.insert(0, str(Path(__file__).parent))

from dispatch_fixtures import TENANT, make_agent, memory_session, seed_tenant

from app.db.models import Scene, SceneTable, SceneTableRow
from app.scene_modules.channels import (
    _resolve_slot_columns,
    empty_reason_for,
    hit_payload,
    columns_diff,
    columns_signature,
    load_scene_tables,
    normalize_column,
)
from app.scene_modules.runtime import (
    UNSUPPORTED_TYPE_TEXT,
    build_ui_blocks,
    dispatch_scene,
    resolve_scene_hit,
    run_scene_instance,
)

CSV_COLUMNS = [
    {"key": "人数", "label": "人数", "type": "number", "unit": "人"},
    {"key": "天数", "label": "天数", "type": "number", "unit": "天"},
    {"key": "预算", "label": "预算", "type": "number", "unit": "元"},
    {"key": "计划内容", "label": "计划内容", "type": "text", "unit": ""},
]

ROWS = [
    {"人数": "4", "天数": "5", "预算": "3000", "计划内容": "经典雪山五日"},
    {"人数": "4", "天数": "5", "预算": "6000", "计划内容": "深度滑雪五日"},
    {"人数": "2", "天数": "3", "预算": "2000", "计划内容": "双人三日"},
]


@pytest.fixture()
def db():
    session = memory_session()
    seed_tenant(session)
    session.add(make_agent("agent_scene", name="行程规划", owner_id="user_owner"))
    session.commit()
    return session


def _make_scene(
    db,
    *,
    name: str = "滑雪行程推荐",
    scene_type: str = "table_match",
    module_key: str = "generic.table_match",
    status: str = "published",
    slots: list[dict] | None = None,
    match_action: dict | None = None,
    trigger: dict | None = None,
    flow: dict | None = None,
    handoff: dict | None = None,
    scripts: list[dict] | None = None,
    ui_config: dict | None = None,
) -> Scene:
    scene = Scene(
        tenant_id=TENANT,
        name=name,
        scene_type=scene_type,
        module_key=module_key,
        status=status,
        slots_json=slots
        if slots is not None
        else [
            {"key": "people", "target": "人数", "required": True},
            {"key": "days", "target": "天数", "required": True},
            {"key": "budget", "target": "预算", "required": True},
        ],
        match_action_json=dict(match_action or {}),
        trigger_json=dict(trigger or {}),
        flow_json=dict(flow or {}),
        handoff_json=dict(handoff or {}),
        scripts_json=list(scripts or []),
        ui_config_json=dict(ui_config or {}),
    )
    db.add(scene)
    db.commit()
    db.refresh(scene)
    return scene


def _attach_table(db, scene: Scene, columns=None, rows=None) -> SceneTable:
    table = SceneTable(
        tenant_id=TENANT,
        scene_id=scene.id,
        order_index=0,
        name="滑雪价目",
        source_filename="ski.csv",
        columns_json=list(columns if columns is not None else CSV_COLUMNS),
        row_count=len(rows if rows is not None else ROWS),
        status="ready",
    )
    db.add(table)
    db.flush()
    for index, row in enumerate(rows if rows is not None else ROWS):
        db.add(
            SceneTableRow(
                tenant_id=TENANT,
                table_id=table.id,
                row_index=index,
                row_json=row,
                norm_json={},
            )
        )
    db.commit()
    db.refresh(table)
    return table


# ---------------------------------------------------------------------------
# 四通道
# ---------------------------------------------------------------------------


def test_table_match_channel_produces_result_and_detail(db) -> None:
    scene = _make_scene(db)
    _attach_table(db, scene)

    result = dispatch_scene(
        db,
        scene=scene,
        slots={"people": 4, "days": 5, "budget": 3000},
        message="4 人 5 天 3000 预算",
        persist=False,
    )

    assert result.status == "ok"
    kinds = [b.kind for b in result.blocks]
    assert "result" in kinds
    # 兼容层明细：试跑面板与 11 个既有 /run 用例都读它
    assert result.detail["people_key"] == "人数"
    assert result.detail["days_key"] == "天数"
    assert result.detail["budget_key"] == "预算"
    assert result.detail["hits"], "应当命中经典雪山五日"
    assert result.detail["hits"][0]["values"]["计划内容"] == "经典雪山五日"


def test_table_match_channel_with_zero_tables_degrades(db) -> None:
    """0 张表是**合法状态**，不是错误：产 text + empty，不抛异常。"""
    scene = _make_scene(db, name="还没配表")
    result = dispatch_scene(db, scene=scene, slots={}, message="推荐", persist=False)

    assert result.status == "no_match"
    assert [b.kind for b in result.blocks] == ["text", "empty"]
    assert result.detail["hits"] == []


def test_sop_flow_channel_produces_step_blocks(db) -> None:
    scene = _make_scene(
        db,
        name="报销办理",
        scene_type="sop_flow",
        module_key="generic.sop_flow",
        flow={
            "intro": "按顺序办：",
            "steps": [
                {"name": "填申请", "required_slots": ["amount"]},
                {"name": "上传发票", "required_slots": ["invoice"]},
            ],
        },
    )
    result = dispatch_scene(db, scene=scene, slots={"amount": 100}, message="报销", persist=False)

    assert result.status == "ok"
    kinds = [b.kind for b in result.blocks]
    assert kinds.count("step") == 2
    # 第一个步骤的 required 已满足 → done；第二个缺 invoice → awaiting_input 并中断
    steps = [b for b in result.blocks if b.kind == "step"]
    assert steps[0].data["status"] == "done"
    assert steps[1].data["status"] == "awaiting_input"
    assert steps[1].data["missing"] == ["invoice"]


def test_handoff_channel_produces_handoff_block_without_ticket_when_not_persisted(db) -> None:
    """试跑（persist=False）不该在库里留下真实工单。"""
    scene = _make_scene(
        db,
        name="转人工",
        scene_type="handoff",
        module_key="generic.handoff",
        handoff={"target": "售后同事", "summary": "需要人工介入"},
    )
    result = dispatch_scene(db, scene=scene, slots={}, message="找人工", persist=False)

    assert result.status == "ok"
    block = next(b for b in result.blocks if b.kind == "handoff")
    assert block.data["target"] == "售后同事"
    assert block.data["ticket_id"] == ""


def test_script_channel_matches_by_keyword(db) -> None:
    scene = _make_scene(
        db,
        name="固定话术",
        scene_type="script",
        module_key="generic.script",
        scripts=[
            {"title": "营业时间", "keywords": ["营业", "几点"], "reply": "我们 9:00-18:00。"},
            {"title": "退款", "keywords": ["退款"], "reply": "7 个工作日到账。"},
        ],
    )
    result = dispatch_scene(db, scene=scene, slots={}, message="你们几点营业", persist=False)

    assert result.status == "ok"
    assert "9:00-18:00" in result.text


def test_script_channel_without_keyword_hit_lists_catalogue(db) -> None:
    scene = _make_scene(
        db,
        name="固定话术2",
        scene_type="script",
        module_key="generic.script",
        scripts=[{"title": "营业时间", "keywords": ["营业"], "reply": "9:00-18:00"}],
    )
    result = dispatch_scene(db, scene=scene, slots={}, message="随便问问", persist=False)

    assert result.status == "no_match"
    assert "营业时间" in result.text


# ---------------------------------------------------------------------------
# 分派降级
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("scene_type", "module_key"),
    [
        ("table_match", "generic.table_match"),
        ("sop_flow", "generic.sop_flow"),
        ("handoff", "generic.handoff"),
        ("script", "generic.script"),
    ],
)
def test_dispatch_covers_all_four_scene_types(db, scene_type: str, module_key: str) -> None:
    """4 个已知类型都必须有 case 分支，且**都不走 unknown 降级**。"""
    scene = _make_scene(
        db,
        name=f"覆盖-{scene_type}",
        scene_type=scene_type,
        module_key=module_key,
    )
    result = dispatch_scene(db, scene=scene, slots={}, message="测试", persist=False)

    assert result.status != "error", f"{scene_type} 走到了 unknown 降级分支"
    assert result.blocks, f"{scene_type} 没产出任何块"


def test_unknown_scene_type_degrades_without_raising(db) -> None:
    """未知类型**不抛异常**：降级成一条 text 块，让用户能看到原因。

    抛异常会让前端白屏或 500，而真实原因（类型不支持）反而看不到。
    """
    scene = _make_scene(db, name="野类型", scene_type="not_a_type", module_key="x.y")

    result = dispatch_scene(db, scene=scene, slots={}, message="测试", persist=False)

    assert result.status == "error"
    assert len(result.blocks) == 1
    assert result.blocks[0].kind == "text"
    assert UNSUPPORTED_TYPE_TEXT in result.blocks[0].data["content"]


def test_run_scene_instance_missing_scene_does_not_raise(db) -> None:
    """聊天链路拿到一个已删场景时应当降级，不是抛异常。"""
    result = run_scene_instance(db, tenant_id=TENANT, scene_id="scene_missing", persist=False)

    assert result.status == "error"
    assert result.blocks and result.blocks[0].kind == "text"


def test_run_scene_instance_rejects_other_tenant(db) -> None:
    scene = _make_scene(db)
    result = run_scene_instance(
        db, tenant_id="tenant_other", scene_id=scene.id, persist=False
    )
    assert result.status == "error"


# ---------------------------------------------------------------------------
# _resolve_slot_columns：三元组 + 四层兜底
# ---------------------------------------------------------------------------


def test_resolve_slot_columns_returns_triple_of_column_names(db) -> None:
    """必须返回**列名**三元组，不是 dict。

    返回 3-key dict 时 ``a, b, c = ...`` 解包**不报错**，得到的是 ``"people"``
    这样的 key 字符串 → matcher 拿它查中文表 → 全空 → 命中从 2 变 0。
    这条断言锁的就是「解出来的是 人数/天数/预算」。
    """
    scene = _make_scene(db)
    columns = [normalize_column(c) for c in CSV_COLUMNS]

    resolved = _resolve_slot_columns(scene, columns)

    assert isinstance(resolved, tuple)
    assert len(resolved) == 3
    people_key, days_key, budget_key = resolved
    assert (people_key, days_key, budget_key) == ("人数", "天数", "预算")


def test_resolve_slot_columns_falls_back_to_slot_key_when_nothing_matches(db) -> None:
    """一个都匹配不上时返回 ``slot_key`` 本身，让 matcher 跳过该层而不是 500。"""
    scene = _make_scene(db, name="怪表", slots=[])
    columns = [normalize_column({"key": "甲", "label": "甲", "type": "text"})]

    people_key, _days_key, _budget_key = _resolve_slot_columns(scene, columns)

    assert people_key == "people", "应当退回 slot_key 本身，而不是抛异常或返回空串"


def test_resolve_slot_columns_prefers_declared_role(db) -> None:
    """槽位声明里的 ``role`` 是新增的一层，只有存在时才会命中。"""
    scene = _make_scene(
        db,
        name="role 表",
        slots=[{"key": "p", "role": "people", "target": "客数"}],
    )
    columns = [normalize_column({"key": "客数", "type": "number"})]

    people_key, _days_key, _budget_key = _resolve_slot_columns(scene, columns)

    assert people_key == "客数"


# ---------------------------------------------------------------------------
# 块组装与工具函数
# ---------------------------------------------------------------------------


def test_build_ui_blocks_fills_module_fields_and_fallback(db) -> None:
    scene = _make_scene(db, ui_config={"fallback_text": "场景兜底文案"})
    _attach_table(db, scene)

    result = dispatch_scene(
        db, scene=scene, slots={"people": 4, "days": 5, "budget": 3000}, message="x", persist=False
    )
    blocks = build_ui_blocks(scene, result)

    assert blocks
    for block in blocks:
        assert block.module_key == "generic.table_match"
        assert block.module_version == 1
        assert block.fallback_text


def test_columns_signature_is_order_sensitive_but_normalised(db) -> None:
    """指纹必须对**顺序**敏感（列语义靠位置），对 label 不敏感（可改名）。"""
    base = columns_signature(CSV_COLUMNS)
    renamed = columns_signature([{**c, "label": c["label"] + "（改）"} for c in CSV_COLUMNS])
    reordered = columns_signature(list(reversed(CSV_COLUMNS)))

    assert base == renamed
    assert base != reordered


def test_columns_diff_reports_missing_extra_and_type_change(db) -> None:
    left = [{"key": "a", "type": "number"}, {"key": "b", "type": "text"}]
    right = [{"key": "a", "type": "text"}, {"key": "c", "type": "text"}]

    kinds = {d["column"]: d["kind"] for d in columns_diff(left, right)}

    assert kinds["a"] == "type_changed"
    assert kinds["b"] == "missing"
    assert kinds["c"] == "extra"


def test_load_scene_tables_ignores_orphan_tables(db) -> None:
    """``scene_id`` 为空的存量孤儿表不能被任何场景加载到。"""
    scene = _make_scene(db)
    _attach_table(db, scene)
    db.add(
        SceneTable(
            tenant_id=TENANT,
            scene_id="",
            name="孤儿表",
            columns_json=list(CSV_COLUMNS),
            status="ready",
        )
    )
    db.commit()

    tables = load_scene_tables(db, scene.id)

    assert [t["name"] for t in tables] == ["滑雪价目"]


def test_hit_payload_strips_internal_keys() -> None:
    """``values`` 必须是纯表格行，内部键不能冒充成列。"""
    class _Row:
        id = "row-1"
        row = {
            "__row_id__": "row-1",
            "__source_table_name__": "滑雪价目",
            "人数": "4",
        }
        score = 0.5
        days_dev = 0.0
        budget_dev = 0.0
        fused = None

    payload = hit_payload(_Row())

    assert set(payload["values"]) == {"人数"}
    assert payload["source_table"] == "滑雪价目"


def test_empty_reason_quantifies_the_failing_layer() -> None:
    """空结果的解释必须量化，不能只说「没找到」（断言依赖措辞，别改文案）。"""

    class _Step:
        def __init__(self, key, from_, to, detail=""):
            self.key = key
            self.from_ = from_
            self.to = to
            self.detail = detail

    class _Result:
        total = 5
        unconvertible = 0
        invalid_budget = False
        steps = [_Step("people", 5, 0)]

    reason = empty_reason_for(_Result(), {"people": 99, "days": 5})

    assert "99" in reason and "人" in reason


# ---------------------------------------------------------------------------
# 聊天端入口胶囊（/api/chat/scenes）
# ---------------------------------------------------------------------------


def test_scene_chips_only_lists_published_and_active(db) -> None:
    """胶囊只列 ``published`` + ``active``。

    draft 出现在对话页会让用户点到一个「还没配完」的场景；
    解绑后仍出现则违反「解绑即消失、不发版」这条红线。
    """
    from app.agents.branching import ensure_private_resource_binding

    from app.scene_modules.chips import list_scene_chips

    published = _make_scene(db, name="已发布")
    ensure_private_resource_binding(db, TENANT, "agent_scene", "scene", published.id)
    _make_scene(db, name="草稿", status="draft")
    _make_scene(db, name="未绑定")
    db.commit()

    chips = list_scene_chips(db, tenant_id=TENANT, agent_id="agent_scene")

    assert [c.scene_name for c in chips] == ["已发布"]


def test_scene_chip_route_prefix_is_chat_scope(db) -> None:
    """前缀必须是 ``/api/chat/``：分享访客白名单只放行该前缀。"""
    from app.scene_modules.chips import chat_router

    assert chat_router.prefix.startswith("/api/chat/")


def test_scene_chip_payload_has_no_on_click_field() -> None:
    """入口行为由 module 的 ``meta.entry_behavior`` 声明，后端不持有这个事实。

    一旦把 ``on_click`` 塞进载荷，就等于把「点了干什么」抄进了 DB，
    于是「改了前端代码线上行为没变」而且两处都看不到对方。
    """
    from app.scenes.schema import SceneModuleRead

    assert "on_click" not in SceneModuleRead.model_fields