"""`GET /api/enterprise/model-configs/export-credentials` 的行为与安全边界。

这个接口是全站唯一返回明文 api_key 的地方，所以测试重点不只是「能返回」，
更是「只返回调用者自己的」和「坏数据不拖垮整个响应」。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.api.model_configs_sync import _normalize_for_openai_client
from app.api.model_configs_sync import router as sync_router
from app.db import get_session
from app.db.models import ModelConfig, Tenant, User
from app.security.auth import create_access_token
from app.security.encryption import encrypt_secret

EXPORT_PATH = "/api/enterprise/model-configs/export-credentials"


# --------------------------------------------------------------------------- #
# 测试脚手架
# --------------------------------------------------------------------------- #


def _engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _seed_tenant(engine) -> None:
    with Session(engine) as db:
        db.add(Tenant(id="tenant_a", name="Tenant A"))
        db.commit()


def _add_user(engine, user_id: str, *, tenant_id: str = "tenant_a") -> User:
    with Session(engine) as db:
        user = User(
            id=user_id,
            tenant_id=tenant_id,
            username=user_id,
            role="member",
            password_hash="unused",
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        db.expunge(user)
        return user


def _add_model(
    engine,
    *,
    model_id: str,
    user_id: str,
    api_key: str,
    base_url: str | None = "https://api.deepseek.com",
    api_protocol: str = "openai_chat_completions",
    name: str | None = None,
    model: str = "deepseek-chat",
    tenant_id: str = "tenant_a",
    is_default: bool = False,
    enabled: bool = True,
    is_global_free: bool = False,
    updated_at: datetime | None = None,
) -> None:
    fields: dict = {}
    if updated_at is not None:
        # 只有排序用例需要控制时间戳；不给就落库默认值，避免影响其他用例。
        fields = {"updated_at": updated_at, "created_at": updated_at}
    with Session(engine) as db:
        db.add(
            ModelConfig(
                id=model_id,
                tenant_id=tenant_id,
                user_id=user_id,
                name=name or model_id,
                api_key_encrypted=encrypt_secret(api_key),
                model=model,
                base_url=base_url,
                api_protocol=api_protocol,
                trust_status="verified",
                is_default=is_default,
                enabled=enabled,
                is_global_free=is_global_free,
                **fields,
            )
        )
        db.commit()


def _add_raw_model(engine, **kwargs) -> None:
    """直接写库、不经 encrypt_secret —— 用于构造「解密失败」的坏数据。"""
    with Session(engine) as db:
        db.add(ModelConfig(**kwargs))
        db.commit()


def _client(engine) -> TestClient:
    app = FastAPI()
    app.include_router(sync_router)

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app)


def _client_with_crud_router(engine) -> TestClient:
    """按 main.py 的顺序先挂 model_configs，再挂 model_configs_sync。

    护栏：CRUD 路由里有 `/{config_id}`，若哪天给它加了 GET，这里会先命中
    `export-credentials` 之外的解释器 —— 本用例会在那时失败。
    """
    from app.api.model_configs import router as crud_router

    app = FastAPI()
    app.include_router(crud_router)
    app.include_router(sync_router)

    def override_get_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app)


def _auth(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user)}"}


def _get(client: TestClient, token: dict[str, str] | None, tenant_id: str = "tenant_a"):
    return client.get(EXPORT_PATH, params={"tenant_id": tenant_id}, headers=token or {})


# --------------------------------------------------------------------------- #
# 1. 正常返回
# --------------------------------------------------------------------------- #


def test_export_returns_plaintext_keys_for_own_models() -> None:
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    _add_model(engine, model_id="model_1", user_id="user_alice", api_key="sk-alice-one")
    _add_model(
        engine,
        model_id="model_2",
        user_id="user_alice",
        api_key="sk-alice-two",
        base_url="https://api.openai.com/v1",
        name="Second",
    )

    response = _get(_client(engine), _auth(alice))

    assert response.status_code == 200
    payload = response.json()
    assert len(payload) == 2
    keys = {item["id"]: item["api_key"] for item in payload}
    # 明文，不是打码值
    assert keys == {"model_1": "sk-alice-one", "model_2": "sk-alice-two"}
    assert "****" not in response.text


def test_export_item_carries_all_contract_fields() -> None:
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    _add_model(
        engine,
        model_id="model_1",
        user_id="user_alice",
        api_key="sk-alice",
        name="DeepSeek",
        model="deepseek-chat",
        is_default=True,
    )

    payload = _get(_client(engine), _auth(alice)).json()

    assert payload[0] == {
        "id": "model_1",
        "name": "DeepSeek",
        "model": "deepseek-chat",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "sk-alice",
        "api_protocol": "openai_chat_completions",
        "provider": "openai_compatible",
        "is_default": True,
        "enabled": True,
        "is_global_free": False,
    }


def test_export_includes_global_free_model_with_flag() -> None:
    """全局免费模型是成员实际在用的模型，同步时必须带上（并打标）。"""
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    _add_model(
        engine,
        model_id="model_free",
        user_id="user_alice",
        api_key="sk-free",
        is_global_free=True,
    )

    payload = _get(_client(engine), _auth(alice)).json()

    assert [item["id"] for item in payload] == ["model_free"]
    assert payload[0]["is_global_free"] is True


def test_export_does_not_hide_global_free_among_normal_models() -> None:
    """混合场景：全局免费模型与自建模型同批出现，一条都不能被默认 filter 吞掉。"""
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    _add_model(engine, model_id="model_own", user_id="user_alice", api_key="sk-own")
    _add_model(
        engine,
        model_id="model_free",
        user_id="user_alice",
        api_key="sk-free",
        is_global_free=True,
    )

    payload = _get(_client(engine), _auth(alice)).json()

    assert {item["id"] for item in payload} == {"model_own", "model_free"}
    assert {item["id"]: item["is_global_free"] for item in payload} == {
        "model_own": False,
        "model_free": True,
    }


def test_export_does_not_filter_disabled_models() -> None:
    """禁用的配置也要返回（带 enabled=false），让用户在 s2c 侧自己判断能否用。"""
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    _add_model(engine, model_id="model_on", user_id="user_alice", api_key="sk-on")
    _add_model(
        engine,
        model_id="model_off",
        user_id="user_alice",
        api_key="sk-off",
        enabled=False,
    )

    payload = _get(_client(engine), _auth(alice)).json()

    assert {item["id"]: item["enabled"] for item in payload} == {
        "model_on": True,
        "model_off": False,
    }


def test_export_sorts_default_first_then_most_recently_updated() -> None:
    """排序契约：is_default 优先，其次 updated_at 倒序。

    s2c 侧靠这个顺序实现「只有一个时直接填入」和「多个时弹窗默认选中第一个」，
    所以顺序本身是接口契约的一部分，必须锁住。
    """
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    now = datetime.now(UTC)
    # 故意让 default 那条最老，验证 is_default 的优先级高于 updated_at
    _add_model(
        engine,
        model_id="model_default_oldest",
        user_id="user_alice",
        api_key="sk-default",
        is_default=True,
        updated_at=now - timedelta(days=30),
    )
    _add_model(
        engine,
        model_id="model_recent",
        user_id="user_alice",
        api_key="sk-recent",
        updated_at=now - timedelta(hours=1),
    )
    _add_model(
        engine,
        model_id="model_older",
        user_id="user_alice",
        api_key="sk-older",
        updated_at=now - timedelta(days=7),
    )

    payload = _get(_client(engine), _auth(alice)).json()

    assert [item["id"] for item in payload] == [
        "model_default_oldest",
        "model_recent",
        "model_older",
    ]


def test_export_order_is_stable_across_requests() -> None:
    """同一份数据重复请求，顺序必须一致（id 兜底排序防止时间戳相等时抖动）。"""
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    same_time = datetime.now(UTC)
    for model_id in ("model_c", "model_a", "model_b"):
        _add_model(
            engine,
            model_id=model_id,
            user_id="user_alice",
            api_key=f"sk-{model_id}",
            updated_at=same_time,
        )

    client = _client(engine)
    first = [item["id"] for item in _get(client, _auth(alice)).json()]
    second = [item["id"] for item in _get(client, _auth(alice)).json()]

    assert first == second
    assert first == ["model_a", "model_b", "model_c"]


def test_export_route_wins_over_crud_config_id_route() -> None:
    """与 main.py 相同的挂载顺序下，`export-credentials` 不能被 `/{config_id}` 吞掉。"""
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    _add_model(engine, model_id="model_1", user_id="user_alice", api_key="sk-alice")

    client = _client_with_crud_router(engine)
    response = _get(client, _auth(alice))

    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == ["model_1"]


# --------------------------------------------------------------------------- #
# 2. 越权防护
# --------------------------------------------------------------------------- #


def test_export_never_leaks_other_users_models() -> None:
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    _add_user(engine, "user_bob")
    _add_model(engine, model_id="model_alice", user_id="user_alice", api_key="sk-alice")
    _add_model(engine, model_id="model_bob", user_id="user_bob", api_key="sk-bob")

    payload = _get(_client(engine), _auth(alice)).json()

    assert [item["id"] for item in payload] == ["model_alice"]
    assert "sk-bob" not in str(payload)


def test_export_never_leaks_models_from_another_tenant() -> None:
    engine = _engine()
    _seed_tenant(engine)
    with Session(engine) as db:
        db.add(Tenant(id="tenant_b", name="Tenant B"))
        db.commit()
    alice = _add_user(engine, "user_alice")
    _add_user(engine, "user_carol", tenant_id="tenant_b")
    _add_model(engine, model_id="model_alice", user_id="user_alice", api_key="sk-alice")
    _add_model(
        engine,
        model_id="model_carol",
        user_id="user_carol",
        api_key="sk-carol",
        tenant_id="tenant_b",
    )

    payload = _get(_client(engine), _auth(alice)).json()

    assert [item["id"] for item in payload] == ["model_alice"]
    # 响应里也不该出现他人租户标识
    assert "tenant_b" not in str(payload)


def test_export_rejects_tenant_mismatch() -> None:
    engine = _engine()
    _seed_tenant(engine)
    with Session(engine) as db:
        db.add(Tenant(id="tenant_b", name="Tenant B"))
        db.commit()
    alice = _add_user(engine, "user_alice")

    response = _get(_client(engine), _auth(alice), tenant_id="tenant_b")

    assert response.status_code == 403


# --------------------------------------------------------------------------- #
# 3-7. base_url 规整
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "protocol", "expected"),
    [
        # 3. 根地址补 /v1
        ("https://api.deepseek.com", "openai_chat_completions", "https://api.deepseek.com/v1"),
        ("https://api.deepseek.com/", "openai_chat_completions", "https://api.deepseek.com/v1"),
        ("https://api.deepseek.com", "openai_responses", "https://api.deepseek.com/v1"),
        # 4. 已带 /v1 不重复加
        ("https://api.openai.com/v1", "openai_chat_completions", "https://api.openai.com/v1"),
        ("https://api.openai.com/v1/", "openai_chat_completions", "https://api.openai.com/v1"),
        # 5. 已指向具体端点 → 截断到 /v1
        (
            "https://api.openai.com/v1/chat/completions",
            "openai_chat_completions",
            "https://api.openai.com/v1",
        ),
        (
            "https://api.openai.com/v1/completions",
            "openai_chat_completions",
            "https://api.openai.com/v1",
        ),
        (
            "https://api.openai.com/v1/responses",
            "openai_responses",
            "https://api.openai.com/v1",
        ),
        # 端点但根地址本身（少见，仍应补 /v1 而不是留空 path）
        (
            "https://gw.example.com/chat/completions",
            "openai_chat_completions",
            "https://gw.example.com/v1",
        ),
        # 从文档里复制来的、带尾斜杠的完整端点
        (
            "https://api.openai.com/v1/chat/completions/",
            "openai_chat_completions",
            "https://api.openai.com/v1",
        ),
        # 6. 定制路径原样保留
        (
            "https://gw.example.com/compatible-mode/v1",
            "openai_chat_completions",
            "https://gw.example.com/compatible-mode/v1",
        ),
        ("https://gw.example.com/api/v3", "openai_chat_completions", "https://gw.example.com/api/v3"),
        # 7. 非 OpenAI 协议原样返回
        ("https://api.anthropic.com", "anthropic_messages", "https://api.anthropic.com"),
        (
            "https://llm-center.modelbest.cn/llm",
            "gemini_generate_content",
            "https://llm-center.modelbest.cn/llm",
        ),
        # 边界：None / 空串
        (None, "openai_chat_completions", None),
        ("", "openai_chat_completions", ""),
        # query / fragment 不丢
        (
            "https://gw.example.com?x=1#frag",
            "openai_chat_completions",
            "https://gw.example.com/v1?x=1#frag",
        ),
    ],
)
def test_normalize_for_openai_client(raw, protocol, expected) -> None:
    assert _normalize_for_openai_client(raw, protocol) == expected


def test_export_normalizes_base_url_end_to_end() -> None:
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    _add_model(
        engine,
        model_id="model_1",
        user_id="user_alice",
        api_key="sk-alice",
        base_url="https://api.deepseek.com",
    )
    _add_model(
        engine,
        model_id="model_2",
        user_id="user_alice",
        api_key="sk-alice-2",
        base_url="https://api.openai.com/v1/chat/completions",
    )

    payload = {item["id"]: item["base_url"] for item in _get(_client(engine), _auth(alice)).json()}

    assert payload == {
        "model_1": "https://api.deepseek.com/v1",
        "model_2": "https://api.openai.com/v1",
    }


# --------------------------------------------------------------------------- #
# 8. 解密失败
# --------------------------------------------------------------------------- #


def test_undecryptable_row_is_skipped_not_fatal(caplog) -> None:
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    _add_model(engine, model_id="model_good", user_id="user_alice", api_key="sk-good")
    # 模拟旧 APP_SECRET 加密的历史数据：Fernet token 语法合法但解不开
    _add_raw_model(
        engine,
        id="model_broken",
        tenant_id="tenant_a",
        user_id="user_alice",
        name="Legacy",
        model="legacy-model",
        base_url="https://legacy.example.com",
        api_key_encrypted="gAAAAABlegacyTokenThatCannotBeDecrypted",
        trust_status="verified",
    )

    with caplog.at_level("WARNING"):
        response = _get(_client(engine), _auth(alice))

    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == ["model_good"]
    assert any("model_broken" in record.getMessage() for record in caplog.records)


def test_empty_encrypted_key_is_skipped() -> None:
    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    _add_raw_model(
        engine,
        id="model_no_key",
        tenant_id="tenant_a",
        user_id="user_alice",
        name="No key",
        model="m",
        api_key_encrypted="",
    )

    response = _get(_client(engine), _auth(alice))

    assert response.status_code == 200
    assert response.json() == []


# --------------------------------------------------------------------------- #
# 9. 未鉴权
# --------------------------------------------------------------------------- #


def test_export_requires_authentication() -> None:
    engine = _engine()
    _seed_tenant(engine)

    response = _get(_client(engine), None)

    assert response.status_code == 401
    assert response.json() == {"detail": "Not authenticated"}


def test_export_rejects_invalid_token() -> None:
    engine = _engine()
    _seed_tenant(engine)

    response = _get(_client(engine), {"Authorization": "Bearer not-a-real-token"})

    assert response.status_code == 401


# --------------------------------------------------------------------------- #
# 审计约束：列表接口不因本模块而吐出明文
# --------------------------------------------------------------------------- #


def test_list_model_configs_still_masks_keys() -> None:
    """回归护栏：新增导出接口后，普通列表接口必须继续只返回打码值。"""
    from app.api.model_configs import list_model_configs

    engine = _engine()
    _seed_tenant(engine)
    alice = _add_user(engine, "user_alice")
    _add_model(engine, model_id="model_1", user_id="user_alice", api_key="sk-secret-value")

    with Session(engine) as db:
        refreshed = db.get(User, alice.id)
        assert refreshed is not None
        items = list_model_configs(
            tenant_id="tenant_a",
            include_global_free=False,
            db=db,
            current_user=refreshed,
        )

    assert len(items) == 1
    assert items[0].api_key_masked == "sk--****alue"
    assert items[0].api_key_masked != "sk-secret-value"
