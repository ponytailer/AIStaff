"""微信转人工「静默超时自动结束」测试。

用户诉求：「转人工后，如果人工回复了，半小时内没有发送消息，那么自动取消转人工，
并发送提示消息。」

这里覆盖三类分支：

1. 该结束的（人工答完、用户此后一句话没说、超过 30 分钟）；
2. 不该结束的（窗口内用户说过话 / 还没到 30 分钟 / 不是微信渠道 / 已收尾过）；
3. 收尾的副作用（会话回到 active、状态机不动 answered、提示落库 + 发微信）。
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db.models import (
    AgentEvent,
    AgentProfile,
    ChatSession,
    HumanHandoffRequest,
    Message,
    User,
    WechatBinding,
    WechatInboundEvent,
    new_id,
    utc_now,
)
from app.wechat import handoff as handoff_mod
from app.wechat import handoff_sweeper

CONV_ID = "wechat_p2p_wxuser_h"


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


# ---- 夹具 -----------------------------------------------------------------


def _admin(db) -> User:
    row = User(
        id="admin_h",
        tenant_id="tenant_h",
        username="admin_h",
        display_name="管理员小张",
        role="admin",
        source="web",
        password_hash="x",
    )
    db.add(row)
    db.commit()
    return row


def _agent(db) -> AgentProfile:
    row = AgentProfile(
        id="agent_h",
        tenant_id="tenant_h",
        name="客服小李",
        status="active",
        metadata_json={},
    )
    db.add(row)
    db.commit()
    return row


def _session(db) -> ChatSession:
    row = ChatSession(
        id="session_h",
        tenant_id="tenant_h",
        user_id="wxuser_h",
        agent_id="agent_h",
        title="测试",
        channel="wechat",
        channel_binding_id="wxbind_h",
        external_conv_id=CONV_ID,
    )
    db.add(row)
    db.commit()
    return row


def _answered_handoff(
    db,
    binding: WechatBinding,
    session: ChatSession,
    *,
    answered_ago_minutes: int = 40,
    channel: str = "wechat",
    metadata: dict | None = None,
) -> HumanHandoffRequest:
    """直接造一张「人工已回复」的工单，answered_at 落在 N 分钟前。"""
    answered_at = utc_now() - timedelta(minutes=answered_ago_minutes)
    row = HumanHandoffRequest(
        tenant_id="tenant_h",
        session_id=session.id,
        agent_id="agent_h",
        requester_user_id="wxuser_h",
        assignee_user_id="admin_h",
        context_summary="微信用户请求人工协助（渠道：微信）",
        pending_question="怎么开票？",
        status="answered",
        human_reply="点右上角订单页开发票",
        resume_payload_json={
            "channel": channel,
            "binding_id": binding.id,
            "external_conv_id": CONV_ID,
        },
        metadata_json={
            "channel": channel,
            "binding_id": binding.id,
            "agent_name": "客服小李",
            **(metadata or {}),
        },
        answered_at=answered_at,
    )
    db.add(row)
    # 会话此时应处于 handoff 状态，等超时把它放回去
    session.status = "handoff"
    session.awaiting_input_json = {"type": "human_handoff", "handoff_id": row.id}
    db.add(session)
    db.commit()
    return row


def _user_event(db, binding: WechatBinding, *, minutes_ago: int = 5) -> None:
    """造一条入站事件，表示用户在 N 分钟前跟 bot 说过话。"""
    moment = utc_now() - timedelta(minutes=minutes_ago)
    db.add(
        WechatInboundEvent(
            tenant_id="tenant_h",
            binding_id=binding.id,
            event_id=new_id("evt"),
            external_conv_id=CONV_ID,
            status="done",
            payload_json={"context_token": "ctx-token"},
            created_at=moment,
            updated_at=moment,
        )
    )
    db.commit()


def _stale_user_message(db, session: ChatSession, *, minutes_ago: int) -> None:
    """转型前就存在的 user 消息（早于人工回复），不该被当成「用户刚说话」。"""
    db.add(
        Message(
            tenant_id="tenant_h",
            session_id=session.id,
            role="user",
            content="怎么开票？",
            metadata_json={},
            created_at=utc_now() - timedelta(minutes=minutes_ago),
        )
    )
    db.commit()


@pytest.fixture(autouse=True)
def _no_real_wechat(monkeypatch):
    """任何用例都不该真的往外发 HTTP；默认让 _notify 的发送分支拿到 token 就失败退出。"""
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
    monkeypatch.setattr(handoff_sweeper, "SENT", sent, raising=False)
    return sent


# ---- 该结束的分支 ---------------------------------------------------------


def test_sweeps_answered_handoff_after_idle_window(db, binding, _no_real_wechat):
    _admin(db)
    _agent(db)
    session = _session(db)
    handoff = _answered_handoff(db, binding, session, answered_ago_minutes=45)
    _user_event(db, binding, minutes_ago=120)  # 人工回复之前说过话，不算窗口内

    closed = handoff_sweeper.sweep_idle_handoffs(db)

    assert closed == 1
    db.refresh(handoff)
    assert handoff.metadata_json["auto_closed_reason"] == "idle_timeout"
    assert handoff.metadata_json["auto_closed_idle_minutes"] == 30
    assert handoff.metadata_json.get("auto_closed_at")


def test_stale_pre_reply_user_message_does_not_block(db, binding, _no_real_wechat):
    """转型前的旧 user 消息不能被当成「用户刚说话」，否则永远不会结束。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    handoff = _answered_handoff(db, binding, session, answered_ago_minutes=40)
    _stale_user_message(db, session, minutes_ago=90)

    assert handoff_sweeper.sweep_idle_handoffs(db) == 1
    db.refresh(handoff)
    assert handoff.metadata_json.get("auto_closed_at")


def test_session_restored_to_active(db, binding, _no_real_wechat):
    """会话必须回到可对话状态，否则用户下一条消息只会收到「请稍等人工」。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    _answered_handoff(db, binding, session, answered_ago_minutes=40)

    handoff_sweeper.sweep_idle_handoffs(db)

    db.refresh(session)
    assert session.status == "active"
    assert session.awaiting_input_json is None


def test_answered_status_kept_for_faq_sedimentation(db, binding, _no_real_wechat):
    """不动 status：FAQ 沉淀只收 answered 的人工回答，改掉等于丢掉好答案。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    handoff = _answered_handoff(db, binding, session, answered_ago_minutes=40)

    handoff_sweeper.sweep_idle_handoffs(db)

    db.refresh(handoff)
    assert handoff.status == "answered"


def test_notice_persisted_and_pushed_to_wechat(db, binding, _no_real_wechat):
    """提示要既落库（网页端历史一致）又发微信（用户当场看到）。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    _answered_handoff(db, binding, session, answered_ago_minutes=45)
    _user_event(db, binding, minutes_ago=120)

    handoff_sweeper.sweep_idle_handoffs(db)

    notices = db.exec(
        select(Message).where(
            Message.session_id == session.id,
            Message.role == "assistant",
        )
    ).all()
    assert len(notices) == 1
    content = notices[0].content
    assert "30" in content
    assert "/转人工" in content
    assert "客服小李" in content
    assert notices[0].metadata_json["handoff_auto_closed"] is True

    sent = _no_real_wechat
    assert len(sent) == 1
    to_user, ctx, text = sent[0]
    assert to_user == "wxuser_h"
    assert ctx == "ctx-token"
    assert text == content


def test_agent_event_recorded(db, binding, _no_real_wechat):
    _admin(db)
    _agent(db)
    session = _session(db)
    handoff = _answered_handoff(db, binding, session, answered_ago_minutes=40)

    handoff_sweeper.sweep_idle_handoffs(db)

    events = db.exec(
        select(AgentEvent).where(AgentEvent.event_type == "human_handoff_auto_closed")
    ).all()
    assert len(events) == 1
    assert events[0].payload_json["handoff_id"] == handoff.id


# ---- 不该结束的分支 -------------------------------------------------------


def test_user_spoke_within_window_blocks(db, binding, _no_real_wechat):
    """用户问了跟进问题 → 这次人工协助还在进行，下个周期再看。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    handoff = _answered_handoff(db, binding, session, answered_ago_minutes=40)
    _user_event(db, binding, minutes_ago=5)

    assert handoff_sweeper.sweep_idle_handoffs(db) == 0
    db.refresh(handoff)
    assert not handoff.metadata_json.get("auto_closed_at")
    db.refresh(session)
    assert session.status == "handoff"


def test_recent_answered_handoff_not_swept(db, binding, _no_real_wechat):
    """还没到 30 分钟，不能提前结束。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    handoff = _answered_handoff(db, binding, session, answered_ago_minutes=10)
    _user_event(db, binding, minutes_ago=180)

    assert handoff_sweeper.sweep_idle_handoffs(db) == 0
    db.refresh(handoff)
    assert not handoff.metadata_json.get("auto_closed_at")


def test_pending_handoff_untouched(db, binding, _no_real_wechat):
    """pending（人工还没回）不归超时管——那属于催办，不是静默结束。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    handoff = _answered_handoff(db, binding, session, answered_ago_minutes=40)
    handoff.status = "pending"
    handoff.answered_at = None
    db.add(handoff)
    db.commit()

    assert handoff_sweeper.sweep_idle_handoffs(db) == 0
    db.refresh(session)
    assert session.status == "handoff"


def test_non_wechat_handoff_untouched(db, binding, _no_real_wechat):
    """站内转人工没有微信静默这一说，不能被误收尾。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    handoff = _answered_handoff(
        db, binding, session, answered_ago_minutes=40, channel="web"
    )

    assert handoff_sweeper.sweep_idle_handoffs(db) == 0
    db.refresh(handoff)
    assert not handoff.metadata_json.get("auto_closed_at")


def test_already_closed_not_closed_twice(db, binding, _no_real_wechat):
    """幂等：重复扫描不会重复发提示。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    _answered_handoff(db, binding, session, answered_ago_minutes=40)

    assert handoff_sweeper.sweep_idle_handoffs(db) == 1
    assert handoff_sweeper.sweep_idle_handoffs(db) == 0

    notices = db.exec(
        select(Message).where(
            Message.session_id == session.id,
            Message.role == "assistant",
        )
    ).all()
    assert len(notices) == 1


def test_idle_minutes_override(db, binding, _no_real_wechat):
    """idle_minutes 可调（也用于测试里缩短窗口）。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    _answered_handoff(db, binding, session, answered_ago_minutes=8)
    _user_event(db, binding, minutes_ago=180)

    assert handoff_sweeper.sweep_idle_handoffs(db, idle_minutes=5) == 1


def test_now_injectable(db, binding, _no_real_wechat):
    """now 可注入，测试不必 sleep。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    _answered_handoff(db, binding, session, answered_ago_minutes=5)
    _user_event(db, binding, minutes_ago=180)

    future = utc_now() + timedelta(minutes=40)
    assert handoff_sweeper.sweep_idle_handoffs(db, now=future) == 1


# ---- 提示发不出去时 -------------------------------------------------------


def test_missing_context_token_still_closes(db, binding, _no_real_wechat):
    """拿不到 context_token（用户很久没开口）→ 微信发不出去，但状态仍要结束、落库仍要留。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    _answered_handoff(db, binding, session, answered_ago_minutes=40)
    # 故意不造入站事件 → 无 token

    assert handoff_sweeper.sweep_idle_handoffs(db) == 1
    assert _no_real_wechat == []  # 没发出去
    notices = db.exec(
        select(Message).where(Message.session_id == session.id, Message.role == "assistant")
    ).all()
    assert len(notices) == 1  # 但网页端看得到
    db.refresh(session)
    assert session.status == "active"


def test_inactive_binding_skips_push(db, binding, _no_real_wechat):
    """绑已断开：微信发不了，状态照样结束。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    _answered_handoff(db, binding, session, answered_ago_minutes=40)
    _user_event(db, binding, minutes_ago=120)
    binding.status = "disconnected"
    db.add(binding)
    db.commit()

    assert handoff_sweeper.sweep_idle_handoffs(db) == 1
    assert _no_real_wechat == []
    db.refresh(session)
    assert session.status == "active"


def test_notify_crash_does_not_break_sweep(db, binding, monkeypatch):
    """通知抛异常不能把已经结束的状态回滚掉。"""
    _admin(db)
    _agent(db)
    session = _session(db)
    handoff = _answered_handoff(db, binding, session, answered_ago_minutes=40)
    _user_event(db, binding, minutes_ago=120)

    def _boom(*a, **k):
        raise RuntimeError("network down")

    monkeypatch.setattr(handoff_sweeper, "_notify", _boom)

    assert handoff_sweeper.sweep_idle_handoffs(db) == 1
    db.refresh(handoff)
    assert handoff.metadata_json.get("auto_closed_at")
    db.refresh(session)
    assert session.status == "active"


# ---- 线程生命周期 ---------------------------------------------------------


def test_start_is_idempotent():
    handoff_sweeper.stop_handoff_sweeper()
    try:
        handoff_sweeper.start_handoff_sweeper(interval_seconds=30)
        first = handoff_sweeper._sweeper_thread
        handoff_sweeper.start_handoff_sweeper(interval_seconds=30)
        assert handoff_sweeper._sweeper_thread is first
        assert first.is_alive()
        assert first.daemon is True
    finally:
        handoff_sweeper.stop_handoff_sweeper()
        if handoff_sweeper._sweeper_thread is not None:
            handoff_sweeper._sweeper_thread.join(timeout=5)


def test_stop_sets_event():
    handoff_sweeper.start_handoff_sweeper(interval_seconds=30)
    try:
        assert not handoff_sweeper._stop_event.is_set()
        handoff_sweeper.stop_handoff_sweeper()
        assert handoff_sweeper._stop_event.is_set()
    finally:
        if handoff_sweeper._sweeper_thread is not None:
            handoff_sweeper._sweeper_thread.join(timeout=5)