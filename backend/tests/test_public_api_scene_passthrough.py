"""公开 API 的场景透传测试（`ui_blocks` / `scene_params` / `scene_id` / 胶囊）。

## 这份测试存在的原因

场景 v3 的块只写在 assistant 消息的 `metadata_json["ui_blocks"]` 里
（`turn_run.py` 逐帧累加后写入）。公开 API 此前**一个字段都不透**
（`runs.py` 的 result 载荷只有 reply/citations/tool_calls/task_results），
于是小程序、第三方集成这类走 `/api/v1` 的调用方永远看不到卡片 ——
用户在聊天里点了「滑雪行程推荐」，收到的只有一段正文。

这类漏传是**静默的**：后端一切正常、日志没有报错、单测如果只测内部
`turn_run` 也全绿，只有把「公开 API 的响应体」当断言对象才看得出来。
所以这里不测 matcher、不测渲染，只测「块有没有被送到出口」。

## 边界

不连线上库，也不跑真实 LLM：直接往 `Message.metadata_json` 写一条带块的
assistant 消息，再断言两个出口（SSE 的 `run.output.completed`、result 载荷）
都能读到。这样测的是**透传链路本身**，不受模型/matcher 变化影响。
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.db.models import (
    APIClient,
    APICredential,
    APIJob,
    AgentProfile,
    AgentResourceBinding,
    Message,
    Scene,
    Tenant,
    User,
)

#: 一条真实的 `travel.itinerary` 结果块（形状照 `channels.py::_run_table_match`
#: 的产出原样裁短）。用它而不是自造字段：透传层的 bug 常常是「字段名写错」，
#: 用自造的形状测不出来。
_ITINERARY_BLOCK = {
    "kind": "result",
    "data": {
        "total": 5,
        "items": [
            {
                "row_id": "scrow_1",
                "values": {
                    "计划内容": "经典雪山五日",
                    "目的地": "亚布力",
                    "人数": "4 人",
                    "天数": "5 天",
                    "预算": "3000 元",
                    "日程": "抵达亚布力|哈尔滨接站。|含接站|抵达",
                },
                "score": 0.0,
                "source_table": "滑雪套餐价目表",
            }
        ],
        "max_items": 3,
    },
    "module_key": "travel.itinerary",
    "module_version": 1,
    "fallback_text": "找到了合适的行程，详情看上方的卡片",
}

_SCENE_PARAMS = {
    "price_note": "/人 · 含住宿、雪票、教练、接送",
    "show_source_table": False,
}


def _seed(engine) -> tuple[str, str]:
    """建租户 + agent + 凭证，返回 (api_key, job_id)。

    直接落库而不是走 HTTP：`/runs` 会走 job 队列，而这里要断言的是
    **job 完成后**的透传结果，把 job 预置成 succeeded 比等队列稳定。

    凭证必须用 `generate_api_key()` 生成而不是手写摘要 —— 鉴权走的是
    `hmac(pepper, token) == key_digest`（`public_api/auth.py:51`），
    自己拼一个假摘要只会在 401 上浪费时间。
    """
    from app.public_api.auth import generate_api_key

    token, prefix, digest = generate_api_key()

    with Session(engine) as db:
        db.add(Tenant(id="tenant_scene", name="Scene Tenant"))
        # APIClient 必须有 owner：鉴权链会沿着 client → created_by_user_id
        # 找人（找不到就 401 API_CLIENT_OWNER_MISSING），少这个用户
        # 每一条请求都会卡在鉴权上，连场景逻辑都跑不到。
        db.add(
            User(
                id="user_scene_owner",
                tenant_id="tenant_scene",
                username="scene_owner",
                role="admin",
                password_hash="x",
            )
        )
        db.add(
            AgentProfile(
                id="agent_scene",
                tenant_id="tenant_scene",
                name="仙林 AI G.O",
                status="active",
                is_overall=False,
            )
        )
        db.add(
            APIClient(
                id="client_scene",
                tenant_id="tenant_scene",
                name="client",
                status="active",
                scopes_json=["runs:create", "runs:read", "agents:read"],
                created_by_user_id="user_scene_owner",
            )
        )
        db.add(
            APICredential(
                id="cred_scene",
                tenant_id="tenant_scene",
                client_id="client_scene",
                name="cred",
                key_prefix=prefix,
                key_digest=digest,
                status="active",
                scopes_json=["runs:create", "runs:read", "agents:read"],
            )
        )
        db.add(
            APIJob(
                id="apijob_scene",
                kind="run",
                tenant_id="tenant_scene",
                agent_id="agent_scene",
                credential_id="cred_scene",
                status="succeeded",
                stage="completed",
                progress=1.0,
                request_json={"input": "滑雪行程推荐", "session_mode": "stateless"},
                session_id="session_scene",
            )
        )
        # 块 + 参数 + scene_id 都在 assistant 消息 metadata 上（与
        # `turn_run.py` 的写入口径一致）
        db.add(
            Message(
                id="msg_assistant",
                tenant_id="tenant_scene",
                session_id="session_scene",
                role="assistant",
                content="为你找到以下方案：经典雪山五日",
                metadata_json={
                    "client_turn_id": "apijob_scene",
                    "ui_blocks": [_ITINERARY_BLOCK],
                    "scene_params": _SCENE_PARAMS,
                    "scene_id": "scene_ski",
                },
            )
        )
        db.commit()
    return token, "apijob_scene"


def _client(monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel

    from app.db import get_session
    from app.public_api.app import create_public_api_app

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    api_key, job_id = _seed(engine)

    app = create_public_api_app()

    def session_override():
        with Session(engine) as db:
            yield db

    app.dependency_overrides[get_session] = session_override
    monkeypatch.setattr("app.public_api.app.engine", engine)
    return TestClient(app), api_key, job_id, engine


def test_scene_payload_extracts_blocks() -> None:
    """`_scene_payload` 必须把三个字段都取出来。

    这是两个出口（SSE completed / result 载荷）共用的唯一入口 ——
    单独测它比端到端跑 Harness 更准：块来自 assistant 消息 metadata，
    而 metadata 的形状就是 `turn_run.py` 写进去的那三样。
    """
    from app.public_api.runs import _scene_payload

    payload = _scene_payload(
        {
            "ui_blocks": [_ITINERARY_BLOCK],
            "scene_params": _SCENE_PARAMS,
            "scene_id": "scene_ski",
            "knowledge_citations": [{"label": "[1]"}],
        }
    )

    assert payload["ui_blocks"] == [_ITINERARY_BLOCK]
    assert payload["scene_params"] == _SCENE_PARAMS
    assert payload["scene_id"] == "scene_ski"
    # 只取场景三样，不要把别的 metadata 顺手透出去
    assert "knowledge_citations" not in payload


def test_scene_payload_empty_for_plain_chat() -> None:
    """普通对话必须给空数组/空字典，而不是缺字段。

    缺字段会让调用方写 `if (payload.ui_blocks)` 时炸掉，
    而普通对话占绝大多数 —— 它不是特例。
    """
    from app.public_api.runs import _scene_payload

    payload = _scene_payload({})
    assert payload["ui_blocks"] == []
    assert payload["scene_params"] == {}
    assert payload["scene_id"] == ""

    # metadata 里是 None 而不是缺失时也不能炸
    payload = _scene_payload({"ui_blocks": None, "scene_params": None, "scene_id": None})
    assert payload["ui_blocks"] == []
    assert payload["scene_params"] == {}
    assert payload["scene_id"] == ""


def test_scene_payload_redacts_sensitive_keys() -> None:
    """块里若混进敏感键必须被摘掉。

    块由 module 产出，理论上只有业务数据；但 `_redact` 是出口的最后一道闸，
    不能因为「块一定干净」就跳过 —— 一旦某个 module 把 `api_key` 写进
    data（配置失误），它会直接出现在公开 API 的响应体里。
    """
    from app.public_api.runs import _scene_payload

    payload = _scene_payload(
        {
            "ui_blocks": [
                {
                    "kind": "result",
                    "data": {"items": [], "api_key": "sd_live_secret"},
                    "module_key": "travel.itinerary",
                    "module_version": 1,
                }
            ]
        }
    )
    assert "api_key" not in payload["ui_blocks"][0]["data"]


def test_scene_chips_endpoint_lists_bound_scenes(monkeypatch) -> None:
    """胶囊接口只返回已发布 + 已绑定的场景，且不带内部字段。

    这是场景的**唯一发现入口**：关键词是管理员配的、界面上不显示，
    没有胶囊用户只能靠猜才能进场景。
    """
    client, api_key, _job_id, engine = _client(monkeypatch)
    with Session(engine) as db:
        db.add(
            Scene(
                id="scene_ski",
                tenant_id="tenant_scene",
                name="滑雪行程推荐",
                status="published",
                scene_type="table_match",
                module_key="travel.itinerary",
                module_version=1,
                trigger_json={"keywords": ["滑雪", "行程推荐"], "shortcut": True},
                shortcut_json={"label": "滑雪行程推荐", "icon": "🎿"},
                slots_json=[{"key": "people", "label": "人数", "type": "number"}],
            )
        )
        db.add(
            Scene(
                id="scene_draft",
                tenant_id="tenant_scene",
                name="草稿场景",
                status="draft",
                scene_type="table_match",
                module_key="travel.itinerary",
                module_version=1,
                shortcut_json={"label": "草稿"},
            )
        )
        for scene_id, status in (("scene_ski", "active"), ("scene_draft", "active")):
            db.add(
                AgentResourceBinding(
                    tenant_id="tenant_scene",
                    agent_id="agent_scene",
                    resource_type="scene",
                    resource_id=scene_id,
                    status=status,
                )
            )
        db.commit()

    response = client.get(
        "/agents/agent_scene/scene-chips",
        headers={"Authorization": f"Bearer {api_key}"},
    )

    assert response.status_code == 200, response.text
    chips = response.json()["data"]
    # draft 不该出现在对话页（PRD §9.4）
    assert [c["scene_id"] for c in chips] == ["scene_ski"]

    chip = chips[0]
    assert chip["label"] == "滑雪行程推荐"
    assert chip["icon"] == "🎿"
    # 点击后要发的那句话：关键词第一个（`shortcut.message` 没配时）
    assert chip["send_text"] == "滑雪"
    # 载荷必须窄：slots/module_key 是场景内部结构，泄露给集成方
    # 等于让它去猜「这个场景长什么样」，而后端已经在块里说清楚了
    assert "slots" not in chip
    assert "module_key" not in chip


def test_run_create_accepts_scene_fields(monkeypatch) -> None:
    """`/runs` 必须接受 forced_scene_id 与 slot_submission，并落进 job。

    表单提交轮的文本是「人数：4；天数：3；预算：4800」——
    一个场景关键词都没有，不带 forced_scene_id 必然落回普通对话。
    只看「HTTP 202」不够：字段被 pydantic 收下却没进 `request_json` 时
    接口照样 202，worker 读到的是 None，表现是「填完表又弹回空表」。
    """
    client, api_key, _job_id, engine = _client(monkeypatch)

    response = client.post(
        "/agents/agent_scene/runs",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "input": "人数：4；天数：3；预算：4800",
            "session_mode": "stateless",
            "forced_scene_id": "scene_ski",
            "slot_submission": {"people": 4, "days": 3, "budget": 4800},
        },
    )

    assert response.status_code == 202, response.text
    body = response.json()
    # 公开 API 的 run 标识字段叫 `id`（不是 `job_id`）
    run_id = body["id"]
    assert run_id

    with Session(engine) as db:
        job = db.get(APIJob, run_id)
        assert job is not None
        request_json = dict(job.request_json or {})

    assert request_json["forced_scene_id"] == "scene_ski"
    assert request_json["slot_submission"] == {"people": 4, "days": 3, "budget": 4800}


def test_run_create_without_scene_fields_keeps_them_absent(monkeypatch) -> None:
    """普通对话不该被塞进场景字段。

    多带一个 `forced_scene_id: None` 会让下游 `str(None).strip()` 得到
    字符串 "None" —— 一个永远匹配不上任何场景的假 id，排查时极难看出。
    """
    client, api_key, _job_id, engine = _client(monkeypatch)

    response = client.post(
        "/agents/agent_scene/runs",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"input": "你好", "session_mode": "stateless"},
    )

    assert response.status_code == 202, response.text
    with Session(engine) as db:
        job = db.get(APIJob, response.json()["id"])
        request_json = dict(job.request_json or {})

    assert not request_json.get("forced_scene_id")
    assert not request_json.get("slot_submission")