"""微信开场白：扫码后第一句话补发「我是谁」，以及切换员工时的重播语义。

设计背景（2026-11-19 产品要求）：
用户希望「扫码成功以后，发送默认员工的开场白：Hi {显示名}，我是「{员工名}」，{开场白内容}」。
但 iLink 的 sendmessage 必须带 context_token，而它只能从入站消息取得——扫码那一刻
没有任何 token，服务端会返回 200 却静默丢弃。所以真实可行且体验一致的实现是：
**用户扫完码发来第一句话时，把开场白一起发过去**，用户同样不需要做任何额外操作。
"""

from __future__ import annotations

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.agents.greeting import channel_greeting_text
from app.db.models import (
    AgentProfile,
    Message,
    User,
    WechatBinding,
    WechatInboundEvent,
)
from app.wechat import service

TENANT = "tenant_t1"
CONV = "wechat_p2p_owner@im.wechat"


@pytest.fixture()
def db():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    with Session(eng) as session:
        yield session


@pytest.fixture()
def binding(db):
    owner = User(
        id="user_owner",
        tenant_id=TENANT,
        username="owner",
        display_name="张三",
        password_hash="x",
    )
    db.add(owner)
    row = WechatBinding(
        id="wxbind_test",
        tenant_id=TENANT,
        owner_user_id=owner.id,
        ilink_bot_id="bot_1",
        bot_token_enc="",
        status="active",
    )
    db.add(row)
    db.commit()
    return row


def _agent(db, agent_id: str = "agent_a", name: str = "AI G.O", greeting: str = "有什么可以帮你？"):
    metadata = {"greeting_message": greeting} if greeting is not None else {}
    row = AgentProfile(
        id=agent_id,
        tenant_id=TENANT,
        name=name,
        is_overall=False,
        metadata_json=metadata,
    )
    db.add(row)
    db.commit()
    return row


# ---- 文案格式 ------------------------------------------------------------


def test_greeting_includes_name_agent_and_body():
    text = channel_greeting_text("今天想聊点什么？", "张三", "AI G.O")
    assert text == "Hi 张三，我是「AI G.O」，今天想聊点什么？"


def test_greeting_falls_back_when_display_name_missing():
    """没有显示名时不能拼出「Hi ，我是…」这种一眼是 bug 的句子。"""
    text = channel_greeting_text("你好呀", "", "AI G.O")
    assert text == "我是「AI G.O」，你好呀"


def test_greeting_falls_back_when_agent_name_missing():
    text = channel_greeting_text("你好呀", "张三", "")
    assert text == "Hi 张三，你好呀"


def test_greeting_returns_empty_without_body():
    """没配开场白就什么都不发，不能让「我是「X」」单独占一条消息。"""
    assert channel_greeting_text("", "张三", "AI G.O") == ""
    assert channel_greeting_text("   ", "张三", "AI G.O") == ""


# ---- 发送时机与幂等 ------------------------------------------------------


def test_greeting_is_sent_once_per_agent(db, binding):
    _agent(db)
    user = db.get(User, "user_owner")

    first = service.greeting_for(
        db, binding, conv_id=CONV, agent_id="agent_a", agent_name="AI G.O", user=user
    )
    db.commit()
    assert first == "Hi 张三，我是「AI G.O」，有什么可以帮你？"

    # 第二条消息不该再寒暄一遍
    second = service.greeting_for(
        db, binding, conv_id=CONV, agent_id="agent_a", agent_name="AI G.O", user=user
    )
    assert second == ""


def test_greeting_replays_when_switching_to_another_agent(db, binding):
    """切到另一个员工时，那个员工也该自报家门；切回原员工不重复。"""
    _agent(db, "agent_a", "AI G.O", "我是 A")
    _agent(db, "agent_b", "销售小王", "我是 B")
    user = db.get(User, "user_owner")

    a1 = service.greeting_for(
        db, binding, conv_id=CONV, agent_id="agent_a", agent_name="AI G.O", user=user
    )
    db.commit()
    assert "AI G.O" in a1

    b1 = service.greeting_for(
        db, binding, conv_id=CONV, agent_id="agent_b", agent_name="销售小王", user=user
    )
    db.commit()
    assert "销售小王" in b1

    # 切回 A：不重复寒暄
    a2 = service.greeting_for(
        db, binding, conv_id=CONV, agent_id="agent_a", agent_name="AI G.O", user=user
    )
    assert a2 == ""


def test_agent_without_greeting_sends_nothing(db, binding):
    _agent(db, "agent_c", "安静员工", None)
    user = db.get(User, "user_owner")

    text = service.greeting_for(
        db, binding, conv_id=CONV, agent_id="agent_c", agent_name="安静员工", user=user
    )
    assert text == ""
    # 没配开场白的员工不该占用「已打招呼」名额，否则以后配上就发不出来了
    markers = db.exec(
        select(WechatInboundEvent).where(WechatInboundEvent.binding_id == binding.id)
    ).all()
    assert markers == []


def test_greeting_marker_is_scoped_per_binding(db):
    """两个不同微信（不同绑定）各自播一次，互不影响。

    注意用两个不同 owner：`uq_wechat_bindings_owner_active` 保证「一人一活跃绑定」，
    同一个人挂两条 active 绑定本来就该被约束挡下。
    """
    db.add_all(
        [
            User(id="user_a", tenant_id=TENANT, username="a", display_name="张三", password_hash="x"),
            User(id="user_b", tenant_id=TENANT, username="b", display_name="李四", password_hash="x"),
        ]
    )
    for suffix in ("a", "b"):
        db.add(
            WechatBinding(
                id=f"wxbind_{suffix}",
                tenant_id=TENANT,
                owner_user_id=f"user_{suffix}",
                ilink_bot_id=f"bot_{suffix}",
                bot_token_enc="",
                status="active",
            )
        )
    db.commit()
    _agent(db)

    first = service.greeting_for(
        db, db.get(WechatBinding, "wxbind_a"),
        conv_id=CONV, agent_id="agent_a", agent_name="AI G.O", user=db.get(User, "user_a"),
    )
    db.commit()
    second = service.greeting_for(
        db, db.get(WechatBinding, "wxbind_b"),
        conv_id=CONV, agent_id="agent_a", agent_name="AI G.O", user=db.get(User, "user_b"),
    )

    assert first == "Hi 张三，我是「AI G.O」，有什么可以帮你？"
    assert second == "Hi 李四，我是「AI G.O」，有什么可以帮你？"


def test_concurrent_first_message_sends_greeting_only_once(db, binding):
    """两个并发首消息抢同一个名额：只能有一个发出开场白。"""
    _agent(db)
    user = db.get(User, "user_owner")

    # 模拟「另一个请求刚刚抢到了名额并提交」
    assert service._claim_greeting(db, binding, CONV, "agent_a") is True
    db.commit()

    text = service.greeting_for(
        db, binding, conv_id=CONV, agent_id="agent_a", agent_name="AI G.O", user=user
    )
    assert text == ""


# ---- 全链路：process_inbound -------------------------------------------


def _channel_engine(owner_role: str = "admin"):
    """建一套「绑定 + 已发布员工 + 挂载」的最小环境，返回 (engine, binding_id)。

    员工必须 ``published_to_gallery`` 或挂在 owner 名下，否则会被
    ``routing.visible_agent_ids_for`` 的可见性过滤掉，根本走不到开场白分支。
    """
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    with Session(eng) as session:
        session.add(
            User(
                id="user_owner",
                tenant_id=TENANT,
                username="owner",
                display_name="张三",
                password_hash="x",
                role=owner_role,
            )
        )
        session.add(
            AgentProfile(
                id="agent_a",
                tenant_id=TENANT,
                name="AI G.O",
                is_overall=False,
                status="active",
                metadata_json={
                    "published_to_gallery": True,
                    "greeting_message": "今天想去哪玩？我可以帮你规划行程。",
                },
            )
        )
        session.add(
            WechatBinding(
                id="wxbind_test",
                tenant_id=TENANT,
                owner_user_id="user_owner",
                ilink_bot_id="bot_1",
                ilink_user_id="owner@im.wechat",
                bot_token_enc="",
                status="active",
            )
        )
        from app.db.models import WechatBindingAgent

        session.add(
            WechatBindingAgent(
                tenant_id=TENANT,
                binding_id="wxbind_test",
                agent_id="agent_a",
                is_default=True,
                sort_order=0,
            )
        )
        session.commit()
    return eng


class _RecordingClient:
    def __init__(self) -> None:
        self.texts: list[str] = []

    def send_text(self, to_user_id, context_token, text, **kw):
        self.texts.append(text)

    def send_text_chunked(self, to_user_id, context_token, text, **kw):
        self.texts.append(text)

    def get_config(self, *a, **kw):
        return {}

    def send_typing(self, *a, **kw):
        pass

    def close(self):
        pass


def test_first_inbound_message_sends_greeting_before_reply(monkeypatch):
    """首条消息：先发开场白，再发 LLM 回复；第二条不再重复。

    这条用例守的是一个曾经真实发生的崩溃：process_inbound 的 send_reply 全在
    ``with db_session_factory()`` 之外执行，那时 session 已关闭；只要在 with 块里
    多 commit 一次，``fresh`` 的属性就会重新过期，退出块后读 ``fresh.id`` 直接抛
    ``DetachedInstanceError``（commit 后必须有一次属性访问才能"解冻"）。
    """
    eng = _channel_engine()
    monkeypatch.setattr(service, "_run_turn", lambda *a, **kw: ("好的，我来帮你看看。", ""))

    client = _RecordingClient()
    with Session(eng) as db:
        binding = db.get(WechatBinding, "wxbind_test")
        service.process_inbound(
            binding,
            {
                "event_id": "evt_1",
                "from_user_id": "owner@im.wechat",
                "context_token": "ctx_1",
                "text": "你好",
            },
            db_session_factory=lambda: Session(eng),
            client=client,
        )

    assert client.texts == [
        "Hi 张三，我是「AI G.O」，今天想去哪玩？我可以帮你规划行程。",
        "好的，我来帮你看看。",
    ]

    # 开场白必须落库：用户回网页端接着聊时，历史里不能少这条寒暄，
    # 模型下一轮也该读得到自己说过这句，避免再寒暄一次。
    with Session(eng) as db:
        rows = db.exec(
            select(Message).where(Message.tenant_id == TENANT)
        ).all()
    greetings = [r for r in rows if (r.metadata_json or {}).get("greeting")]
    assert len(greetings) == 1
    assert greetings[0].role == "assistant"
    assert greetings[0].content.startswith("Hi 张三，我是「AI G.O」")

    # 第二条消息：不再有开场白，只剩回复
    client.texts.clear()
    with Session(eng) as db:
        binding = db.get(WechatBinding, "wxbind_test")
        service.process_inbound(
            binding,
            {
                "event_id": "evt_2",
                "from_user_id": "owner@im.wechat",
                "context_token": "ctx_2",
                "text": "帮我规划一下",
            },
            db_session_factory=lambda: Session(eng),
            client=client,
        )
    assert client.texts == ["好的，我来帮你看看。"]