"""模型闸门（app/agents/model_policy.py）：所有渠道共用的一套规则。

重点验证三件事：
1. 免费员工：无自有模型才消耗配额，且各渠道一视同仁；
2. 非免费员工：没模型一律拒绝（不再静默回落到租户默认模型）；
3. 幂等重放与内部轮次不会重复扣减配额。
"""

from __future__ import annotations

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.agents.free_model import (
    FREE_MODEL_DAILY_LIMIT,
    FREE_MODEL_QUOTA_EXHAUSTED_CODE,
    remaining_free_quota,
)
from app.agents.model_policy import MODEL_REQUIRED_CODE, check_turn_model_policy
from app.db.models import AgentProfile, HarnessTurnRecord, ModelConfig, Tenant, User
from app.session.session_schema import ChatTurnRequest


def _test_session() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _seed(db: Session) -> tuple[User, User]:
    db.add(Tenant(id="tenant_demo", name="演示租户"))
    admin = User(
        id="user_admin", tenant_id="tenant_demo", username="admin", role="admin", password_hash="x"
    )
    member = User(
        id="user_member", tenant_id="tenant_demo", username="member", role="member", password_hash="x"
    )
    db.add_all([admin, member])
    db.commit()
    return admin, member


def _model(db: Session, owner: User, config_id: str, *, is_default: bool = False) -> ModelConfig:
    row = ModelConfig(
        id=config_id,
        tenant_id=owner.tenant_id,
        user_id=owner.id,
        name=config_id,
        api_key_encrypted="enc",
        model="test-model",
        enabled=True,
        is_default=is_default,
    )
    db.add(row)
    db.commit()
    return row


def _agent(db: Session, agent_id: str, *, free: bool = False) -> AgentProfile:
    row = AgentProfile(
        id=agent_id,
        tenant_id="tenant_demo",
        name=f"员工{agent_id}",
        is_overall=False,
        free_model_enabled=free,
    )
    db.add(row)
    db.commit()
    return row


def _global_free(db: Session, admin: User, config_id: str = "model_free") -> ModelConfig:
    row = ModelConfig(
        id=config_id,
        tenant_id="tenant_demo",
        user_id=admin.id,
        name=config_id,
        api_key_encrypted="enc",
        model="free-model",
        enabled=True,
        is_global_free=True,
    )
    db.add(row)
    db.commit()
    return row


def _req(
    agent_id: str,
    user_id: str = "user_member",
    *,
    channel: str = "web",
    model_config_id: str | None = None,
    session_id: str | None = None,
    client_turn_id: str | None = None,
    visibility: str = "visible",
) -> ChatTurnRequest:
    return ChatTurnRequest(
        tenant_id="tenant_demo",
        agent_id=agent_id,
        user_id=user_id,
        message="你好",
        channel=channel,
        model_config_id=model_config_id,
        session_id=session_id,
        client_turn_id=client_turn_id,
        message_visibility=visibility,
    )


# ---- 免费员工 -------------------------------------------------------------


def test_free_agent_without_global_model_is_rejected_with_clear_reason() -> None:
    with _test_session() as db:
        _seed(db)
        _agent(db, "agent_free", free=True)

        decision = check_turn_model_policy(db, _req("agent_free"))

        assert decision.allowed is False
        assert decision.code == "no_global_free_model"
        # 指出「是管理员没配」，而不是让使用者去配模型
        assert "管理员" in decision.message


def test_free_agent_consumes_one_quota_per_turn() -> None:
    with _test_session() as db:
        admin, member = _seed(db)
        _global_free(db, admin)
        _agent(db, "agent_free", free=True)

        before = remaining_free_quota(db, "tenant_demo", member.id, "agent_free")
        decision = check_turn_model_policy(db, _req("agent_free"))
        after = remaining_free_quota(db, "tenant_demo", member.id, "agent_free")

        assert decision.allowed is True
        assert decision.consumed is True
        assert after == before - 1


def test_free_agent_rejects_when_quota_exhausted() -> None:
    with _test_session() as db:
        admin, member = _seed(db)
        _global_free(db, admin)
        _agent(db, "agent_free", free=True)

        for _ in range(FREE_MODEL_DAILY_LIMIT):
            assert check_turn_model_policy(db, _req("agent_free")).allowed is True

        decision = check_turn_model_policy(db, _req("agent_free"))
        assert decision.allowed is False
        assert decision.code == FREE_MODEL_QUOTA_EXHAUSTED_CODE
        assert str(FREE_MODEL_DAILY_LIMIT) in decision.message
        # 被拒的这轮不能再扣（否则会把「明天恢复」变成永不满额）
        assert remaining_free_quota(db, "tenant_demo", member.id, "agent_free") == 0


def test_free_agent_user_with_own_model_does_not_consume_quota() -> None:
    with _test_session() as db:
        admin, member = _seed(db)
        _global_free(db, admin)
        _model(db, member, "model_member", is_default=True)
        _agent(db, "agent_free", free=True)

        decision = check_turn_model_policy(db, _req("agent_free"))

        assert decision.allowed is True
        assert decision.consumed is False
        assert remaining_free_quota(db, "tenant_demo", member.id, "agent_free") == FREE_MODEL_DAILY_LIMIT


# ---- 非免费员工 -----------------------------------------------------------


def test_paid_agent_requires_own_model() -> None:
    with _test_session() as db:
        admin, _member = _seed(db)
        # 租户里有管理员配的默认模型，但**不能**让没配模型的成员静默蹭用
        _model(db, admin, "model_admin_default", is_default=True)
        _agent(db, "agent_paid")

        decision = check_turn_model_policy(db, _req("agent_paid"))

        assert decision.allowed is False
        assert decision.code == MODEL_REQUIRED_CODE
        assert "模型配置" in decision.message


def test_paid_agent_allows_user_with_own_model() -> None:
    with _test_session() as db:
        _seed(db)
        member = db.get(User, "user_member")
        assert member is not None
        _model(db, member, "model_member", is_default=True)
        _agent(db, "agent_paid")

        decision = check_turn_model_policy(db, _req("agent_paid"))

        assert decision.allowed is True
        assert decision.consumed is False


# ---- 全渠道一致性 ---------------------------------------------------------


def test_same_policy_applies_to_every_channel() -> None:
    """微信/定时任务/公开 API 不比站内宽松——这是本次改造的核心目的。"""
    with _test_session() as db:
        admin, member = _seed(db)
        _global_free(db, admin)
        _agent(db, "agent_free", free=True)
        _agent(db, "agent_paid")
        # 关键：这个成员**没有**自己的模型，所以付费员工在任何渠道都必须被拒
        assert member.id == "user_member"

        for channel in ("web", "wechat", "public_api"):
            assert check_turn_model_policy(db, _req("agent_paid", channel=channel)).allowed is False, channel

        # 免费员工在各渠道都放行
        for channel in ("web", "wechat", "public_api"):
            assert check_turn_model_policy(db, _req("agent_free", channel=channel)).allowed is True, channel

        # 定时任务不因缺模型被拒（创建任务时并未要求选模型）
        assert check_turn_model_policy(db, _req("agent_paid", channel="scheduled_task")).allowed is True


def test_wechat_free_agent_consumes_quota_like_web() -> None:
    """改造前微信绕过配额：这条用例锁住回归。"""
    with _test_session() as db:
        admin, member = _seed(db)
        _global_free(db, admin)
        _agent(db, "agent_free", free=True)

        decision = check_turn_model_policy(db, _req("agent_free", channel="wechat"))

        assert decision.allowed is True
        assert decision.consumed is True
        assert remaining_free_quota(db, "tenant_demo", member.id, "agent_free") == FREE_MODEL_DAILY_LIMIT - 1


# ---- 免扣减的场景 ---------------------------------------------------------


def test_explicit_model_config_skips_gate() -> None:
    """显式选模型（含分享链接强制注入）由用户自己负责，闸门不介入。"""
    with _test_session() as db:
        _seed(db)
        member = db.get(User, "user_member")
        assert member is not None
        _model(db, member, "model_member")
        _agent(db, "agent_paid")

        decision = check_turn_model_policy(db, _req("agent_paid", model_config_id="model_member"))

        assert decision.allowed is True
        assert decision.consumed is False


def test_internal_visibility_turn_is_not_charged() -> None:
    with _test_session() as db:
        admin, member = _seed(db)
        _global_free(db, admin)
        _agent(db, "agent_free", free=True)

        decision = check_turn_model_policy(db, _req("agent_free", visibility="internal"))

        assert decision.allowed is True
        assert decision.consumed is False
        assert remaining_free_quota(db, "tenant_demo", member.id, "agent_free") == FREE_MODEL_DAILY_LIMIT


def test_handoff_resume_turn_is_not_charged() -> None:
    """人工恢复轮是补发已经回答过的内容，再扣一次等于对同一问题收两次费。"""
    with _test_session() as db:
        admin, member = _seed(db)
        _global_free(db, admin)
        _agent(db, "agent_free", free=True)

        decision = check_turn_model_policy(
            db, _req("agent_free", channel="human_handoff_resume")
        )

        assert decision.allowed is True
        assert decision.consumed is False
        assert remaining_free_quota(db, "tenant_demo", member.id, "agent_free") == FREE_MODEL_DAILY_LIMIT


def test_replayed_turn_does_not_double_charge() -> None:
    """同一 client_turn_id 重投（网络重试/轮询重连）不能扣两次。"""
    with _test_session() as db:
        admin, member = _seed(db)
        _global_free(db, admin)
        _agent(db, "agent_free", free=True)
        db.add(
            HarnessTurnRecord(
                tenant_id="tenant_demo",
                session_id="session_x",
                client_turn_id="turn_x",
                request_digest="digest",
                lease_owner="owner",
                lease_expires_at=__import__("datetime").datetime(2099, 1, 1),
            )
        )
        db.commit()

        decision = check_turn_model_policy(
            db,
            _req("agent_free", session_id="session_x", client_turn_id="turn_x"),
        )

        assert decision.allowed is True
        assert decision.consumed is False
        assert remaining_free_quota(db, "tenant_demo", member.id, "agent_free") == FREE_MODEL_DAILY_LIMIT


def test_turn_without_agent_is_ignored() -> None:
    with _test_session() as db:
        _seed(db)
        request = ChatTurnRequest(
            tenant_id="tenant_demo", agent_id=None, user_id="user_member", message="hi"
        )
        assert check_turn_model_policy(db, request).allowed is True


def test_wechat_service_request_shape_is_gated() -> None:
    """按 app/wechat/service.py:_run_turn 真实构造的请求，验证微信不再绕过闸门。

    这段字段集必须与 _run_turn 保持一致（channel="wechat" + client_turn_id=event_id）；
    若将来微信侧改了字段而这里没跟，说明闸门的判断前提变了，需要回来复核。
    """
    with _test_session() as db:
        _seed(db)
        _agent(db, "agent_paid")

        request = ChatTurnRequest(
            tenant_id="tenant_demo",
            session_id="session_wechat",
            agent_id="agent_paid",
            user_id="user_member",
            message="帮我查一下库存",
            channel="wechat",
            client_turn_id="event_abc",
        )

        decision = check_turn_model_policy(db, request)
        assert decision.allowed is False
        assert decision.code == MODEL_REQUIRED_CODE