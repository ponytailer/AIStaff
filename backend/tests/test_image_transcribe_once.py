"""图片只读一次：截图进循环前转写成文本。

背景（现场）：截图排障类请求必然带附件，而 ``_is_knowledge_workflow_frame``
里 ``has_attachments`` 是硬性 False 分支，于是这类请求只能进 Harness 决策循环；
循环体内每轮都会重建 ``isolated_attachment_context``，**原图每轮重发一遍**
（data_url 原样上行，上限 4MB 不压缩）+ provider 默认开思考，单轮实测 91-187s。
一张截图走 3 轮就是 5~9 分钟，而用户真正要的只是「图里写了什么」。

这组用例锁住三件事：
1. 转写成功 → 决策 payload 里**一次**图片都不再出现，后续轮只有文本；
2. 转写失败 → 完整回退到「每轮带图」，宁可慢也不能让模型看不见图；
3. 没有图片 → 完全不触发转写，不产生额外 LLM 调用。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

from app.core.engine import image_transcribe as image_transcribe_module
from app.core.engine import step_loop as step_loop_module
from app.core.engine.attachments import ValidatedTaskImagePayload
from app.core.engine.image_transcribe import ImageTranscript
from app.core.engine.step_loop import HarnessTaskAgent
from app.core.base.request_compiler import TaskRequirement
from app.db.models import ModelConfig


def _patch_clients(monkeypatch, client_cls):
    """两个模块各自 import 了 LLMClient，必须同时替换。

    ``image_transcribe`` 做转写，``step_loop`` 做决策；只 patch 一个会让另一条
    路径偷偷打到真网关。
    """

    monkeypatch.setattr(image_transcribe_module, "LLMClient", client_cls)
    monkeypatch.setattr(step_loop_module, "LLMClient", client_cls)


def _all_transcribe_calls(client_cls):
    return [call for item in client_cls.instances for call in item.transcribe_calls]


def _all_decision_payloads(client_cls):
    return [payload for item in client_cls.instances for payload in item.decision_payloads]

DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def _model_config() -> ModelConfig:
    return ModelConfig(
        id="model-test",
        tenant_id="tenant-demo",
        name="测试模型",
        api_key_encrypted="test",
        model="test-model",
    )


def _requirement(with_attachment: bool = True) -> TaskRequirement:
    attachments: list[dict[str, Any]] = (
        [
            {
                "attachment_id": "image-1",
                "filename": "error.png",
                "content_type": "image/png",
                "size": 70,
                "kind": "image",
                "vision_available": True,
            }
        ]
        if with_attachment
        else []
    )
    return TaskRequirement(
        task_frame_id="task-image",
        kind="conversation",
        goal="这个报错怎么解决",
        requirements=["给出解决方案"],
        source_user_message="这个报错怎么解决",
        attachments=attachments,
    )


def _payloads() -> list[ValidatedTaskImagePayload]:
    return [
        ValidatedTaskImagePayload(
            attachment_id="image-1",
            filename="error.png",
            content_type="image/png",
            size=70,
            data_url=DATA_URL,
        )
    ]


def _has_image_part(payload: dict[str, Any]) -> bool:
    """payload 里是否真的带了 image_url part。"""

    def walk(value: Any) -> bool:
        if isinstance(value, dict):
            if value.get("type") in {"image", "image_url", "input_image"}:
                return True
            return any(walk(item) for item in value.values())
        if isinstance(value, list):
            return any(walk(item) for item in value)
        return False

    return walk(payload.get("conversation_context"))


class _RecordingClient:
    """记录每次调用；``generate_text`` 用于转写，``generate_json`` 用于决策。"""

    instances: list["_RecordingClient"] = []

    def __init__(self, _model_config: ModelConfig) -> None:
        self.decision_payloads: list[dict[str, Any]] = []
        self.transcribe_calls: list[dict[str, Any]] = []
        # 用 type(self) 而不是类名：子类复用时实例要落到子类自己的列表里，
        # 否则 _all_* 辅助函数会因为看的是父类列表而漏掉这些调用。
        type(self).instances.append(self)

    def generate_text(self, system_prompt: str, user_payload: Any, **_kwargs: Any) -> str:
        self.transcribe_calls.append(
            {"system_prompt": system_prompt, "user_payload": user_payload}
        )
        return "1. 图中文字：ERROR 502 Bad Gateway\n3. 错误与异常：upstream connect error"

    def generate_json(self, _system_prompt: str, payload: dict[str, Any], **_kwargs: Any):
        self.decision_payloads.append(deepcopy(payload))
        return {
            "action": "finish",
            "status": "completed",
            "reply_fragment": "已根据截图给出排查步骤。",
            "task_summary": "截图排障。",
        }


class _FailingTranscribeClient:
    """转写直接抛异常，模拟网关不支持视觉或超时。"""

    instances: list["_FailingTranscribeClient"] = []

    def __init__(self, _model_config: ModelConfig) -> None:
        self.decision_payloads: list[dict[str, Any]] = []
        self.transcribe_calls: list[dict[str, Any]] = []
        type(self).instances.append(self)

    def generate_text(self, *_args: Any, **_kwargs: Any) -> str:
        raise RuntimeError("vision unsupported")

    def generate_json(self, _system_prompt: str, payload: dict[str, Any], **_kwargs: Any):
        self.decision_payloads.append(deepcopy(payload))
        return {
            "action": "finish",
            "status": "completed",
            "reply_fragment": "ok",
            "task_summary": "ok",
        }


def test_transcribe_happens_once_and_stops_resending_image(monkeypatch) -> None:
    """转写成功：图片只出现一次（转写那次），决策轮全部是文本。"""

    _RecordingClient.instances.clear()
    _patch_clients(monkeypatch, _RecordingClient)

    result = HarnessTaskAgent().run(
        _requirement(),
        _model_config(),
        lambda _name, _arguments: {"success": True},
        image_payloads=_payloads(),
    )

    assert result.status == "completed"
    transcribe_calls = _all_transcribe_calls(_RecordingClient)
    decision_payloads = _all_decision_payloads(_RecordingClient)

    # 恰好一次转写调用，且那次调用**确实带了图**。
    assert len(transcribe_calls) == 1
    transcribe_payload = transcribe_calls[0]["user_payload"]
    assert DATA_URL in str(transcribe_payload)

    # 决策轮一次图都没带。
    assert decision_payloads, "决策轮应当被调用"
    for payload in decision_payloads:
        assert not _has_image_part(payload), "转写成功后决策轮不应再出现图片"

    # 但截图内容以文本形式到了模型面前。
    first_context = decision_payloads[0].get("conversation_context")
    assert first_context is not None
    assert "ERROR 502 Bad Gateway" in str(first_context)


def test_transcribe_failure_falls_back_to_resending_image(monkeypatch) -> None:
    """转写失败：回退老路，决策轮照旧带图 —— 宁可慢也不能让模型看不见图。"""

    _FailingTranscribeClient.instances.clear()
    _patch_clients(monkeypatch, _FailingTranscribeClient)

    result = HarnessTaskAgent().run(
        _requirement(),
        _model_config(),
        lambda _name, _arguments: {"success": True},
        image_payloads=_payloads(),
    )

    assert result.status == "completed"
    decision_payloads = _all_decision_payloads(_FailingTranscribeClient)
    assert decision_payloads
    assert _has_image_part(decision_payloads[0]), (
        "转写失败时必须保持每轮带图，否则模型完全看不到截图"
    )


def test_no_image_skips_transcribe_entirely(monkeypatch) -> None:
    """没有图片：一次转写调用都不该发生。"""

    _RecordingClient.instances.clear()
    _patch_clients(monkeypatch, _RecordingClient)

    result = HarnessTaskAgent().run(
        _requirement(with_attachment=False),
        _model_config(),
        lambda _name, _arguments: {"success": True},
        image_payloads=None,
    )

    assert result.status == "completed"
    assert _all_transcribe_calls(_RecordingClient) == []
    decision_payloads = _all_decision_payloads(_RecordingClient)
    assert decision_payloads
    assert not _has_image_part(decision_payloads[0])


def test_transcribe_empty_output_is_treated_as_failure(monkeypatch) -> None:
    """转写返回空白：按失败处理，不要用一段空文本替代图片。"""

    class _BlankClient(_RecordingClient):
        instances: list["_BlankClient"] = []

        def generate_text(self, *_args: Any, **_kwargs: Any) -> str:
            return "   \n\n  "

    _BlankClient.instances.clear()
    _patch_clients(monkeypatch, _BlankClient)

    result = HarnessTaskAgent().run(
        _requirement(),
        _model_config(),
        lambda _name, _arguments: {"success": True},
        image_payloads=_payloads(),
    )

    assert result.status == "completed"
    decision_payloads = _all_decision_payloads(_BlankClient)
    assert _has_image_part(decision_payloads[0])


def test_multiple_images_share_one_transcribe_call(monkeypatch) -> None:
    """多张图合并成一次转写，而不是每张一轮。"""

    payloads = [
        ValidatedTaskImagePayload(
            attachment_id=f"image-{index}",
            filename=f"shot-{index}.png",
            content_type="image/png",
            size=70,
            data_url=DATA_URL,
        )
        for index in range(1, 3)
    ]

    _RecordingClient.instances.clear()
    _patch_clients(monkeypatch, _RecordingClient)

    HarnessTaskAgent().run(
        _requirement(),
        _model_config(),
        lambda _name, _arguments: {"success": True},
        image_payloads=payloads,
    )

    transcribe_calls = _all_transcribe_calls(_RecordingClient)
    assert len(transcribe_calls) == 1, "两张图必须合并成一次转写"
    assert str(transcribe_calls[0]["user_payload"]).count(DATA_URL) == 2
    for payload in _all_decision_payloads(_RecordingClient):
        assert not _has_image_part(payload)


def test_multi_turn_loop_never_resends_image(monkeypatch) -> None:
    """真正的收益点：多轮决策里，每一轮都不再带图。

    这是被优化掉的成本 —— 此前每轮都会重建 attachment context 并重发原始
    data_url，一张 Retina 截图 2-4MB，走 3 轮就是同一张图被理解 3 次。
    """

    class _MultiTurnClient(_RecordingClient):
        instances: list["_MultiTurnClient"] = []

        def generate_json(self, _system_prompt: str, payload: dict[str, Any], **_kwargs: Any):
            self.decision_payloads.append(deepcopy(payload))
            # 第 1 轮先查一次知识库，第 2 轮收尾 → 必须真的走两轮。
            if payload.get("iteration") == 1:
                return {
                    "action": "tool",
                    "tool_name": "knowledge_search",
                    "arguments": {"query": "502 报错排查"},
                    "task_summary": "查排查手册",
                }
            return {
                "action": "finish",
                "status": "completed",
                "reply_fragment": "按手册第 3 节处理。",
                "task_summary": "已给方案。",
            }

    _MultiTurnClient.instances.clear()
    _patch_clients(monkeypatch, _MultiTurnClient)

    result = HarnessTaskAgent().run(
        _requirement(),
        _model_config(),
        lambda _name, _arguments: {"success": True, "chunks": []},
        image_payloads=_payloads(),
        max_actions=3,
    )

    assert result.status == "completed"
    decision_payloads = _all_decision_payloads(_MultiTurnClient)
    assert len(decision_payloads) >= 2, "这个用例要求真的走多轮，否则测不到重点"
    for index, payload in enumerate(decision_payloads, start=1):
        assert not _has_image_part(payload), f"第 {index} 轮不应再带图"
    # 转写只做了一次，而不是每轮一次。
    assert len(_all_transcribe_calls(_MultiTurnClient)) == 1


def test_user_message_focuses_transcription(monkeypatch) -> None:
    """用户原问会带给转写，用来聚焦「该重点抄什么」。

    截图信息量大而杂，不告诉转写器「用户在问什么」时，它容易把整屏抄一遍，
    既长又抓不住重点。
    """

    _RecordingClient.instances.clear()
    _patch_clients(monkeypatch, _RecordingClient)

    HarnessTaskAgent().run(
        _requirement(),
        _model_config(),
        lambda _name, _arguments: {"success": True},
        image_payloads=_payloads(),
    )

    calls = _all_transcribe_calls(_RecordingClient)
    assert len(calls) == 1
    text = str(calls[0]["user_payload"])
    assert "这个报错怎么解决" in text, "用户原问应当出现在转写请求里"
    # 同时必须保留「只转写不回答」的约束。
    assert "不要回答" in calls[0]["system_prompt"] or "不要回答" in text


def test_transcript_context_shape_is_model_visible_text() -> None:
    """转写结果包成 conversation_context，且是「用户提供的事实」口吻。"""

    context = step_loop_module._image_transcript_context(
        ImageTranscript(text="图中文字：404", image_count=1)
    )
    assert context is not None
    messages = context["messages"]
    assert messages[0]["role"] == "user"
    assert "404" in messages[0]["content"]
    assert "截图" in messages[0]["content"]
    # 关键：不能带 images 键，否则又变回发图。
    assert "images" not in messages[0]
    assert step_loop_module._image_transcript_context(None) is None