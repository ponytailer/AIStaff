"""微信转人工测试：指令解析、工单创建、挂起抢答、人工回复回传。

用户诉求：「关联微信以后，微信端可以输入转人工，owner 或管理员可以在聊天端回复」。
"""

from __future__ import annotations

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db.models import (
    AgentProfile,
    ChatSession,
    HumanHandoffRequest,
    User,
    WechatBinding,
    WechatBindingAgent,
    WechatInboundEvent,
    new_id,
)
from app.wechat import handoff as handoff_mod
from app.wechat import routing


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
    row = WechatBinding(
        id="wxbind_h",
        tenant_id="tenant_h",
        ilink_bot_id="bot_h",
        bot_token_enc="",
        status="active",
    )
    db.add(row)
    db.commit()
    return row


def _admin(db, user_id: str = "admin_h") -> User:
    row = User(
        id=user_id,
        tenant_id="tenant_h",
        username=user_id,
        display_name="管理员小张",
        role="admin",
        source="web",
        password_hash="x",
    )
    db.add(row)
    db.commit()
    return row


def _agent(db, agent_id: str = "agent_h", *, owner: str = "") -> AgentProfile:
    metadata = {"owner_user_id": owner} if owner else {}
    row = AgentProfile(
        id=agent_id,
        tenant_id="tenant_h",
        name="客服小李",
        status="active",
        metadata_json=metadata,
    )
    db.add(row)
    db.commit()
    return row


def _session(db, agent_id: str = "agent_h") -> ChatSession:
    row = ChatSession(
        id=new_id("session"),
        tenant_id="tenant_h",
        user_id="wxuser_h",
        agent_id=agent_id,
        title="测试",
        channel="wechat",
        channel_binding_id="wxbind_h",
        external_conv_id="wechat_p2p_wxuser_h",
    )
    db.add(row)
    db.commit()
    return row


# ---- 指令解析 -----------------------------------------------------------


@pytest.mark.parametrize("text", ["转人工", "/转人工", "人工", "/人工", "人工客服", "handoff"])
def test_parse_handoff_triggers(text):
    cmd = routing.parse_command(text)
    assert cmd is not None
    assert cmd.kind == "handoff"


def test_parse_cancel_handoff():
    cmd = routing.parse_command("/取消转人工")
    assert cmd is not None
    assert cmd.kind == "cancel_handoff"


def test_help_mentions_handoff():
    assert "转人工" in routing.help_text()


# ---- 处理人解析 ---------------------------------------------------------


def test_resolve_assignee_prefers_agent_owner(db):
    _admin(db)
    _agent(db, owner="owner_h")
    owner = User(
        id="owner_h",
        tenant_id="tenant_h",
        username="owner",
        display_name="员工负责人",
        role="member",
        source="web",
        password_hash="x",
    )
    db.add(owner)
    db.commit()

    assert handoff_mod.resolve_assignee(db, "tenant_h", "agent_h") == "owner_h"


def test_resolve_assignee_falls_back_to_admin(db):
    _admin(db)
    _agent(db)  # 没有 owner
    assert handoff_mod.resolve_assignee(db, "tenant_h", "agent_h") == "admin_h"


def test_resolve_assignee_ignores_channel_user(db):
    """微信侧懒建的账号不能当处理人——他们登录不了站内收件箱。"""
    _agent(db, owner="wxuser_h")
    wx = User(
        id="wxuser_h",
        tenant_id="tenant_h",
        username="wxuser",
        role="member",
        source="wechat",
        password_hash="x",
    )
    db.add(wx)
    db.commit()
    _admin(db)

    assert handoff_mod.resolve_assignee(db, "tenant_h", "agent_h") == "admin_h"


# ---- 工单创建 -----------------------------------------------------------


def test_request_handoff_creates_pending(db, binding):
    _admin(db)
    agent = _agent(db)
    session = _session(db)

    created, reply = handoff_mod.request_handoff(
        db, binding=binding, chat_session=session,
        agent_id=agent.id, agent_name=agent.name,
        user_question="发票怎么开",
    )

    assert created is True
    assert "转接人工" in reply

    row = db.exec(
        select(HumanHandoffRequest).where(HumanHandoffRequest.session_id == session.id)
    ).first()
    assert row is not None
    assert row.status == "pending"
    assert row.assignee_user_id == "admin_h"
    assert row.pending_question == "发票怎么开"
    assert row.metadata_json["channel"] == "wechat"

    # 会话必须挂起，否则数字员工会继续抢答
    db.refresh(session)
    assert session.status == "handoff"
    assert session.awaiting_input_json["type"] == "human_handoff"


def test_request_handoff_reuses_existing_pending(db, binding):
    _admin(db)
    agent = _agent(db)
    session = _session(db)

    handoff_mod.request_handoff(
        db, binding=binding, chat_session=session,
        agent_id=agent.id, agent_name=agent.name, user_question="第一次",
    )
    created, reply = handoff_mod.request_handoff(
        db, binding=binding, chat_session=session,
        agent_id=agent.id, agent_name=agent.name, user_question="第二次",
    )

    assert created is False
    assert "请稍等" in reply or "已转接" in reply
    rows = db.exec(
        select(HumanHandoffRequest).where(HumanHandoffRequest.session_id == session.id)
    ).all()
    # 连发几条「转人工」不该产生多张工单
    assert len(rows) == 1


def test_request_handoff_without_assignee_reports_clearly(db, binding):
    agent = _agent(db)  # 没有 admin，也没有 owner
    session = _session(db)
    created, reply = handoff_mod.request_handoff(
        db, binding=binding, chat_session=session,
        agent_id=agent.id, agent_name=agent.name, user_question="问题",
    )
    assert created is False
    assert "找不到" in reply


# ---- 取消 ---------------------------------------------------------------


def test_cancel_handoff_restores_session(db, binding):
    _admin(db)
    agent = _agent(db)
    session = _session(db)

    handoff_mod.request_handoff(
        db, binding=binding, chat_session=session,
        agent_id=agent.id, agent_name=agent.name, user_question="问题",
    )
    reply = handoff_mod.cancel_handoff(db, session, agent.name)

    assert agent.name in reply
    db.refresh(session)
    assert session.status == "active"
    assert session.awaiting_input_json is None
    row = db.exec(
        select(HumanHandoffRequest).where(HumanHandoffRequest.session_id == session.id)
    ).first()
    assert row.status == "dismissed"


def test_cancel_without_pending_says_nothing_to_cancel(db):
    session = _session(db)
    assert "没有进行中" in handoff_mod.cancel_handoff(db, session, "客服小李")


# ---- 挂起期间不跑 LLM ---------------------------------------------------


def test_waiting_reply_mentions_cancel():
    assert "/取消转人工" in handoff_mod.WAITING_REPLY


# ---- 取最近提问 ---------------------------------------------------------


def _message(db, session_id: str, content: str, *, role: str = "user", **metadata):
    from app.db.models import Message

    row = Message(
        id=new_id("msg"),
        tenant_id="tenant_h",
        session_id=session_id,
        role=role,
        content=content,
        metadata_json=metadata or {},
    )
    db.add(row)
    db.commit()
    return row


def test_last_user_question_skips_trigger(db):
    session = _session(db)
    _message(db, session.id, "发票怎么开")
    _message(db, session.id, "转人工")

    assert handoff_mod.last_user_question(db, "tenant_h", session.id) == "发票怎么开"


def test_last_user_question_skips_human_reply(db):
    session = _session(db)
    _message(db, session.id, "真实问题")
    _message(db, session.id, "人工给的答案", human_reply=True)

    assert handoff_mod.last_user_question(db, "tenant_h", session.id) == "真实问题"


def test_last_user_question_empty_when_only_triggers(db):
    session = _session(db)
    _message(db, session.id, "转人工")
    assert handoff_mod.last_user_question(db, "tenant_h", session.id) == ""


# ---- 人工回复回传 -------------------------------------------------------


def test_deliver_human_reply_ignores_non_wechat(db):
    row = HumanHandoffRequest(
        tenant_id="tenant_h",
        session_id="s1",
        status="answered",
        metadata_json={},
    )
    assert handoff_mod.deliver_human_reply(db, row, "答案") is False


def test_deliver_human_reply_sends_to_wechat(db, binding, monkeypatch):
    _admin(db)
    agent = _agent(db)
    session = _session(db)

    handoff_mod.request_handoff(
        db, binding=binding, chat_session=session,
        agent_id=agent.id, agent_name=agent.name, user_question="问题",
    )
    row = db.exec(
        select(HumanHandoffRequest).where(HumanHandoffRequest.session_id == session.id)
    ).first()

    # 入站事件里存着 context_token
    db.add(
        WechatInboundEvent(
            tenant_id="tenant_h",
            binding_id=binding.id,
            event_id="evt_1",
            external_conv_id="wechat_p2p_wxuser_h",
            status="done",
            payload_json={"context_token": "ctx-token"},
        )
    )
    db.commit()

    sent: list[tuple] = []

    class _FakeClient:
        def __init__(self, *a, **k) -> None:
            pass

        def close(self) -> None:
            pass

    def _fake_send_reply(client, bind, to_user, ctx, text, **kw):
        sent.append((to_user, ctx, text))

    monkeypatch.setattr("app.wechat.client.WeChatClient", _FakeClient)
    monkeypatch.setattr("app.wechat.service.send_reply", _fake_send_reply)
    monkeypatch.setattr(handoff_mod, "_reply_sender_name", lambda db_, uid: "管理员小张")

    ok = handoff_mod.deliver_human_reply(db, row, "这是人工答案", answered_by_user_id="admin_h")

    assert ok is True
    assert len(sent) == 1
    to_user, ctx, text = sent[0]
    assert to_user == "wxuser_h"
    assert ctx == "ctx-token"
    assert "这是人工答案" in text
    # 标注是谁回答的，用户才知道这是真人说的
    assert "人工" in text


def test_deliver_human_reply_without_context_token_skips(db, binding):
    _admin(db)
    agent = _agent(db)
    session = _session(db)
    handoff_mod.request_handoff(
        db, binding=binding, chat_session=session,
        agent_id=agent.id, agent_name=agent.name, user_question="问题",
    )
    row = db.exec(
        select(HumanHandoffRequest).where(HumanHandoffRequest.session_id == session.id)
    ).first()

    # 没有入站事件 → 拿不到 context_token
    assert handoff_mod.deliver_human_reply(db, row, "答案") is False


def test_deliver_human_reply_skips_inactive_binding(db, binding):
    _admin(db)
    agent = _agent(db)
    session = _session(db)
    handoff_mod.request_handoff(
        db, binding=binding, chat_session=session,
        agent_id=agent.id, agent_name=agent.name, user_question="问题",
    )
    row = db.exec(
        select(HumanHandoffRequest).where(HumanHandoffRequest.session_id == session.id)
    ).first()

    binding.status = "disconnected"
    db.add(binding)
    db.commit()

    assert handoff_mod.deliver_human_reply(db, row, "答案") is False