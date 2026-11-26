"""仙林 AI G.O 滑雪场景的端到端链路测试。

**这份测试的依据是线上真实场景，不是虚构 fixture。**

线上配置（``scene_3b3c1cc323cd43d6``，绑在 ``agent_eefcd08a8bc447e0`` 仙林 AI G.O 上）：

    scene_type          : table_match
    module_key          : travel.itinerary
    status              : published
    slots               : people / days / budget，三个都 required
    match_action        : days_tolerance=1, max_score=2, top_k=3,
                          days_weight=1.5, budget_weight=1,
                          use_decision_model=true, on_empty=nearest
    respond_action      : ask_prompt="好的，我来帮你安排，请先补充以下信息"

数据表「滑雪套餐价目表」5 行，**每行的「备注」列写明了它该验什么边界**，
所以这份测试的期望值不是拍脑袋写的，是对着表里的备注逐条推的：

| 行 | 套餐 | 人数 | 天数 | 预算 | 备注（原文） |
|---|---|---|---|---|---|
| 0 | 经典雪山五日 | 4 | 5 | 3000 | 主力套餐，用于验证逐日时间轴完整渲染 |
| 1 | 雪乡深度六日 | 4 | 6 | 3600 | 天数容差边界：5 天需求 +1 天仍应命中 |
| 2 | 轻奢雪场三日 | 4 | 3 | 4800 | 天数容差外：5 天需求 -2 天，应在天数层被淘汰 |
| 3 | 家庭亲子五日 | 6 | 5 | 2800 | 人数硬约束：6 人 vs 4 人需求应被淘汰（价格最低也救不回来） |
| 4 | 周末双滑两日 | 2 | 2 | 980 | 双重不匹配：人数 2、天数 2，第一层就被淘汰 |

为什么单独建一份文件而不是塞进 ``test_scene_channels.py``：
那份测的是**通道的通用契约**（四条通道都能产出块、未知类型要降级）。
这里测的是**一个具体场景配好之后，用户从点胶囊到拿到结果的整条链路**，
两者的失效原因不同 —— 前者坏了是框架问题，后者坏了是配置或数据问题。

**注意**：这里不连线上库。线上数据会变（改表、改配置），拿它当 fixture
会让测试随数据漂移而随机失败。所以把配置和表格**原样复刻**到内存库，
并在下方 ``_SEED_ROWS`` 里保持与线上一致；线上配置若变了，改这里的同时
要更新本文件的表格注释。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlmodel import select

sys.path.insert(0, str(Path(__file__).parent))

from dispatch_fixtures import TENANT, make_agent, memory_session, seed_tenant

from app.db.models import AgentResourceBinding, Scene, SceneTable, SceneTableRow
from app.scene_modules.runtime import run_scene_instance

SCENE_NAME = "滑雪行程推荐"
MODULE_KEY = "travel.itinerary"

# 线上列定义（原样复刻，含「日程」「备注」—— 它们不参与匹配，
# 但少了会让 hit_payload 的字段拼装与线上不一致）
COLUMNS = [
    {"key": "套餐编号", "label": "套餐编号", "type": "text", "unit": ""},
    {"key": "计划内容", "label": "计划内容", "type": "text", "unit": ""},
    {"key": "目的地", "label": "目的地", "type": "text", "unit": ""},
    {"key": "人数", "label": "人数", "type": "number", "unit": "人"},
    {"key": "天数", "label": "天数", "type": "number", "unit": "天"},
    {"key": "预算", "label": "预算", "type": "number", "unit": "元"},
    {"key": "日程", "label": "日程", "type": "text", "unit": ""},
    {"key": "备注", "label": "备注", "type": "text", "unit": ""},
]

# 与线上 5 行**逐字一致**。值带单位（"4 人"）是线上真实形态 ——
# 归一化层负责把它剥成数字，这正是要验的环节之一。
_SEED_ROWS = [
    {
        "套餐编号": "SK-1001",
        "计划内容": "经典雪山五日",
        "目的地": "亚布力",
        "人数": "4 人",
        "天数": "5 天",
        "预算": "3000 元",
        "日程": "抵达亚布力|哈尔滨接站，入住雪场酒店。|含接站,含晚餐|抵达\n初级道练习|上午教练带练，下午自由滑。|含雪票,含教练|初级",
        "备注": "主力套餐，用于验证逐日时间轴完整渲染",
    },
    {
        "套餐编号": "SK-1002",
        "计划内容": "雪乡深度六日",
        "目的地": "雪乡",
        "人数": "4 人",
        "天数": "6 天",
        "预算": "3600 元",
        "日程": "抵达雪乡|牡丹江接站，入住民宿。|含接站|抵达\n雪韵大街|自由漫步雪韵大街。|含早餐|游玩",
        "备注": "天数容差边界：5 天需求 +1 天仍应命中",
    },
    {
        "套餐编号": "SK-1003",
        "计划内容": "轻奢雪场三日",
        "目的地": "长白山",
        "人数": "4 人",
        "天数": "3 天",
        "预算": "4800 元",
        "日程": "抵达长白山|机场接站，入住温泉酒店。|含接站,含温泉|抵达\n初级道练习|万达雪场全天练习。|含雪票,含教练|初级",
        "备注": "天数容差外：5 天需求 -2 天，应在「天数」层被淘汰",
    },
    {
        "套餐编号": "SK-1004",
        "计划内容": "家庭亲子五日",
        "目的地": "崇礼",
        "人数": "6 人",
        "天数": "5 天",
        "预算": "2800 元",
        "日程": "抵达崇礼|张家口接站，入住亲子酒店。|含接站|抵达\n初级道练习|儿童滑雪学校半天。|含雪票,含教练|初级",
        "备注": "人数硬约束：6 人 vs 4 人需求应被淘汰（价格最低也救不回来）",
    },
    {
        "套餐编号": "SK-1005",
        "计划内容": "周末双滑两日",
        "目的地": "南山",
        "人数": "2 人",
        "天数": "2 天",
        "预算": "980 元",
        "日程": "抵达南山|市区自驾抵达，入住雪场公寓。|不含接送|抵达\n初级道练习|全天雪票自由滑。|含雪票|初级",
        "备注": "双重不匹配：人数 2、天数 2，第一层就被淘汰",
    },
]

# 线上槽位配置（三个都 required）
SLOTS = [
    {"key": "people", "label": "人数", "target": "人数", "type": "number",
     "unit": "人", "required": True, "prompt": "你们几个人去？"},
    {"key": "days", "label": "天数", "target": "天数", "type": "number",
     "unit": "天", "required": True, "prompt": "计划玩几天？"},
    {"key": "budget", "label": "预算", "target": "预算", "type": "number",
     "unit": "元", "required": True, "prompt": "人均预算大概多少？"},
]

# 线上 match_action 原样
MATCH_ACTION = {
    "days_weight": 1.5,
    "budget_weight": 1,
    "days_tolerance": 1,
    "max_score": 2,
    "top_k": 3,
    "rule_weight": 0.5,
    "use_decision_model": True,
    "on_empty": "nearest",
}

ASK_PROMPT = "好的，我来帮你安排，请先补充以下信息"


@pytest.fixture()
def db():
    session = memory_session()
    seed_tenant(session)
    session.add(make_agent("agent_xianlin", name="仙林 AI G.O", owner_id="user_owner"))
    session.commit()
    return session


def _bind(db, scene: Scene, *, agent_id: str = "agent_xianlin", status: str = "active") -> None:
    """把场景绑到员工上（``AgentResourceBinding``）。

    Scene 上**没有** ``agent_id`` 列，场景归属完全靠这张绑定表。
    少了它 ``resolve_scene_hit`` / ``list_scene_chips`` 都查不到东西 ——
    不是被过滤掉了，是压根进不了候选集。
    """
    db.add(
        AgentResourceBinding(
            tenant_id=TENANT,
            agent_id=agent_id,
            resource_type="scene",
            resource_id=scene.id,
            status=status,
        )
    )
    db.commit()


def _make_ski_scene(
    db,
    *,
    match_action: dict | None = None,
    status: str = "published",
    name: str | None = None,
) -> Scene:
    # `(tenant_id, name)` 上有唯一约束：同一个 session 里建多个变体场景
    # （比如对比三种 on_empty）必须各自命名，否则插入就撞约束。
    scene = Scene(
        tenant_id=TENANT,
        name=name or SCENE_NAME,
        description="根据人数、天数、预算，从价目表里推荐合适的行程",
        scene_type="table_match",
        module_key=MODULE_KEY,
        status=status,
        slots_json=[dict(s) for s in SLOTS],
        match_action_json=dict(match_action if match_action is not None else MATCH_ACTION),
        trigger_json={
            "shortcut": True,
            "shortcut_label": "滑雪行程推荐",
            "keywords": ["滑雪", "雪场", "行程推荐", "滑雪行程"],
            "require_slots": True,
            "bypass_llm_router": True,
        },
        respond_action_json={
            "mode": "template",
            "template": "",
            "max_items": 3,
            "ask_prompt": ASK_PROMPT,
        },
        ui_config_json={
            "schema_version": 1,
            "params": {
                "primary_action_label": "选这个",
                "secondary_action_label": "看详情",
                "price_note": "/人 · 含住宿、雪票、教练、接送",
                "show_source_table": True,
            },
            "fallback_text": "找到了合适的行程，详情看上方的卡片",
            "form_subtitle": "",
        },
        shortcut_json={"label": "滑雪行程推荐", "icon": "🎿"},
    )
    db.add(scene)
    db.commit()
    db.refresh(scene)

    table = SceneTable(
        tenant_id=TENANT,
        scene_id=scene.id,
        order_index=0,
        name="滑雪套餐价目表",
        source_filename="滑雪套餐价目表.xlsx",
        columns_json=[dict(c) for c in COLUMNS],
        row_count=len(_SEED_ROWS),
        status="ready",
    )
    db.add(table)
    db.flush()
    for index, row in enumerate(_SEED_ROWS):
        db.add(
            SceneTableRow(
                tenant_id=TENANT,
                table_id=table.id,
                row_index=index,
                row_json=dict(row),
                norm_json={},
            )
        )
    db.commit()
    return scene


def _run(db, scene, slots):
    return run_scene_instance(
        db, tenant_id=TENANT, scene_id=scene.id, slots=slots, persist=False
    )


def _kinds(result) -> list[str]:
    return [b.kind for b in result.blocks]


def _result_titles(result) -> list[str]:
    titles: list[str] = []
    for block in result.blocks:
        if block.kind != "result":
            continue
        for item in block.data.get("items") or []:
            titles.append(str((item.get("values") or {}).get("计划内容") or ""))
    return titles


def _empty_block(result):
    return next((b for b in result.blocks if b.kind == "empty"), None)


def _empty_reason(result) -> str:
    block = _empty_block(result)
    return str((block.data or {}).get("reason") or "") if block else ""


def _funnel(result) -> dict[str, tuple[int, int]]:
    """{步骤 key: (from, to)}，方便断言「在哪一层被淘汰」。"""
    return {str(s.get("key")): (s.get("from"), s.get("to")) for s in (result.trace or [])}


# ===========================================================================
# 第一层：入口。点胶囊 → 只出表单，不许直接给结果
# ===========================================================================


def test_entry_without_slots_only_asks_with_form(db) -> None:
    """点胶囊进来（一个槽位都没填）只该问，不能拿空条件去查表。

    这是用户最先看到的界面。如果这里直接返回结果，等于拿「没填的条件」
    当默认值去筛 —— matcher 的注释专门写了「缺省不能当 0」，
    否则「没填人数」会变成「必须 0 人」，全表淘汰。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {})

    assert _kinds(result) == ["form"], f"只该有表单块，实际 {_kinds(result)}"
    assert result.status == "no_match"
    # 引导语是正文（气泡里、卡片上方），且是场景配的那句
    assert result.text == ASK_PROMPT
    form = next(b for b in result.blocks if b.kind == "form")
    # 三个槽位都要出现在表单里，缺一个用户就填不全。
    # 字段名用 `name`（见 core/sop/slots/form.py 的 build_slot_form 输出），
    # 不是 `key` —— 这里断言的是「前端渲染时按哪个键取值」，
    # 写错键名测试会误报「表单缺槽位」，而界面其实是对的。
    keys = {f.get("name") for f in (form.data.get("fields") or [])}
    assert keys == {"people", "days", "budget"}, f"表单缺槽位: {keys}"
    # 三个都必填，否则用户可以只填一半提交（matcher 会把缺省当 0 用）
    assert all(f.get("required") for f in form.data["fields"]), "槽位必须是必填"


@pytest.mark.parametrize(
    "partial",
    [
        {"people": 4},
        {"days": 5},
        {"budget": 3000},
        {"people": 4, "days": 5},
        {"people": 4, "budget": 3000},
        {"days": 5, "budget": 3000},
    ],
)
def test_any_missing_required_slot_still_only_asks(db, partial: dict) -> None:
    """三个槽位都 required，缺任何一个都只能继续问。

    这条锁的是「必填」语义：只要漏一个就查表，用户会拿到一个
    基于半套条件的结果，而且他还以为自己填全了。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, partial)

    assert _kinds(result) == ["form"], f"slots={partial} 不该出结果"
    assert result.text == ASK_PROMPT


# ===========================================================================
# 第二层：精确命中。填全了就该给结果
# ===========================================================================


def test_exact_match_returns_result_card_with_itinerary(db) -> None:
    """4人/5天/3000元 —— 应在「人数硬约束」和「天数 ±1」两层都活下来。

    表里 4 人行的天数有 5/6/3：5 天的 SK-1001 精确命中，
    6 天的 SK-1002 在 ±1 容差内，3 天的 SK-1003 超出容差被淘汰。
    所以期望是两个结果，且 SK-1001 排第一（预算 3000 完全对上）。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 4, "days": 5, "budget": 3000})

    assert result.status == "ok"
    assert _kinds(result) == ["result"], f"实际 {_kinds(result)}"

    titles = _result_titles(result)
    assert titles[0] == "经典雪山五日", f"排第一的应是精确命中的 SK-1001，实际 {titles}"
    assert "雪乡深度六日" in titles, "6 天在 ±1 容差内，应命中"
    assert "轻奢雪场三日" not in titles, "3 天超出 ±1 容差，必须被淘汰"
    assert "家庭亲子五日" not in titles, "6 人是人数硬约束，必须被淘汰"
    assert "周末双滑两日" not in titles, "2 人在人数层就被淘汰"

    # 漏斗：5 行 → 人数层留 3 → 天数层留 2
    funnel = _funnel(result)
    assert funnel["people"] == (5, 3), f"人数层应 5→3，实际 {funnel.get('people')}"
    assert funnel["days"] == (3, 2), f"天数层应 3→2，实际 {funnel.get('days')}"
    assert funnel["topk"] == (2, 2)


def test_six_people_hits_family_package_only(db) -> None:
    """6人/5天/2800元 —— 只有 SK-1004 是 6 人，人数层就只剩 1 行。

    这条验的是「人数硬约束是双向的」：4 人需求拿不到 6 人方案，
    6 人需求也不该拿到 4 人方案。表里备注写的就是这个意思。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 6, "days": 5, "budget": 2800})

    assert result.status == "ok"
    assert _result_titles(result) == ["家庭亲子五日"]
    assert _funnel(result)["people"] == (5, 1)


def test_two_people_hits_weekend_package_only(db) -> None:
    """2人/2天/980元 —— 表里最便宜也最「不合群」的那行，但条件完全对上时该命中。

    它验的是「便宜不占便宜」：SK-1005 是 980 元，如果逻辑被预算带偏，
    哪怕条件不符也会被推出来。反过来，条件相符时也不能因为便宜而被压低。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 2, "days": 2, "budget": 980})

    assert result.status == "ok"
    assert _result_titles(result) == ["周末双滑两日"]


# ===========================================================================
# 第三层：天数容差边界（表里备注明确要求验的）
# ===========================================================================


def test_days_tolerance_boundary_plus_one_still_hits(db) -> None:
    """5 天需求 +1 天（6 天）应命中 —— 表里 SK-1002 的备注原文要求。

    days_tolerance=1，所以 |5-6|=1 <= 1 通过。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 4, "days": 5, "budget": 3600})

    titles = _result_titles(result)
    assert "雪乡深度六日" in titles, f"6 天在容差内应命中，实际 {titles}"


def test_days_tolerance_boundary_minus_one_still_hits(db) -> None:
    """6 天需求 -1 天（5 天）也应命中 —— 容差是双向的。

    只验 +1 不验 -1 会漏掉「写成 <= 但符号写反」这类错误。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 4, "days": 6, "budget": 3600})

    titles = _result_titles(result)
    assert "经典雪山五日" in titles, f"5 天在容差内应命中，实际 {titles}"
    # 6 天是精确命中，应排第一
    assert titles[0] == "雪乡深度六日", f"精确命中的应排第一，实际 {titles}"


def test_days_outside_tolerance_is_dropped_at_days_layer(db) -> None:
    """5 天需求 -2 天（3 天）必须在天数层被淘汰 —— SK-1003 的备注原文要求。

    这条与上面两条配合，才完整锁住容差边界：
    ±1 内通过、±2 淘汰。只测「通过」不测「淘汰」，容差写成 ±99 也能过测试。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 4, "days": 5, "budget": 4800})

    titles = _result_titles(result)
    assert "轻奢雪场三日" not in titles, f"3 天超出 ±1 容差，不该命中，实际 {titles}"
    # 3 天那行被淘汰后，剩 5 天和 6 天两行
    assert _funnel(result)["days"] == (3, 2)


# ===========================================================================
# 第四层：空结果。这是用户报障的场景（3 人没有对应方案）
# ===========================================================================


def test_three_people_yields_empty_at_people_layer(db) -> None:
    """3人/4天/4000元 —— 表里没有 3 人，必然全灭。

    **这就是用户截图里那次**：他填 3 人，系统说「表里没有 3 人的方案」，
    他以为是 bug。实际是数据里确实没有 3 人套餐。这条测试把
    「数据缺 → 正确报空」这个行为固定下来，以后有人改坏会被顶出来。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 3, "days": 4, "budget": 4000})

    assert result.status == "no_match"
    assert "result" not in _kinds(result)
    assert _kinds(result) == ["empty"]

    # 漏斗：人数层直接 5→0
    assert _funnel(result)["people"] == (5, 0)

    reason = _empty_reason(result)
    assert "3" in reason and "人" in reason
    assert "人数" in reason, f"应指明卡在人数层，实际 {reason!r}"


def test_empty_text_and_card_reason_do_not_repeat(db) -> None:
    """空结果时正文与卡片不许说同一句话（用户报过「同一句出现两遍」）。

    正文（result.text）与卡片内的 data.reason 是**两个不同渠道**：
      - 正文：进聊天气泡，非 UI 渠道（企微/短信）只认它；
      - reason：卡片内、紧挨漏斗数字，负责量化「差几行」。
    两者都要说清「卡在哪层」，但**不许逐字相同**。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 3, "days": 4, "budget": 4000})

    text = (result.text or "").strip()
    reason = _empty_reason(result).strip()

    assert text, "正文不能为空（企微/短信只吃 text）"
    assert reason, "卡片 reason 不能为空（漏斗需要它做锚点）"
    assert text != reason, f"正文与卡片在重复同一句: {text!r}"

    # blocks 里不许再出现 text 块 —— 那是重复的第三个来源
    assert "text" not in _kinds(result), f"blocks 不该有 text 块: {_kinds(result)}"
    # 两处都要点明「人数」这层
    assert "人数" in text
    assert "人数" in reason


@pytest.mark.parametrize("people", [1, 3, 5, 7, 8, 99])
def test_people_values_absent_from_table_report_empty_cleanly(db, people: int) -> None:
    """表里只有 2/4/6 人，其它值都该干净地报空，不能崩、不能返回错行。

    边界值 1 和 99 一起测：1 容易命中「小于所有值」的兜底逻辑，
    99 容易命中「大于所有值」的，两端都可能被写成「取最接近的行」而错命中。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": people, "days": 5, "budget": 3000})

    assert result.status == "no_match", f"{people} 人不该有命中"
    assert _result_titles(result) == []
    assert _funnel(result)["people"] == (5, 0)
    assert result.text.strip(), "即使报空，正文也不能空"


# ===========================================================================
# 第五层：on_empty="nearest"。配置了这个策略就要真的给近似结果
# ===========================================================================


def test_on_empty_nearest_provides_approximation_but_not_as_hit(db) -> None:
    """`on_empty="nearest"` 时，空结果应附带最接近的一批，但**不算命中**。

    线上 `match_action_json` 配了这个值，而代码以前**完全没读它**（死配置）。
    现在接上了：空结果的卡片里会多一个 `nearest` 字段。

    关键是「不是命中」这条语义要守住：
      - `status` 仍是 no_match
      - `hits` 仍为空
      - 正文必须说清「这些不是符合的」
    否则用户会拿着一个不满足条件的方案去下单。
    """
    scene = _make_ski_scene(db)
    # 预算极低 → 分数超闸门被淘汰，但打分环节进过，所以 nearest 有数据
    result = _run(db, scene, {"people": 4, "days": 5, "budget": 100})

    assert result.status == "no_match", "有 nearest 也仍是 no_match"

    block = _empty_block(result)
    assert block is not None
    nearest = (block.data or {}).get("nearest") or []
    assert nearest, f"配了 on_empty=nearest 就该有近似结果，实际为空"

    # 近似结果不能混进 result 块
    assert "result" not in _kinds(result), "近似结果不许冒充命中卡"

    # 正文要交代「不是完全符合」
    assert "不是完全符合" in result.text or "最接近" in result.text, (
        f"正文应说明这些不是符合的，实际 {result.text!r}"
    )


def test_on_empty_none_disables_approximation(db) -> None:
    """`on_empty="none"` 时不该给近似结果 —— 策略要真的可关。

    只测 nearest 生效、不测 none 关闭，就无法区分「策略生效」和
    「代码无条件都给近似结果」。
    """
    action = dict(MATCH_ACTION, on_empty="none")
    scene = _make_ski_scene(db, match_action=action)
    result = _run(db, scene, {"people": 4, "days": 5, "budget": 100})

    block = _empty_block(result)
    assert block is not None
    assert not (block.data or {}).get("nearest"), "on_empty=none 不该有近似结果"
    assert "最接近" not in result.text
    # 连建议按钮也不给：这一档的语义是「只说明没有结果」
    assert not (block.data or {}).get("suggestions"), "on_empty=none 不该给放宽建议"
    assert (block.data or {}).get("on_empty") == "none", "模式要透出给前端"


def test_on_empty_clarify_asks_instead_of_listing(db) -> None:
    """`on_empty="clarify"` 要**反问**，而不是列近似结果。

    三档里这一档最容易被实现成 nearest 的马甲：都不给命中、都带建议按钮，
    只有正文那一句不同。所以这里逐项验「区别真的存在」：
      - 不给 nearest（不列近似项）
      - 正文是问句（以「？」结尾），且点名了放宽方向
      - 建议里多一条「就看最接近的」退路
    """
    action = dict(MATCH_ACTION, on_empty="clarify")
    scene = _make_ski_scene(db, match_action=action)
    result = _run(db, scene, {"people": 4, "days": 5, "budget": 100})

    block = _empty_block(result)
    assert block is not None
    data = block.data or {}
    assert data.get("on_empty") == "clarify"
    assert not data.get("nearest"), "clarify 不该列近似项（那是 nearest 的活）"
    assert result.text.rstrip().endswith("？"), f"clarify 的正文应是问句，实际 {result.text!r}"
    labels = [s.get("label") for s in (data.get("suggestions") or [])]
    assert "就看最接近的" in labels, f"clarify 应留一条「不放宽」的退路，实际 {labels}"


def test_all_on_empty_modes_differ_from_each_other(db) -> None:
    """三档必须真的产生**三种**结果，不能有两档是同一个东西。

    这是「配置能不能信」的底线：如果 nearest 和 clarify 渲染出的正文一致，
    用户换了选项却看不出变化，就会认定「选了没用」—— 正是这一轮的投诉原话。
    """
    texts: dict[str, str] = {}
    for mode in ("nearest", "clarify", "none"):
        scene = _make_ski_scene(
            db,
            match_action=dict(MATCH_ACTION, on_empty=mode),
            name=f"{SCENE_NAME}-{mode}",
        )
        result = _run(db, scene, {"people": 4, "days": 5, "budget": 100})
        texts[mode] = result.text

    assert len(set(texts.values())) == 3, f"三档正文必须互不相同，实际 {texts}"
    # nearest 要提到「最接近」，clarify 要是问句，none 两者都不该有
    assert "最接近" in texts["nearest"]
    assert "最接近" not in texts["none"] and "？" not in texts["none"]
    assert texts["clarify"].rstrip().endswith("？")


def test_legacy_nothing_alias_is_treated_as_none(db) -> None:
    """老配置里的 `on_empty="nothing"` 要按 `none` 执行，不是回落 nearest。

    前端下拉曾经写的是 `nothing`，后端白名单是 `none`，于是「只说明没有结果」
    被静默当成「给最接近的」。存量场景的库里就是 `nothing`，别名让它们
    不用迁移也能正确生效。
    """
    from app.scenes.matcher import MatchAction

    action = MatchAction.from_json({"on_empty": "nothing"})
    assert action.on_empty == "none", f"nothing 应归一到 none，实际 {action.on_empty}"

    scene = _make_ski_scene(db, match_action=dict(MATCH_ACTION, on_empty="nothing"))
    result = _run(db, scene, {"people": 4, "days": 5, "budget": 100})
    block = _empty_block(result)
    assert block is not None
    assert not (block.data or {}).get("nearest"), "老值 nothing 也不该给近似结果"


# ===========================================================================
# 第六层：非法输入。不能静默吞掉，要明确告诉用户
# ===========================================================================


@pytest.mark.parametrize("budget", [0, -100, -1])
def test_non_positive_budget_is_reported_not_silent(db, budget: int) -> None:
    """预算填 0 或负数时，不能静默按天数排序然后装作正常。

    以前的行为：matcher 正确置 `invalid_budget=True` 并跳过预算计算，
    但**结果里一个字都不提**，用户看到「为你找到以下方案」会以为
    预算 0 元也是有效输入。这条测试锁住「必须说出来」。

    同时也要验结果本身仍然可用（不该因为预算非法就整个报错）——
    用户的意图是「先别管预算，看看有什么」，给他结果比报错好，
    但必须告诉他预算没生效。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 4, "days": 5, "budget": budget})

    assert "预算" in result.text, f"必须提示预算未生效，实际 {result.text!r}"
    assert "没有按预算" in result.text or "不是正数" in result.text, (
        f"提示要具体，实际 {result.text!r}"
    )

    # 结果仍然要给出（降级为只按天数排序），不能因为预算非法就崩
    assert result.status == "ok"
    assert _result_titles(result), "预算非法时应仍按天数给出结果"


def test_invalid_budget_flag_reaches_detail(db) -> None:
    """`invalid_budget` 要透到 detail，试跑面板靠它画提示。"""
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 4, "days": 5, "budget": 0})

    assert (result.detail or {}).get("invalid_budget") is True


# ===========================================================================
# 第七层：人数容差（新增能力，默认关闭）
# ===========================================================================


def test_people_tolerance_defaults_to_strict(db) -> None:
    """不配 `people_tolerance` 时保持严格 —— 4 人需求拿不到 6 人方案。

    这是历史行为，也是业务常识。默认值改成非 0 会让所有存量场景
    突然开始返回「人数不对」的推荐。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 5, "days": 5, "budget": 3000})

    assert result.status == "no_match", "默认严格，5 人（表里没有）应报空"
    assert (result.detail or {}).get("people_widened", 0) == 0


def test_people_tolerance_widens_and_declares_it(db) -> None:
    """配了 `people_tolerance=1` 时，5 人需求可命中 4 人或 6 人的方案 ——
    但必须在正文里声明「人数是按容差放宽的」。

    这条是「放宽必须有交代」的核心：静默放宽等于骗用户。
    """
    action = dict(MATCH_ACTION, people_tolerance=1)
    scene = _make_ski_scene(db, match_action=action)
    result = _run(db, scene, {"people": 5, "days": 5, "budget": 2800})

    assert result.status == "ok", "容差 ±1 应能命中 4/6 人"
    titles = _result_titles(result)
    assert titles, f"应有命中，实际 {titles}"
    # 4 人和 6 人都该在候选里（一个 -1、一个 +1）
    assert any(t in titles for t in ("经典雪山五日", "家庭亲子五日")), titles

    widened = (result.detail or {}).get("people_widened", 0)
    assert widened > 0, "应记录被容差放宽的行数"
    assert "容差" in result.text, f"正文必须声明放宽，实际 {result.text!r}"


def test_people_tolerance_zero_behaves_like_strict(db) -> None:
    """显式配 0 与不配等价 —— 避免「配了 0 却意外放宽」。"""
    action = dict(MATCH_ACTION, people_tolerance=0)
    scene = _make_ski_scene(db, match_action=action)
    result = _run(db, scene, {"people": 5, "days": 5, "budget": 3000})

    assert result.status == "no_match"
    assert (result.detail or {}).get("people_widened", 0) == 0


def test_negative_people_tolerance_is_clamped_to_strict(db) -> None:
    """负数容差要钳到 0，不能变成「abs(diff) <= -1 恒假」导致全灭且无解释。"""
    action = dict(MATCH_ACTION, people_tolerance=-5)
    scene = _make_ski_scene(db, match_action=action)
    # 4 人精确命中：若负数容差没被钳住，这条也会被淘汰
    result = _run(db, scene, {"people": 4, "days": 5, "budget": 3000})

    assert result.status == "ok", "负数容差应被钳为 0（严格），不该全灭"
    assert (result.detail or {}).get("people_widened", 0) == 0


# ===========================================================================
# 第八层：配置正确性。线上那套配置要能在本 fixture 上完整跑通
# ===========================================================================


def test_online_config_round_trips_through_matcher(db) -> None:
    """线上 `match_action_json` 的每个字段都要被 matcher 认出来。

    这条防的是「配置键名写错但没人发现」：matcher 用 `_as_float(data.get(...))`
    读配置，键名拼错会静默回落默认值，界面上看起来一切正常，
    实际配的容差/权重全没生效。
    """
    from app.scenes.matcher import MatchAction

    action = MatchAction.from_json(MATCH_ACTION)

    assert action.days_weight == 1.5
    assert action.budget_weight == 1.0
    assert action.days_tolerance == 1
    assert action.max_score == 2.0
    assert action.top_k == 3
    assert action.rule_weight == 0.5
    assert action.use_decision_model is True
    assert action.on_empty == "nearest"
    # 线上没配 people_tolerance，应回落默认 0（严格）
    assert action.people_tolerance == 0


def test_unknown_on_empty_value_falls_back_to_default(db) -> None:
    """`on_empty` 配了不认识的值要回落默认，不能让脏配置漏到运行期。"""
    from app.scenes.matcher import MatchAction

    action = MatchAction.from_json({"on_empty": "whatever"})
    assert action.on_empty == "nearest", "未知取值应回落默认"


def test_unpublished_scene_is_not_reachable_via_chips(db) -> None:
    """草稿态场景不该出现在聊天入口 —— 用户点不到，链路就不该从这开始。

    ``resolve_scene_hit`` 返回单个 ``Scene | None``（不是列表），
    且参数是 keyword-only —— 按位置传会直接 TypeError。
    """
    from app.scene_modules.runtime import resolve_scene_hit

    scene = _make_ski_scene(db, status="draft")
    _bind(db, scene)
    hit = resolve_scene_hit(
        db,
        tenant_id=TENANT,
        agent_id="agent_xianlin",
        message="滑雪行程推荐",
    )
    assert hit is None or hit.id != scene.id, f"草稿场景不该出现在入口: {hit}"


def test_published_scene_is_reachable_via_chips(db) -> None:
    """对照组：同一个场景改成 published 后，关键词必须能命中。

    没有这条，上面那条「draft 命中不了」可能只是因为绑定写错、
    或关键词压根没配 —— 那种情况下测试会通过，但功能是坏的。
    """
    from app.scene_modules.chips import list_scene_chips
    from app.scene_modules.runtime import resolve_scene_hit

    scene = _make_ski_scene(db)  # 默认 published
    _bind(db, scene)

    hit = resolve_scene_hit(
        db,
        tenant_id=TENANT,
        agent_id="agent_xianlin",
        message="滑雪行程推荐",
    )
    assert hit is not None and hit.id == scene.id, "配了关键词却命中不了"

    chips = list_scene_chips(db, tenant_id=TENANT, agent_id="agent_xianlin")
    labels = [c.label for c in chips]
    assert "滑雪行程推荐" in labels, f"胶囊缺这个场景: {labels}"
    # 胶囊的 send_text 必须能反过来命中自己（点一下就进场景）
    chip = next(c for c in chips if c.label == "滑雪行程推荐")
    rehit = resolve_scene_hit(
        db, tenant_id=TENANT, agent_id="agent_xianlin", message=chip.send_text
    )
    assert rehit is not None and rehit.id == scene.id, "点胶囊反而进不去场景"


# ===========================================================================
# 第九层：整链路的形状不变量
# ===========================================================================


def test_every_outcome_has_non_empty_text(db) -> None:
    """不管走哪条分支，`result.text` 都不能为空。

    这是最容易被忽略却后果最重的一条：企微/微信/短信只吃 text，
    text 为空 = 用户收到一条空白消息，且没有任何错误提示。
    """
    scene = _make_ski_scene(db)
    cases = [
        {},                                              # 问条件
        {"people": 4, "days": 5, "budget": 3000},        # 命中
        {"people": 3, "days": 4, "budget": 4000},        # 人数缺 → 空
        {"people": 4, "days": 5, "budget": 0},           # 预算非法
        {"people": 4, "days": 20, "budget": 3000},       # 天数超容差 → 空
    ]
    for slots in cases:
        result = _run(db, scene, slots)
        assert result.text and result.text.strip(), f"slots={slots} 的正文为空"
        assert result.status in ("ok", "no_match"), f"slots={slots} 状态异常"


def test_blocks_never_carry_duplicate_copy_of_text(db) -> None:
    """任何分支下，`text` 的内容都不该再作为一个 text 块出现在 blocks 里。

    这是引导语那次踩了三遍的坑的通用护栏：一句话只发一次。
    空结果曾经同时在 text_out、text 块、data.reason 三处发同一个字符串。
    """
    scene = _make_ski_scene(db)
    for slots in (
        {"people": 3, "days": 4, "budget": 4000},
        {"people": 4, "days": 5, "budget": 100},
    ):
        result = _run(db, scene, slots)
        text_blocks = [
            str((b.data or {}).get("content") or "")
            for b in result.blocks
            if b.kind == "text"
        ]
        for content in text_blocks:
            assert content.strip() != (result.text or "").strip(), (
                f"text 与 text 块内容重复: {content!r}"
            )

# ===========================================================================
# 第十层：空结果卡的两处体验修复（2026-11-26 用户截图反馈）
# ===========================================================================


def _empty_data(result):
    block = _empty_block(result)
    return dict(block.data or {}) if block else {}


def test_empty_card_does_not_ship_funnel_by_default(db) -> None:
    """空卡默认不下发 `steps` / `funnel`（用户：「这些文字没必要给用户看」）。

    卡上那三行 `5 → 读表 / 5 → 人数对上 / 0 → 天数对上` 被用户点名删掉。
    理由成立：`reason` 已经说了卡在哪层 + 下一步怎么办，漏斗是同一件事的
    另一种写法；而「5」是台账行数，用户根本不关心。

    ⚠️ 但 `detail.steps` / `result.trace` **必须仍然完整** —— 试跑面板
    （`SceneEditor` 的 RunPanel）与排障靠它看每层淘汰了多少。
    这就是「管理员要漏斗，用户要一句话」的落点，两处不一致是**有意的**。
    """
    scene = _make_ski_scene(db)
    result = _run(db, scene, {"people": 3, "days": 4, "budget": 4000})

    data = _empty_data(result)
    assert "steps" not in data, "空卡不该默认下发 steps"
    assert "funnel" not in data, "空卡不该默认下发 funnel"

    # 反向护栏：完整漏斗仍然在 detail 与 trace 里，没有被误删
    assert len(result.trace) == 5, f"trace 应保留完整 5 步，实际 {len(result.trace)}"
    detail_steps = result.detail.get("steps") or []
    assert len(detail_steps) == 5, f"detail.steps 应保留完整 5 步，实际 {len(detail_steps)}"


def test_empty_card_ships_current_slots_for_rerun(db) -> None:
    """空卡必须带上本轮**完整槽位**，否则建议按钮会把条件丢掉。

    按钮只改一个槽（`{"days": 6}`）。若前端只发这一个键，新帧的
    `slots_json` 是空的，人数与预算会被抹成空值 —— 用户点一下
    「按 6 天找」，实际是在用「6 天 + 无人数 + 无预算」重新查表。
    """
    scene = _make_ski_scene(db)
    slots = {"people": 3, "days": 4, "budget": 4000}
    data = _empty_data(_run(db, scene, slots))

    assert data.get("slots") == slots, f"应原样下发本轮槽位，实际 {data.get('slots')}"
    # 中文标签一起下发：用户气泡里不能出现 `people：3`
    labels = data.get("slot_labels") or {}
    assert labels.get("people") == "人数", f"缺人数中文标签: {labels}"
    assert labels.get("days") == "天数", f"缺天数中文标签: {labels}"


def test_empty_suggestions_carry_hittable_slot_patch(db) -> None:
    """每颗「放宽」按钮都带**具体的、点下去一定能命中**的槽位调整。

    这是线上真实故障的回归锁：按钮原先只发一句「天数可以再灵活一点」，
    那句话进了普通对话、没有触发关键词，后端落回 `standard` 模式，
    一个方案都没重算。现在按钮必须给出 `patch`，让前端改槽重跑。

    **「一定能命中」是本条测试的核心**。它逼出过一个真 bug：只改人数
    不够 —— 表里 4 人方案的天数是 5/6，用户填 4 人 4 天时把人数从 3
    改成 4，天数层照样归零，点下去还是空。所以 `patch` 允许含多个槽，
    由 `_rerun_patch` 从近似行里补齐后面的层。
    """
    scene = _make_ski_scene(db, match_action={"days_tolerance": 0, "people_tolerance": 0})

    # 卡人数（3 人 / 4 天）：人数改成 4 之后天数 4 仍对不上 → patch 必须连天数一起改
    slots = {"people": 3, "days": 4, "budget": 4000}
    data = _empty_data(_run(db, scene, slots))
    people_btn = next(
        (s for s in data.get("suggestions") or [] if (s.get("patch") or {}).get("people")),
        None,
    )
    assert people_btn, f"卡人数时应有改人数的按钮: {data.get('suggestions')}"
    assert people_btn["patch"]["people"] == 4, f"最近的人数应是 4: {people_btn['patch']}"
    # 标签要说清会改成什么，用户点之前就能判断
    assert "4" in str(people_btn["label"]), f"标签应带具体值: {people_btn['label']}"

    # 点下去**真的能出结果** —— 这是「可命中」的实证，不是推测
    rerun_slots = {**slots, **people_btn["patch"]}
    assert "result" in _kinds(_run(db, scene, rerun_slots)), (
        f"按建议值 {rerun_slots} 重跑必须真的有结果（否则按钮等于骗人）"
    )

    # 卡天数（4 人 / 8 天）：4 人方案的天数是 5/6，最近的是 6
    slots = {"people": 4, "days": 8, "budget": 3000}
    data = _empty_data(_run(db, scene, slots))
    days_btn = next(
        (s for s in data.get("suggestions") or [] if (s.get("patch") or {}).get("days")),
        None,
    )
    assert days_btn, f"卡天数时应有改天数的按钮: {data.get('suggestions')}"
    assert days_btn["patch"]["days"] == 6, f"最近的天数应是 6: {days_btn['patch']}"
    rerun_slots = {**slots, **days_btn["patch"]}
    assert "result" in _kinds(_run(db, scene, rerun_slots)), (
        f"按建议值 {rerun_slots} 重跑必须真的有结果"
    )


def test_budget_button_not_offered_when_people_layer_is_zero(db) -> None:
    """卡在人数层时**不单独给**「预算再高一点」按钮 —— 那是错误引导。

    原实现写死两颗按钮，卡人数时也给预算按钮：用户调高预算依然 0 人，
    会以为系统在乱指路。现在按「漏斗第一个归零的位置」决定给哪颗。

    ⚠️ 注意区分两件事：
      - **单独的预算按钮**：卡人数时不出现（用户点它改变不了任何事）；
      - **patch 里补 budget**：允许，而且必要 —— 人数和天数对上后，
        预算太低仍会在闸门被淘汰（9 人 / 1 天 / 100 元 的真实案例）。
        那是「让这颗按钮真的能出结果」的一部分，不是「给了一颗预算按钮」。
    """
    scene = _make_ski_scene(db)
    data = _empty_data(_run(db, scene, {"people": 3, "days": 4, "budget": 4000}))
    suggestions = data.get("suggestions") or []

    # 不许出现「只改预算」的按钮（patch 只有 budget 一个键）
    budget_only = [
        s for s in suggestions if set((s.get("patch") or {}).keys()) == {"budget"}
    ]
    assert not budget_only, f"人数层就归零了，不该给纯预算按钮: {budget_only}"

    # 但必须有改人数的按钮（那才是真正的出路）
    people_buttons = [
        s for s in suggestions if (s.get("patch") or {}).get("people") is not None
    ]
    assert people_buttons, f"应给改人数的按钮: {suggestions}"
