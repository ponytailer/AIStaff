"""端到端锁住「planner 不再重发历史图片」这条契约。

为什么不能只测 `strip_context_images` 纯函数：那个函数测起来很绿，但把
`planner.plan()` 里的调用点摘掉后依然全绿——那就成了假验证（本案教训：此前
思考模式的 7 个纯函数用例在摘掉调用点后照样通过）。

这里直接驱动真实的 `TurnPlanner.plan()`，在**模型被调用的那一刻**截获它真正
收到的 payload，再从里面数 image_url。只有这样才能证明调用点接对了。
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.core.plan import planner as planner_module
from app.db.models import ChatSession, ModelConfig, Skill


def _model_config() -> ModelConfig:
    return ModelConfig(
        tenant_id="t",
        name="test",
        api_key_encrypted="k",
        model="m",
    )


def _session() -> ChatSession:
    return ChatSession(
        tenant_id="t",
        user_id="u",
        agent_id="agent_1",
        title="t",
    )


def _context_with_history_image() -> dict[str, Any]:
    """模拟「上一轮贴过截图」的上下文：content 带附件描述 + images 带 data_url。"""

    return {
        "messages": [
            {
                "id": "msg_1",
                "role": "user",
                "content": (
                    "怎么解决\n\n上传附件上下文：\n"
                    "1. 文件名：pasted-image-1234-1.png；类型：image/png；"
                    "大小：102552 bytes"
                ),
                "images": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/png;base64," + "A" * 5_000,
                        },
                    }
                ],
            },
            {"id": "msg_2", "role": "assistant", "content": "我看看"},
        ],
        "metadata": {"estimated_tokens": 2_000, "token_budget": 32_000},
    }


def _plan_reply() -> dict[str, Any]:
    return {
        "decision": "answer_only",
        "reason": "普通咨询",
        "user_intent": "咨询问题",
        "task_frames": [
            {
                "kind": "conversation",
                "execution_mode": "standard",
                "requirements": ["回答问题"],
            }
        ],
        "task_updates": [],
        "slot_hints": {},
        "clarify": None,
    }


def _capture_outbound_payload(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """让 planner 跑完整流程，截获它真正交给模型的那份 payload。"""

    captured: dict[str, Any] = {}

    class _Client:
        def __init__(self, _model_config: Any) -> None:
            del _model_config

        def generate_json(self, _system_prompt: str, user_payload: dict, **_kwargs):
            # 观察点在「模型收到什么」，不是事后推测
            captured["payload"] = json.loads(
                json.dumps(user_payload, ensure_ascii=False, default=str)
            )
            return _plan_reply()

    monkeypatch.setattr(planner_module, "LLMClient", _Client)
    # 关闭所有短路：要让 plan() 真的走到 LLM 那一步
    monkeypatch.setattr(planner_module, "_fast_path_plan", lambda *a, **k: None)
    monkeypatch.setattr(planner_module, "_followup_shortcircuit_plan", lambda *a, **k: None)

    planner_module.TurnPlanner().plan(
        "这个报错怎么解决",
        _session(),
        [Skill(tenant_id="t", skill_id="s1", name="S1", version=1)],
        _model_config(),
        _context_with_history_image(),
        None,
        [],
    )
    return captured


def _image_parts(payload: dict[str, Any]) -> int:
    """数 payload 里真正的 image_url part（不是字符串里出现 'image' 的次数）。"""

    total = 0
    messages = (payload.get("conversation_context") or {}).get("messages") or []
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):
            total += sum(
                1
                for part in content
                if isinstance(part, dict) and part.get("type") == "image_url"
            )
        # images 若被原样留在上下文里，出站时会被 client 转成 image_url part
        images = message.get("images") if isinstance(message, dict) else None
        if isinstance(images, list):
            total += sum(
                1
                for part in images
                if isinstance(part, dict) and part.get("type") == "image_url"
            )
    return total


def test_planner_does_not_send_history_images(monkeypatch: pytest.MonkeyPatch) -> None:
    """核心契约：历史图片不得进入 planner 出站请求。"""

    captured = _capture_outbound_payload(monkeypatch)
    payload = captured["payload"]

    assert _image_parts(payload) == 0, (
        "planner 不该重发历史图片；意图识别只看文本与附件描述即可"
    )


def test_planner_still_sees_attachment_description(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """剥图不能连带删掉附件描述——那是意图识别的判断依据。"""

    captured = _capture_outbound_payload(monkeypatch)
    blob = json.dumps(captured["payload"], ensure_ascii=False)

    assert "pasted-image-1234-1.png" in blob, (
        "剥掉像素后，模型仍需知道用户这轮贴了图"
    )


def test_planner_payload_is_dramatically_smaller_without_images(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """体量对照：证明省掉的是图片字节，不是别的。"""

    captured = _capture_outbound_payload(monkeypatch)
    size = len(json.dumps(captured["payload"], ensure_ascii=False))

    assert size < 20_000, (
        f"剥图后 payload 应远小于含图的 5,000 字符 base64 量级，实际 {size}"
    )
