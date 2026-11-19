"""微信渠道测试：指令解析、切换语义、会话隔离、迟回归属、协议字段完整性。

重点覆盖「切换员工」这条最容易出语义错误的链路：
- 旧消息不丢（切回原员工上下文还在）
- 新员工看不到旧上下文（会话隔离）
- 菜单窗口外裸数字不被误判
- 迟到回复带归属前缀
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db.models import (
    AgentProfile,
    ChatSession,
    User,
    WechatBinding,
    WechatBindingAgent,
    WechatConvState,
    utc_now,
)
from app.wechat import identity, routing
from app.wechat.client import (
    MESSAGE_STATE_FINISH,
    MESSAGE_TYPE_BOT,
    WeChatClient,
    normalize_inbound_message,
    sanitize_base_url,
    split_text,
)


# ---- fixtures ------------------------------------------------------------


@pytest.fixture()
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    return eng


@pytest.fixture()
def db(engine):
    with Session(engine) as session:
        yield session


@pytest.fixture()
def binding(db):
    # 绑定是用户私有的：owner 决定「这个微信能看到哪些员工」
    owner = User(
        id="user_owner",
        tenant_id="tenant_t1",
        username="owner",
        display_name="Owner",
        role="admin",
        source="web",
        password_hash="x",
    )
    db.add(owner)
    row = WechatBinding(
        id="wxbind_test",
        tenant_id="tenant_t1",
        owner_user_id=owner.id,
        ilink_bot_id="bot_1",
        bot_token_enc="",
        status="active",
    )
    db.add(row)
    db.commit()
    return row


def _agent(db, agent_id: str, name: str, *, status: str = "active") -> AgentProfile:
    row = AgentProfile(id=agent_id, tenant_id="tenant_t1", name=name, status=status)
    db.add(row)
    db.commit()
    return row


def _mount(db, binding: WechatBinding, agent_id: str, *, is_default: bool = False, order: int = 0):
    row = WechatBindingAgent(
        tenant_id=binding.tenant_id,
        binding_id=binding.id,
        agent_id=agent_id,
        is_default=is_default,
        sort_order=order,
    )
    db.add(row)
    db.commit()
    return row


# ---- 指令解析 ------------------------------------------------------------


def test_parse_slash_commands():
    assert routing.parse_command("/员工").kind == "list"
    assert routing.parse_command("/当前").kind == "current"
    assert routing.parse_command("/帮助").kind == "help"
    assert routing.parse_command("/解绑").kind == "unbind"

    switch = routing.parse_command("/切换 客服小李")
    assert switch.kind == "switch"
    assert switch.query == "客服小李"

    # /名字 直达
    direct = routing.parse_command("/客服小李")
    assert direct.kind == "switch"
    assert direct.query == "客服小李"


def test_plain_text_is_not_a_command():
    assert routing.parse_command("你好，帮我查下订单") is None
    assert routing.parse_command("") is None


def test_digit_only_counts_as_menu_pick_when_window_active():
    # 菜单窗口内：纯数字是选择
    picked = routing.parse_command("2", menu_active=True)
    assert picked.kind == "menu_pick"
    assert picked.query == "2"
    # 窗口外：纯数字是普通提问，不能当切换
    assert routing.parse_command("2", menu_active=False) is None
    # 带内容的数字句子永远不是指令
    assert routing.parse_command("3 个方案怎么选", menu_active=True) is None


# ---- 挂载集与指针 --------------------------------------------------------


def test_mounted_agents_falls_back_to_overall_employee(db, binding):
    """没有任何挂载行时，回退到租户启用员工，保证新绑定立刻可用。"""
    _agent(db, "agent_a", "销售小王")
    mounts = routing.mounted_agents(db, binding)
    assert [m.agent_id for m in mounts] == ["agent_a"]


def test_mounted_agents_filters_deleted_employees(db, binding):
    _agent(db, "agent_a", "销售小王")
    _agent(db, "agent_b", "已删除员工", status="deleted")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    _mount(db, binding, "agent_b", order=1)

    mounts = routing.mounted_agents(db, binding)
    # 停用/删除的员工不能出现在 /员工 列表，也不能被 /切换 路由到
    assert [m.agent_id for m in mounts] == ["agent_a"]


def test_resolve_current_agent_creates_pointer_with_default(db, binding):
    _agent(db, "agent_a", "销售小王")
    _agent(db, "agent_b", "客服小李")
    _mount(db, binding, "agent_b", is_default=True, order=0)
    _mount(db, binding, "agent_a", order=1)

    agent_id, reset = routing.resolve_current_agent(db, binding, "wechat_p2p_u1")
    assert agent_id == "agent_b"
    assert reset is False


def test_pointer_resets_when_agent_unmounted(db, binding):
    _agent(db, "agent_a", "销售小王")
    _agent(db, "agent_b", "客服小李")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    _mount(db, binding, "agent_b", order=1)

    routing.set_current_agent(db, binding, "wechat_p2p_u1", "agent_b")
    assert routing.resolve_current_agent(db, binding, "wechat_p2p_u1") == ("agent_b", False)

    # 移除 agent_b 的挂载 → 指针失效应重置回默认，并标记需要提示
    mount_b = db.exec(
        select(WechatBindingAgent).where(WechatBindingAgent.agent_id == "agent_b")
    ).first()
    db.delete(mount_b)
    db.commit()

    agent_id, reset = routing.resolve_current_agent(db, binding, "wechat_p2p_u1")
    assert agent_id == "agent_a"
    assert reset is True


# ---- 切换语义 ------------------------------------------------------------


def test_switch_returns_banner_with_ownership_hint(db, binding):
    _agent(db, "agent_a", "销售小王")
    _agent(db, "agent_b", "客服小李")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    _mount(db, binding, "agent_b", order=1)
    conv = "wechat_p2p_u1"
    routing.resolve_current_agent(db, binding, conv)

    text = routing.run_command(db, binding, conv, routing.ChannelCommand("switch", "客服小李"))

    # 横幅 + 明确告诉用户"上文属于谁、TA 看不到"
    assert "已切换：客服小李" in text
    assert "销售小王" in text
    assert "看不到" in text
    # 指针真的变了
    assert routing.resolve_current_agent(db, binding, conv) == ("agent_b", False)


def test_switch_to_same_agent_is_idempotent(db, binding):
    _agent(db, "agent_a", "销售小王")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    conv = "wechat_p2p_u1"
    routing.resolve_current_agent(db, binding, conv)

    text = routing.run_command(db, binding, conv, routing.ChannelCommand("switch", "销售小王"))
    assert "当前已经是" in text
    assert "看不到" not in text


def test_switch_unknown_name_lists_hint(db, binding):
    _agent(db, "agent_a", "销售小王")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    conv = "wechat_p2p_u1"
    routing.resolve_current_agent(db, binding, conv)

    text = routing.run_command(db, binding, conv, routing.ChannelCommand("switch", "不存在的人"))
    assert "没有找到员工" in text
    assert "/员工" in text


def test_switch_supports_unique_prefix(db, binding):
    _agent(db, "agent_a", "销售小王")
    _agent(db, "agent_b", "客服小李")
    # 当前员工是销售小王，用「客服」前缀切到客服小李
    _mount(db, binding, "agent_a", is_default=True, order=0)
    _mount(db, binding, "agent_b", order=1)
    conv = "wechat_p2p_u1"
    routing.resolve_current_agent(db, binding, conv)

    # 前缀唯一时允许命中，减少用户记全名的摩擦
    text = routing.run_command(db, binding, conv, routing.ChannelCommand("switch", "客服"))
    assert "已切换：客服小李" in text


# ---- 数字菜单 ------------------------------------------------------------


def test_list_outputs_numbered_menu_and_stores_window(db, binding):
    _agent(db, "agent_a", "销售小王")
    _agent(db, "agent_b", "客服小李")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    _mount(db, binding, "agent_b", order=1)
    conv = "wechat_p2p_u1"
    routing.resolve_current_agent(db, binding, conv)

    text = routing.run_command(db, binding, conv, routing.ChannelCommand("list"))
    assert "1. 销售小王" in text
    assert "2. 客服小李" in text
    assert "回复 1-2 切换" in text

    # 菜单窗口写入，供后续裸数字解析
    assert routing.menu_agent_ids(db, binding, conv) == ["agent_a", "agent_b"]


def test_menu_pick_switches_and_clears_window(db, binding):
    _agent(db, "agent_a", "销售小王")
    _agent(db, "agent_b", "客服小李")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    _mount(db, binding, "agent_b", order=1)
    conv = "wechat_p2p_u1"
    routing.resolve_current_agent(db, binding, conv)
    routing.run_command(db, binding, conv, routing.ChannelCommand("list"))

    text = routing.run_command(db, binding, conv, routing.ChannelCommand("menu_pick", "2"))
    assert "已切换：客服小李" in text
    # 切换后窗口清空，避免连续数字误触
    assert routing.menu_agent_ids(db, binding, conv) == []


def test_expired_menu_rejects_pick(db, binding):
    _agent(db, "agent_a", "销售小王")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    conv = "wechat_p2p_u1"
    routing.resolve_current_agent(db, binding, conv)
    routing.run_command(db, binding, conv, routing.ChannelCommand("list"))

    state = db.exec(
        select(WechatConvState).where(WechatConvState.external_conv_id == conv)
    ).first()
    state.menu_expires_at = utc_now() - timedelta(seconds=1)
    db.add(state)
    db.commit()

    assert routing.menu_agent_ids(db, binding, conv) == []
    text = routing.run_command(db, binding, conv, routing.ChannelCommand("menu_pick", "1"))
    assert "编号已失效" in text


def test_menu_pick_out_of_range(db, binding):
    _agent(db, "agent_a", "销售小王")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    conv = "wechat_p2p_u1"
    routing.resolve_current_agent(db, binding, conv)
    routing.run_command(db, binding, conv, routing.ChannelCommand("list"))

    text = routing.run_command(db, binding, conv, routing.ChannelCommand("menu_pick", "9"))
    assert "编号已失效" in text


# ---- 会话隔离（旧消息如何处理的核心）-------------------------------------


def test_sessions_are_isolated_per_agent(db, binding):
    """同一微信好友 + 不同员工 → 独立会话；切换不删不迁移旧会话。"""
    from app.wechat import service

    _agent(db, "agent_a", "销售小王")
    _agent(db, "agent_b", "客服小李")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    _mount(db, binding, "agent_b", order=1)
    conv = "wechat_p2p_u1"
    user = identity.ensure_channel_user(db, binding.tenant_id, "u1@im.wechat")

    session_a = service.find_or_create_session(db, binding, user, "agent_a", conv, "你好")
    session_b = service.find_or_create_session(db, binding, user, "agent_b", conv, "你好")
    db.commit()

    assert session_a.id != session_b.id
    assert session_a.agent_id == "agent_a"
    assert session_b.agent_id == "agent_b"

    # 切回 A：拿到的还是原来那个会话，历史没丢
    again_a = service.find_or_create_session(db, binding, user, "agent_a", conv, "新消息")
    assert again_a.id == session_a.id

    # 两个会话各自独立存在，谁都没被删
    rows = db.exec(
        select(ChatSession).where(
            ChatSession.channel == "wechat",
            ChatSession.external_conv_id == conv,
        )
    ).all()
    assert {r.id for r in rows} == {session_a.id, session_b.id}


def test_stale_turn_gets_attribution(db, binding):
    """切换后旧轮的迟到回复要带【员工名】前缀，避免被误认成新员工。"""
    from app.wechat import service

    _agent(db, "agent_a", "销售小王")
    _agent(db, "agent_b", "客服小李")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    _mount(db, binding, "agent_b", order=1)
    conv = "wechat_p2p_u1"
    routing.resolve_current_agent(db, binding, conv)
    revision = service._current_revision(db, binding, conv)

    # 员工 A 跑的过程中用户切到了 B
    routing.set_current_agent(db, binding, conv, "agent_b")

    def factory():
        return Session(binding_engine)

    binding_engine = db.get_bind()
    assert service._attribution_if_stale(factory, binding, conv, "agent_a", revision) is True
    # 新员工自己的回复不需要标注
    assert service._attribution_if_stale(factory, binding, conv, "agent_b", None) is False


# ---- 身份绑定 ------------------------------------------------------------


def test_channel_user_is_provisioned_lazily(db):
    user = identity.ensure_channel_user(db, "tenant_t1", "u1@im.wechat")
    assert user.source == "wechat"
    assert user.tenant_id == "tenant_t1"
    assert "微信用户" in (user.display_name or "")
    # 幂等：再调一次拿到同一个账号
    again = identity.ensure_channel_user(db, "tenant_t1", "u1@im.wechat")
    assert again.id == user.id


def test_unbind_migrates_back_to_channel_account(db, binding):
    """解绑把会话迁回懒建账号。绑定关系用真实的「扫码人自动绑定」建立。"""
    _agent(db, "agent_a", "销售小王")
    _mount(db, binding, "agent_a", is_default=True, order=0)
    real = User(id="user_real3", tenant_id="tenant_t1", username="wangwu", password_hash="x")
    db.add(real)
    binding.owner_user_id = "user_real3"
    binding.ilink_user_id = "u3@im.wechat"
    db.add(binding)
    db.commit()

    from app.wechat import service

    channel_user = identity.ensure_channel_user(db, "tenant_t1", "u3@im.wechat")
    session = service.find_or_create_session(
        db, binding, channel_user, "agent_a", "wechat_p2p_u3@im.wechat", "x"
    )
    db.commit()

    assert identity.maybe_auto_bind_scan_user(db, binding, "u3@im.wechat") is True
    db.commit()

    reply = identity.unbind(db, "tenant_t1", "u3@im.wechat")
    assert "已解除绑定" in reply

    db.expire_all()
    moved = db.get(ChatSession, session.id)
    assert moved.user_id == channel_user.id


# ---- iLink 协议字段 ------------------------------------------------------


class _Recorder:
    def __init__(self):
        self.calls: list = []


def _mock_client(recorder: _Recorder, response=None):
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        recorder.calls.append(request)
        return response or httpx.Response(200, content=b"{}")

    return WeChatClient(
        "https://ilinkai.weixin.qq.com",
        "token_x",
        transport=httpx.MockTransport(handler),
    )


def test_sendmessage_carries_all_required_fields():
    """缺任何一个字段 iLink 都返回 200 但静默丢弃，所以逐个断言。"""
    import json

    rec = _Recorder()
    client = _mock_client(rec)
    client.send_text("u1@im.wechat", "ct_1", "hello")

    raw = rec.calls[-1].content
    body = json.loads(raw)
    msg = body["msg"]

    assert msg["from_user_id"] == ""
    assert msg["to_user_id"] == "u1@im.wechat"
    assert msg["client_id"]
    assert msg["message_type"] == MESSAGE_TYPE_BOT
    assert msg["message_state"] == MESSAGE_STATE_FINISH
    assert msg["context_token"] == "ct_1"
    assert msg["item_list"][0]["type"] == 1
    assert msg["item_list"][0]["text_item"]["text"] == "hello"
    assert body["base_info"]["channel_version"]
    # Content-Length 必须按 UTF-8 字节精确
    assert int(rec.calls[-1].headers["content-length"]) == len(raw)


def test_send_chunked_shares_client_id_prefix():
    import json

    rec = _Recorder()
    client = _mock_client(rec)
    long_text = "字" * 4500
    count = client.send_text_chunked("u1@im.wechat", "ct", long_text, client_id="turn1")

    assert count >= 3
    ids = [json.loads(c.content)["msg"]["client_id"] for c in rec.calls]
    # 分片共享同一前缀，服务端可据此去重
    assert all(i.startswith("turn1:") for i in ids)
    assert len(set(ids)) == len(ids)


def test_base_url_whitelist_blocks_third_party():
    assert sanitize_base_url("https://evil.example.com") == "https://ilinkai.weixin.qq.com"
    assert sanitize_base_url("http://ilinkai.weixin.qq.com") == "https://ilinkai.weixin.qq.com"
    assert sanitize_base_url("https://ilinkai.weixin.qq.com/") == "https://ilinkai.weixin.qq.com"


def test_split_text_respects_limit_and_content():
    text = "段A" * 1200 + "\n\n" + "段B" * 1200
    chunks = split_text(text)
    assert all(len(c) <= 2000 for c in chunks)
    # 不丢内容（换行被重排，但正文完整）
    assert "".join(chunks).replace("\n", "") == text.replace("\n", "")


def test_normalize_inbound_extracts_text_and_cursor():
    raw = {
        "from_user_id": "u1@im.wechat",
        "context_token": "ct_abc",
        "item_list": [{"type": 1, "text_item": {"text": "帮我查下订单"}}],
    }
    inbound = normalize_inbound_message(raw)
    assert inbound["text"] == "帮我查下订单"
    assert inbound["from_user_id"] == "u1@im.wechat"
    assert inbound["context_token"] == "ct_abc"
    assert inbound["event_id"]


def test_normalize_inbound_ignores_non_text():
    raw = {"from_user_id": "u1@im.wechat", "item_list": [{"type": 3}]}
    assert normalize_inbound_message(raw) is None

# ---- 扫码即绑定（扫码人本人）--------------------------------------------


def test_scan_user_auto_binds_when_sender_is_bot_owner(db, binding):
    """扫码人本人发消息时自动绑定（这是唯一的绑定路径）。

    iLink 扫码返回的 ilink_user_id 是「扫码登录 bot 的人」，所以发消息的
    from_user_id 与之相等时，可以确定他就是操作者本人。
    """
    # fixture 已经建好 owner（user_owner），这里只改绑定的扫码人
    binding.ilink_user_id = "owner@im.wechat"
    db.add(binding)
    db.commit()

    # 先有懒建账号与历史会话
    channel_user = identity.ensure_channel_user(db, "tenant_t1", "owner@im.wechat")
    from app.wechat import service

    session = service.find_or_create_session(
        db, binding, channel_user, "agent_a", "wechat_p2p_owner@im.wechat", "之前聊过"
    )
    db.commit()

    bound = identity.maybe_auto_bind_scan_user(db, binding, "owner@im.wechat")
    db.commit()
    assert bound is True

    # 身份解析现在应拿到实名账号，且历史会话迁过去了
    user = identity.ensure_channel_user(db, "tenant_t1", "owner@im.wechat")
    assert user.id == "user_owner"
    db.expire_all()
    assert db.get(ChatSession, session.id).user_id == "user_owner"


def test_non_owner_sender_is_not_auto_bound(db, binding):
    """管理员扫码、同事来用：不能自动绑定，只作为独立的微信访客账号使用。"""
    real = User(id="user_owner2", tenant_id="tenant_t1", username="owner2", password_hash="x")
    db.add(real)
    binding.owner_user_id = "user_owner2"
    binding.ilink_user_id = "owner2@im.wechat"
    db.add(binding)
    db.commit()

    bound = identity.maybe_auto_bind_scan_user(db, binding, "colleague@im.wechat")
    db.commit()
    assert bound is False

    # 同事仍是自己的懒建账号
    user = identity.ensure_channel_user(db, "tenant_t1", "colleague@im.wechat")
    assert user.id != "user_owner2"
    assert user.source == "wechat"


def test_auto_bind_is_idempotent(db, binding):
    real = User(id="user_owner3", tenant_id="tenant_t1", username="owner3", password_hash="x")
    db.add(real)
    binding.owner_user_id = "user_owner3"
    binding.ilink_user_id = "owner3@im.wechat"
    db.add(binding)
    db.commit()

    assert identity.maybe_auto_bind_scan_user(db, binding, "owner3@im.wechat") is True
    db.commit()
    # 第二次不再重复插入 link（否则唯一约束会炸）
    assert identity.maybe_auto_bind_scan_user(db, binding, "owner3@im.wechat") is False


def test_auto_bind_skips_when_no_owner(db, binding):
    binding.owner_user_id = None
    binding.ilink_user_id = "someone@im.wechat"
    db.add(binding)
    db.commit()
    assert identity.maybe_auto_bind_scan_user(db, binding, "someone@im.wechat") is False


def test_duplicate_binding_rows_blocked_by_unique_index(db):
    """并发扫码确认不能产生两条同 bot 绑定（前端会弹多次成功提醒）。"""
    from sqlalchemy.exc import IntegrityError as SAIntegrityError

    for _ in range(2):
        db.add(
            WechatBinding(
                tenant_id="tenant_t1", ilink_bot_id="bot_dup", status="active"
            )
        )
    with pytest.raises(SAIntegrityError):
        db.commit()
    db.rollback()


# ---- 按人可见（2026-11-19 新语义）----------------------------------------


def _member(db, user_id: str, username: str) -> User:
    row = User(
        id=user_id,
        tenant_id="tenant_t1",
        username=username,
        display_name=username,
        role="member",
        source="web",
        password_hash="x",
    )
    db.add(row)
    db.commit()
    return row


def _owned_agent(db, agent_id: str, name: str, owner: User) -> AgentProfile:
    row = AgentProfile(
        id=agent_id,
        tenant_id="tenant_t1",
        name=name,
        status="active",
        metadata_json={"owner_user_id": owner.id},
    )
    db.add(row)
    db.commit()
    return row


def _gallery_agent(db, agent_id: str, name: str) -> AgentProfile:
    row = AgentProfile(
        id=agent_id,
        tenant_id="tenant_t1",
        name=name,
        status="active",
        metadata_json={"published_to_gallery": True},
    )
    db.add(row)
    db.commit()
    return row


def test_member_sees_only_own_and_gallery_agents(db, binding):
    """张三名下的私有员工，李四在微信里看不到——这是本次修正的核心。

    旧实现「一个 bot 一份全局列表 + 回退到租户任一员工」，李四会看到
    张三的私有员工，语义错位且越权。
    """
    zhang = _member(db, "u_zhang", "zhang")
    li = _member(db, "u_li", "li")
    _owned_agent(db, "agent_zhang", "张三私有", zhang)
    _gallery_agent(db, "agent_pub", "广场员工")

    zhang_ids = routing.visible_agent_ids_for(db, "tenant_t1", zhang.id)
    li_ids = routing.visible_agent_ids_for(db, "tenant_t1", li.id)

    assert "agent_zhang" in zhang_ids
    assert "agent_pub" in zhang_ids
    # 李四只看到广场的
    assert "agent_zhang" not in li_ids
    assert "agent_pub" in li_ids


def test_admin_sees_all_agents(db, binding):
    admin = db.get(User, "user_owner")  # fixture 里的 admin
    zhang = _member(db, "u_zhang2", "zhang2")
    _owned_agent(db, "agent_zhang2", "张三私有2", zhang)

    ids = routing.visible_agent_ids_for(db, "tenant_t1", admin.id)
    assert "agent_zhang2" in ids


def test_overall_agent_never_selectable(db):
    """整体智能体不进微信候选（与前端过滤同一口径）。"""
    overall = AgentProfile(
        id="agent_overall",
        tenant_id="tenant_t1",
        name="整体智能体",
        status="active",
        is_overall=True,
    )
    db.add(overall)
    db.commit()

    assert "agent_overall" not in routing.visible_agent_ids_for(
        db, "tenant_t1", "user_owner"
    )


def test_hidden_agent_not_selectable(db, binding):
    admin = db.get(User, "user_owner")
    row = AgentProfile(
        id="agent_hidden",
        tenant_id="tenant_t1",
        name="隐藏员工",
        status="active",
        metadata_json={"hidden_from_staffdeck": True},
    )
    db.add(row)
    db.commit()
    assert "agent_hidden" not in routing.visible_agent_ids_for(
        db, "tenant_t1", admin.id
    )


def test_mounted_agents_uses_sender_permission_not_binding_owner(db, binding):
    """同事共用同一个 bot 时，各自看到的员工按自己的权限算。"""
    li = _member(db, "u_li3", "li3")
    zhang = _member(db, "u_zhang3", "zhang3")
    _owned_agent(db, "agent_z3", "张三私有3", zhang)
    _gallery_agent(db, "agent_pub3", "广场3")

    # 同一条 binding，换个 user 传进来
    li_mounts = routing.mounted_agents(db, binding, user=li)
    li_ids = [m.agent_id for m in li_mounts]
    assert "agent_pub3" in li_ids
    assert "agent_z3" not in li_ids


def test_mounted_agents_filters_mounts_outside_visibility(db, binding):
    """勾选行也不能越权：别人塞进来的私有员工要被交集掉。"""
    li = _member(db, "u_li4", "li4")
    zhang = _member(db, "u_zhang4", "zhang4")
    _owned_agent(db, "agent_z4", "张三私有4", zhang)
    _gallery_agent(db, "agent_pub4", "广场4")

    # 勾选行里同时放了张三的私有员工和广场员工
    _mount(db, binding, "agent_z4", is_default=True, order=0)
    _mount(db, binding, "agent_pub4", order=1)

    mounts = routing.mounted_agents(db, binding, user=li)
    ids = [m.agent_id for m in mounts]
    assert ids == ["agent_pub4"]


def test_run_command_list_respects_sender_permission(db, binding):
    """`/员工` 的列表就是发消息那个人的可见集。"""
    li = _member(db, "u_li5", "li5")
    zhang = _member(db, "u_zhang5", "zhang5")
    _owned_agent(db, "agent_z5", "张三私有5", zhang)
    _gallery_agent(db, "agent_pub5", "广场5")

    text = routing.run_command(
        db, binding, "wechat_p2p_li5", routing.ChannelCommand("list"), user=li
    )
    assert "广场5" in text
    assert "张三私有5" not in text


def test_unbound_wechat_user_sees_only_gallery_agents(db, binding):
    """未绑定账号的微信用户不继承 bot 主人的私有员工（那是越权）。

    他只能看到广场发布的——这些本来就是「给所有人用」的。
    """
    zhang = _member(db, "u_zhang6", "zhang6")
    _owned_agent(db, "agent_priv6", "私有6", zhang)
    _gallery_agent(db, "agent_pub6", "广场6")

    # 懒建的渠道账号（source='wechat'）
    channel_user = identity.ensure_channel_user(db, "tenant_t1", "stranger@im.wechat")
    mounts = routing.mounted_agents(db, binding, user=channel_user)
    ids = [m.agent_id for m in mounts]

    assert "agent_pub6" in ids
    assert "agent_priv6" not in ids
