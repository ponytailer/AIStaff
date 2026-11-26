"""`tool_submit` 通道：四步通用模板的端到端行为。

锁的是这条链路（`app/scene_modules/channels._run_tool_submit`）：

```
1. 意图匹配触发      → resolve_scene_hit（本文件测"通道被调用后的行为"）
2. 发表单收信息      → 缺必填槽位时只发 form，**绝不调接口**
3. 调接口            → ToolExecutor 调 scene.tool_api_json.tool_name
4. 回复用户          → result 块（回执）+ text
```

**不 mock 通道内部，只 mock 出站 HTTP**（`httpx.MockTransport`）。理由：这个通道
最容易坏的正是「参数映射错、返回值取错、失败文案错」这几处，而它们全在
「槽位 → 参数 → 响应 → 文案」这条数据流上。把 ToolExecutor 也替掉就什么都没测。
"""

from __future__ import annotations

import httpx
import pytest

from dispatch_fixtures import TENANT, make_agent, memory_session, seed_tenant

from app.db.models import AgentResourceBinding, Scene, Tool
from app.scene_modules.channels import _submission_params, _tool_reply_text
from app.scene_modules.runtime import run_scene_instance
from app.tools import tool_executor as tool_executor_module

#: `httpx.Client` 的原始引用（模块导入时抓，避免被上一个用例的替身污染）。
_REAL_CLIENT = httpx.Client

DELIVERY_SLOTS = [
    {"key": "room_no", "label": "房间号", "type": "text", "required": True},
    {"key": "item", "label": "物品", "type": "text", "required": True},
    {"key": "quantity", "label": "数量", "type": "number", "required": False, "default": 1},
]

DELIVERY_TOOL = {
    "name": "room.delivery_submit",
    "display_name": "客房送物受理",
    "bucket": "客房服务",
    "method": "POST",
    "url": "https://mock.local/api/mock/room/delivery-submit",
    "headers_json": {},
    "auth_json": {},
    "input_schema": {
        "type": "object",
        "properties": {
            "room_no": {"type": "string"},
            "item": {"type": "string"},
            "quantity": {"type": "integer"},
        },
        "required": ["room_no", "item"],
    },
    "output_schema": {"type": "object", "properties": {}},
    "allowed_skills_json": [],
    "enabled": True,
}

DELIVERY_RESPONSE = {
    "accepted": True,
    "order_no": "RD20261126001",
    "room_no": "8306",
    "item": "矿泉水",
    "quantity": 2,
    "eta_minutes": 20,
    "status": "accepted",
    "message": "已受理，客房部会在 20 分钟内送达 8306 房。",
}


@pytest.fixture()
def db():
    session = memory_session()
    seed_tenant(session)
    session.add(make_agent("agent_xianlin", name="仙林 AI G.O", owner_id="user_owner"))
    session.add(Tool(tenant_id=TENANT, **DELIVERY_TOOL))
    session.commit()
    return session


def _patch_http(monkeypatch, handler) -> list[httpx.Request]:
    """替掉 `tool_executor` 模块里的 `httpx.Client`，并记录出站请求。"""
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(
        tool_executor_module.httpx,
        "Client",
        lambda **kwargs: _REAL_CLIENT(
            transport=httpx.MockTransport(wrapped), timeout=kwargs.get("timeout")
        ),
    )
    return seen


def _ok_response(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=DELIVERY_RESPONSE)


def _make_scene(
    db,
    *,
    tool_api: dict | None = None,
    slots: list[dict] | None = None,
    name: str = "客房送物",
) -> Scene:
    scene = Scene(
        tenant_id=TENANT,
        name=name,
        description="住客提交客房送物申请",
        scene_type="tool_submit",
        module_key="generic.tool_submit",
        status="published",
        slots_json=[dict(s) for s in (slots if slots is not None else DELIVERY_SLOTS)],
        tool_api_json={
            "tool_name": "room.delivery_submit",
            **(tool_api if tool_api is not None else {}),
        },
        trigger_json={
            "shortcut": True,
            "shortcut_label": "客房送物",
            "keywords": ["送物", "送水", "客房送物"],
            "require_slots": True,
            "bypass_llm_router": True,
        },
        respond_action_json={"ask_prompt": "请告诉我房间号和需要送的物品"},
        fallback_text="已为你提交客房送物申请",
    )
    db.add(scene)
    db.commit()
    db.refresh(scene)
    return scene


def _bind(db, scene: Scene, *, agent_id: str = "agent_xianlin") -> None:
    db.add(
        AgentResourceBinding(
            tenant_id=TENANT,
            agent_id=agent_id,
            resource_type="scene",
            resource_id=scene.id,
            status="active",
        )
    )
    db.commit()


def _run(db, scene: Scene, slots: dict, *, agent_id: str | None = None):
    """跑一次场景。``agent_id=None`` 模拟试跑面板（无员工语境）。"""
    return run_scene_instance(
        db,
        tenant_id=TENANT,
        scene_id=scene.id,
        slots=slots,
        persist=False,
        agent_id=agent_id,
    )


def _kinds(result) -> list[str]:
    return [b.kind for b in result.blocks]


# ============================================================
# 第 1 层：缺槽位 → 只发表单，绝不调接口
# ============================================================


def test_missing_slots_ships_form_and_never_calls_api(db, monkeypatch):
    """缺必填槽位时**一次请求都不能发**。

    这条是硬要求而不是优化：槽位不全时调出去就是一条脏单（房号为空也照样
    送到客房部），而用户此刻还没确认。所以顺序必须是「先问、后调」。
    """
    seen = _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)

    result = _run(db, scene, {"room_no": "8306"})  # 缺 item

    assert seen == [], "缺槽位时不该发出任何请求"
    assert "form" in _kinds(result)
    assert result.text == "请告诉我房间号和需要送的物品"


def test_form_block_carries_scene_slot_metadata(db, monkeypatch):
    """表单字段来自 `slots_json`，且类型是场景声明的而不是猜的。"""
    _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)

    result = _run(db, scene, {})
    form = next(b for b in result.blocks if b.kind == "form")
    names = [f["name"] for f in form.data["fields"]]

    assert names == ["room_no", "item"]
    by_name = {f["name"]: f for f in form.data["fields"]}
    # `quantity` 不是必填，所以不在缺槽列表里
    assert "quantity" not in by_name
    assert by_name["room_no"]["type"] == "text"


# ============================================================
# 第 2 层：槽位齐全 → 调接口 → 回执
# ============================================================


def test_full_slots_calls_api_with_mapped_params(db, monkeypatch):
    seen = _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2})

    assert len(seen) == 1
    assert str(seen[0].url) == "https://mock.local/api/mock/room/delivery-submit"
    assert seen[0].method == "POST"
    import json

    body = json.loads(seen[0].content)
    assert body == {"room_no": "8306", "item": "矿泉水", "quantity": 2}
    assert "result" in _kinds(result)
    assert result.status == "ok"


def test_success_reply_uses_response_message_when_template_absent(db, monkeypatch):
    """没配 `reply_template` 时拿响应里的 `message` 当正文。

    为什么这个兜底重要：管理员建场景常常先看效果，模板留空。此时正文应该是
    接口自己说的那句话（「已受理，20 分钟内送达」），而不是引擎拼的
    「操作成功」—— 后者不含任何用户关心的信息。
    """
    _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2})

    assert result.text == DELIVERY_RESPONSE["message"]


def test_reply_template_renders_response_and_slot_values(db, monkeypatch):
    """模板里既能取响应字段，也能取槽位值（真实文案常常两边都要）。"""
    _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(
        db,
        tool_api={
            "reply_template": "{{room_no}} 房的 {{quantity}} 份{{item}}已受理，单号 {{order_no}}",
        },
    )

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2})

    assert result.text == "8306 房的 2 份矿泉水已受理，单号 RD20261126001"


def test_result_block_flattens_receipt_into_values(db, monkeypatch):
    """回执塞进 `result` 块，形状与命中行同形（复用前端 `resultHits()`）。"""
    _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2})
    block = next(b for b in result.blocks if b.kind == "result")
    values = block.data["items"][0]["values"]

    assert values["order_no"] == "RD20261126001"
    assert values["eta_minutes"] == 20
    # 嵌套对象不进回执（前端会显示成 [object Object]）
    assert all(not isinstance(v, (dict, list)) for v in values.values())


def test_receipt_drops_protocol_fields(db, monkeypatch):
    """接口自检字段不进回执卡片。

    `accepted` / `status` 回答的是「这次调用成功了吗」—— 那是程序的问题，
    而回执能画出来本身就说明成功了。`message` 更特殊：它已经被
    `reply_template` 说成了正文，卡片里再来一遍就是同一句话说两次。

    不剔的后果在界面上是可见的：用户会看到
    `accepted 是`、`status accepted`、`created_at 2026-11-26T07:29:09`
    三行噪音，真正有用的「单号」「预计送达」被挤到后面。
    """
    _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2})
    block = next(b for b in result.blocks if b.kind == "result")
    values = block.data["items"][0]["values"]

    for noise in ("accepted", "status", "message"):
        assert noise not in values, f"协议字段 {noise} 不该出现在回执里"


def test_receipt_labels_come_from_scene_slots(db, monkeypatch):
    """字段中文名取自场景的槽位 label（管理员已经填过，不该再维护一份字典）。

    给 `room_no` 一份「房间号」，前端就不必把英文 key 直接摆给用户看。
    对不上的字段（接口自己加的 `eta_minutes`）不给 label，前端退回显示原 key ——
    不好看，但能看出是哪个字段，比编一个错的中文名强。
    """
    _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2})
    block = next(b for b in result.blocks if b.kind == "result")

    assert block.data["labels"]["room_no"] == "房间号"
    assert block.data["labels"]["item"] == "物品"
    assert block.data["labels"]["quantity"] == "数量"
    # 接口独有字段没有中文名 —— 这是正常的，不是漏配
    assert "eta_minutes" not in block.data["labels"]


def test_receipt_labels_accept_manual_field_labels(db, monkeypatch):
    """纯响应字段（场景没有对应槽位）靠 `tool_api_json.field_labels` 给中文名。

    `eta_minutes` 只出现在响应里，槽位里没有对应项 —— 没有它，界面上就是
    英文 key。而且手写的要**优先于**槽位 label（手写的目的就是改写显示名，
    被槽位覆盖就永远改不动）。
    """
    _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(
        db,
        tool_api={
            "tool_name": "room.delivery_submit",
            "field_labels": {"eta_minutes": "预计送达", "room_no": "客房号"},
        },
    )

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2})
    block = next(b for b in result.blocks if b.kind == "result")

    assert block.data["labels"]["eta_minutes"] == "预计送达"
    # 手写值覆盖槽位 label（「房间号」→「客房号」）
    assert block.data["labels"]["room_no"] == "客房号"
    # 没被手写覆盖的仍用槽位 label
    assert block.data["labels"]["item"] == "物品"


# ============================================================
# 第 3 层：失败 → 文案要说清下一步
# ============================================================


def test_timeout_failure_tells_user_to_retry(db, monkeypatch):
    """超时 → 可以重试，所以文案必须是「再试一次」。

    不能统一成「提交失败」：超时和参数错对用户意味着完全不同的下一步动作，
    合成一句会让用户反复重试一个永远不会成功的动作。
    """

    def _timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("boom", request=request)

    _patch_http(monkeypatch, _timeout)
    scene = _make_scene(db)

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水"})

    assert result.status == "error"
    assert "再试一次" in result.text
    assert "empty" in _kinds(result)


def test_http_error_failure_does_not_offer_loosening_suggestions(db, monkeypatch):
    """接口 5xx 时不发「放宽条件」那类建议。

    `table_match` 的空结果建议是「换个条件」；这里失败的原因是外部接口，
    放宽条件毫无用处。所以后端显式给 `on_empty: "none"` + 空 `suggestions`，
    前端 `SceneEmptyCard` 会据此收掉整个建议区。
    """

    def _server_error(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "maintenance"})

    _patch_http(monkeypatch, _server_error)
    scene = _make_scene(db)

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水"})
    empty = next(b for b in result.blocks if b.kind == "empty")

    assert result.status == "error"
    assert empty.data["on_empty"] == "none"
    assert empty.data["suggestions"] == []
    assert "接口暂时不可用" in result.text


def test_missing_tool_name_degrades_with_actionable_reason(db, monkeypatch):
    """没配工具名 → 说「还没配接口」，不是「暂无数据」。"""
    seen = _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db, tool_api={})
    scene.tool_api_json = {}  # 显式清空
    db.add(scene)
    db.commit()

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水"})

    assert seen == []
    assert result.status == "no_match"
    assert "还没有配置要调用的接口" in result.text


def test_tool_not_found_does_not_crash(db, monkeypatch):
    """工具不存在（被删/改名）→ 降级成失败文案，不抛异常。"""
    _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db, tool_api={"tool_name": "room.nonexistent"})

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水"})

    assert result.status == "error"
    assert result.text  # 必须有可读文案


# ============================================================
# 第 4 层：参数映射与文案拼装的纯函数
# ============================================================


def test_param_map_renames_slots_for_the_api():
    """表单字段名与接口参数名不一致时用 `param_map` 改名。"""
    config = {"param_map": {"roomNo": "room_no", "goods": "item"}}
    params = _submission_params(config, {"room_no": "8306", "item": "矿泉水", "extra": "x"})

    assert params == {"roomNo": "8306", "goods": "矿泉水"}


def test_param_map_skips_empty_slots_instead_of_sending_null():
    """`param_map` 指向的空槽位**不填 None**。

    传 `None` 可能被对方拼成字符串 `"None"` 落进库；少传一个 key 才是
    「未提供」的正确表达。
    """
    config = {"param_map": {"roomNo": "room_no", "note": "note"}}
    params = _submission_params(config, {"room_no": "8306", "note": ""})

    assert params == {"roomNo": "8306"}
    assert "note" not in params


def test_no_param_map_passes_slots_through_and_drops_empty():
    params = _submission_params({}, {"room_no": "8306", "item": "矿泉水", "note": ""})

    assert params == {"room_no": "8306", "item": "矿泉水"}


def test_reply_text_unwraps_one_level_of_data():
    """响应包了一层 `data` 时也要能取到字段。"""
    text = _tool_reply_text(
        {"reply_template": "单号 {{order_no}}"},
        payload={"data": {"order_no": "RD001"}},
        slots={},
    )

    assert text == "单号 RD001"


def test_reply_text_prefers_slot_values_over_response_echo():
    """槽位值优先于响应回显 —— 用户自己填的比接口回显的更可信。"""
    text = _tool_reply_text(
        {"reply_template": "{{room_no}}"},
        payload={"room_no": "9999"},
        slots={"room_no": "8306"},
    )

    assert text == "8306"


def test_reply_text_falls_back_to_generic_sentence():
    """模板与 message 都没有时给一句兜底，不返回空串。"""
    assert _tool_reply_text({}, payload={"foo": "bar"}, slots={}) == "已提交，请稍候。"


# ============================================================
# 第 5 层：意图触发（胶囊与关键词）
# ============================================================


def test_scene_chip_appears_for_bound_agent(db):
    """场景绑到员工后，胶囊列表里能看到它 —— 这是四步模板的第 1 步。"""
    from app.scene_modules.chips import list_scene_chips

    scene = _make_scene(db)
    _bind(db, scene)

    chips = list_scene_chips(db, tenant_id=TENANT, agent_id="agent_xianlin")
    labels = [chip.label for chip in chips]

    # `label` 是胶囊上显示的文案（`shortcut_json.label` → `shortcut_label` → 场景名）；
    # `send_text` 是点它之后发出去的那句话（第一个关键词）。两者不是一回事，
    # 断言要看 `label` —— 那才是用户看到的东西。
    assert any("客房送物" in label for label in labels)


def test_keyword_triggers_scene(db):
    """关键词命中 → `resolve_scene_hit` 返回该场景。"""
    from app.scene_modules.runtime import resolve_scene_hit

    scene = _make_scene(db)
    _bind(db, scene)

    hit = resolve_scene_hit(db, tenant_id=TENANT, agent_id="agent_xianlin", message="我想叫客房送物")

    assert hit is not None
    assert hit.id == scene.id


# ============================================================
# 第 6 层：工具权限（回归：员工没绑工具时不许调）
# ============================================================


def _bind_tool(db, tool_name: str = "room.delivery_submit", *, agent_id: str = "agent_xianlin",
               status: str = "active") -> None:
    """把工具绑到员工身上。`status` 用于构造「绑了但停用」这一态。"""
    from sqlmodel import select

    tool = db.exec(
        select(Tool).where(Tool.tenant_id == TENANT, Tool.name == tool_name)
    ).first()
    assert tool is not None, f"夹具里没有工具 {tool_name}"
    db.add(
        AgentResourceBinding(
            tenant_id=TENANT,
            agent_id=agent_id,
            resource_type="tool",
            resource_id=tool.id,
            status=status,
        )
    )
    db.commit()


def test_agent_without_tool_binding_cannot_call_it(db, monkeypatch):
    """**权限漏洞回归**：员工身上一个工具都没绑，场景却调通了。

    修复前的链路：`_run_tool_submit` 刻意不传 `agent_id`，于是
    `ToolExecutor.execute` 里那句 `if agent_id and ...` 整段跳过。
    `resolve_scene_hit` 校验的只是**场景**绑没绑在员工身上 —— 场景绑定 ≠ 工具绑定，
    两者完全独立。结果是：员工只绑了场景、没绑任何工具，场景照常命中、表单照常
    发出、点提交就把请求打到了他没权限的接口上。

    这条用例只绑场景、不绑工具，断言「HTTP 一次都没发出去」——
    用 `seen` 为空而不是只看状态码，因为「发了但被业务拒绝」和「压根没发」
    在外部系统那边是两件完全不同的事。
    """
    seen = _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)
    _bind(db, scene)  # 只绑场景

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2}, agent_id="agent_xianlin")

    assert seen == [], "员工没绑这个工具，请求就不该发出去"
    assert result.status == "error"
    assert "权限" in result.text
    # 文案要指向正确的处置：改填写内容 / 重试都没用，得去勾工具
    assert "管理员" in result.text


def test_agent_with_disabled_tool_binding_cannot_call_it(db, monkeypatch):
    """绑了但停在 `disabled`：`include_inactive=False` 的口径下同样不可调。

    为什么单独一条：`visible_tool_rows` 有 `include_inactive` 这个开关，
    工具管理页要 `True`（好让管理员看见并重新启用），执行期必须 `False`。
    哪一处传错的后果都是「停用的工具照样能调」。
    """
    seen = _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)
    _bind(db, scene)
    _bind_tool(db, status="disabled")

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2}, agent_id="agent_xianlin")

    assert seen == []
    assert result.status == "error"


def test_agent_with_globally_disabled_tool_cannot_call_it(db, monkeypatch):
    """工具本身 `enabled=False`：绑了、员工也启用了，仍然不可调。

    这是 `_tool_runtime_enabled` 那条闸：`Tool.enabled` 是全局定义开关，
    员工级启停是 `binding.status`，两道闸任一关闭都视为不可用。
    """
    from sqlmodel import select

    seen = _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)
    _bind(db, scene)
    _bind_tool(db)
    tool = db.exec(select(Tool).where(Tool.name == "room.delivery_submit")).first()
    tool.enabled = False
    db.add(tool)
    db.commit()

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2}, agent_id="agent_xianlin")

    assert seen == []
    assert result.status == "error"


def test_bound_and_enabled_tool_still_passes(db, monkeypatch):
    """绑了且启用 → 照常调通。没有这条，上三条可能靠「一律拒绝」蒙对。"""
    seen = _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)
    _bind(db, scene)
    _bind_tool(db)

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2}, agent_id="agent_xianlin")

    assert len(seen) == 1
    assert result.status == "ok"
    assert "result" in _kinds(result)


def test_trial_run_without_agent_still_calls_api(db, monkeypatch):
    """试跑面板没有员工身份（`agent_id=None`），工具鉴权退化成「存在且启用」。

    这是**刻意的**，不是漏改：管理员刚建好场景、还没绑到任何员工时，必须能
    试跑验证配置。否则「先建场景再绑员工」这个正常流程会在最后一步卡住。
    真实链路（聊天）恒有 `agent_id`，所以这条口子开不到线上。
    """
    seen = _patch_http(monkeypatch, _ok_response)
    scene = _make_scene(db)
    _bind(db, scene)

    result = _run(db, scene, {"room_no": "8306", "item": "矿泉水", "quantity": 2})

    assert len(seen) == 1
    assert result.status == "ok"
