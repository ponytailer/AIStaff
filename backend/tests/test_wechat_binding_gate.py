"""微信接入的两条互斥规则（2026-11-20）。

用户诉求：「如果配置成功一个了，那么就不允许再配置了，因此『扫码接入』要灰掉；
断开以后允许删除。」

前端负责置灰，后端负责防绕过——旧页面缓存、直接调接口、两个人并发扫码，都必须
被挡住。所以这里只测服务端：409 的触发条件、删除的前置校验、以及「别人的微信
我看得到但改不了」这条边界（管理员例外）。
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from app.api import wechat as wechat_api
from app.db import get_session
from app.db.models import AgentProfile, User, WechatBinding, WechatBindingAgent
from app.security.auth import get_current_user

BASE = "/api/enterprise/wechat"
TENANT = "tenant_wx"


# ---- 夹具 -----------------------------------------------------------------


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


def make_user(
    db: Session,
    user_id: str,
    *,
    role: str = "member",
    tenant_id: str = TENANT,
    source: str = "web",
) -> User:
    row = User(
        id=user_id,
        tenant_id=tenant_id,
        username=user_id,
        display_name=user_id,
        role=role,
        source=source,
        password_hash="x",
    )
    db.add(row)
    db.commit()
    return row


def make_binding(
    db: Session,
    binding_id: str,
    *,
    owner: str,
    status: str = "active",
    tenant_id: str = TENANT,
) -> WechatBinding:
    row = WechatBinding(
        id=binding_id,
        tenant_id=tenant_id,
        owner_user_id=owner,
        ilink_bot_id=f"bot_{binding_id}",
        bot_token_enc="",
        status=status,
        display_name="我的微信",
    )
    db.add(row)
    db.commit()
    return row


def make_agent(db: Session, agent_id: str, *, owner: str) -> AgentProfile:
    row = AgentProfile(
        id=agent_id,
        tenant_id=TENANT,
        name=agent_id,
        status="active",
        metadata_json={"owner_user_id": owner},
    )
    db.add(row)
    db.commit()
    return row


def client_for(db: Session, user: User) -> TestClient:
    app = FastAPI()
    app.include_router(wechat_api.router)
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


# ---- 扫码互斥 -------------------------------------------------------------


def test_second_qrcode_blocked_when_already_active(db):
    """已有一条 active → 直接 409，不许静默换绑。"""
    user = make_user(db, "u1")
    make_binding(db, "bind_1", owner="u1")
    client = client_for(db, user)

    response = client.post(f"{BASE}/qrcode", params={"tenant_id": TENANT})

    assert response.status_code == 409
    assert "断开" in response.json()["detail"]


def test_qrcode_allowed_after_disconnect(db):
    """断开之后可以重新扫码接入。"""
    user = make_user(db, "u1")
    make_binding(db, "bind_1", owner="u1", status="disconnected")
    client = client_for(db, user)

    # 走到真发 HTTP 会 502（沙箱无外网），但至少不是 409：说明互斥已被解除
    response = client.post(f"{BASE}/qrcode", params={"tenant_id": TENANT})

    assert response.status_code != 409


def test_qrcode_gate_is_per_user(db):
    """别人接的微信不挡我自己接。"""
    make_user(db, "u1")
    other = make_user(db, "u2")
    make_binding(db, "bind_1", owner="u1")
    client = client_for(db, other)

    response = client.post(f"{BASE}/qrcode", params={"tenant_id": TENANT})

    assert response.status_code != 409


def test_admin_also_gated_by_own_binding_only(db):
    """管理员身份不豁免这条规则——它约束的是「我的微信」，不是租户配额。"""
    admin = make_user(db, "admin1", role="admin")
    make_binding(db, "bind_member", owner="u1")
    make_binding(db, "bind_admin", owner="admin1")
    client = client_for(db, admin)

    assert client.post(f"{BASE}/qrcode", params={"tenant_id": TENANT}).status_code == 409


# ---- 删除前置校验 ---------------------------------------------------------


def test_delete_active_binding_rejected(db):
    """active 不许直接删：先断开，让用户明确知道这个微信不再接了。"""
    user = make_user(db, "u1")
    make_binding(db, "bind_1", owner="u1")
    client = client_for(db, user)

    response = client.delete(f"{BASE}/bindings/bind_1", params={"tenant_id": TENANT})

    assert response.status_code == 409
    assert "断开" in response.json()["detail"]
    assert db.get(WechatBinding, "bind_1") is not None


def test_delete_disconnected_binding_succeeds(db):
    """disconnected → 可删，挂载配置一并清掉，会话消息不删。"""
    user = make_user(db, "u1")
    make_binding(db, "bind_1", owner="u1", status="disconnected")
    make_agent(db, "agent_1", owner="u1")
    db.add(
        WechatBindingAgent(
            tenant_id=TENANT,
            binding_id="bind_1",
            agent_id="agent_1",
            is_default=True,
            sort_order=0,
        )
    )
    db.commit()
    client = client_for(db, user)

    response = client.delete(f"{BASE}/bindings/bind_1", params={"tenant_id": TENANT})

    assert response.status_code == 200
    assert db.get(WechatBinding, "bind_1") is None
    left = db.exec(
        select(WechatBindingAgent).where(WechatBindingAgent.binding_id == "bind_1")
    ).all()
    assert left == []


def test_member_cannot_delete_others_binding(db):
    """别人的微信：一律当作不存在，不给「其实存在但你没权限」的信息。"""
    make_user(db, "u1")
    other = make_user(db, "u2")
    make_binding(db, "bind_1", owner="u1", status="disconnected")
    client = client_for(db, other)

    response = client.delete(f"{BASE}/bindings/bind_1", params={"tenant_id": TENANT})

    assert response.status_code == 404
    assert db.get(WechatBinding, "bind_1") is not None


def test_admin_can_delete_member_binding(db):
    """管理员例外：排障时需要能收口（但仍需先断开）。"""
    admin = make_user(db, "admin1", role="admin")
    make_binding(db, "bind_1", owner="u1", status="disconnected")
    client = client_for(db, admin)

    response = client.delete(f"{BASE}/bindings/bind_1", params={"tenant_id": TENANT})

    assert response.status_code == 200
    assert db.get(WechatBinding, "bind_1") is None


# ---- owned_by_me 字段 -----------------------------------------------------


def test_binding_read_marks_foreign_rows_for_admin(db):
    """管理员看别人的绑定：owned_by_me=False，前端据此不显示「断开」。"""
    admin = make_user(db, "admin1", role="admin")
    make_binding(db, "bind_mine", owner="admin1")
    make_binding(db, "bind_other", owner="u1", status="disconnected")
    client = client_for(db, admin)

    response = client.get(f"{BASE}/bindings", params={"tenant_id": TENANT})

    assert response.status_code == 200
    rows = {row["id"]: row for row in response.json()}
    assert set(rows) == {"bind_mine", "bind_other"}
    assert rows["bind_mine"]["owned_by_me"] is True
    assert rows["bind_other"]["owned_by_me"] is False


def test_member_only_sees_own_binding(db):
    make_user(db, "u1")
    member = make_user(db, "u2")
    make_binding(db, "bind_1", owner="u1")
    make_binding(db, "bind_2", owner="u2")
    client = client_for(db, member)

    response = client.get(f"{BASE}/bindings", params={"tenant_id": TENANT})

    assert response.status_code == 200
    rows = response.json()
    assert [row["id"] for row in rows] == ["bind_2"]
    assert rows[0]["owned_by_me"] is True