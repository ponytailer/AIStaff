"""图片转写：把截图读成文字，只做一次。

## 为什么需要

截图排障（「这是什么错，怎么解决」）的请求**必然**带附件，而
``_is_knowledge_workflow_frame`` 的条件里 ``has_attachments`` 是硬性 False
分支——这条请求因此进不了确定性工作流，只能进 Harness 决策循环。

进循环之后的问题在 ``step_loop.py``：``isolated_attachment_context`` 写在
``for iteration in ...`` 体内，**每一轮决策都会把原图重新发一遍**。图片走
``attachment.data_url`` 原样上行（上限 4MB，不压缩），配上 provider 默认开启
的思考模式，单轮实测 91–187s。一张截图 + 3 轮决策就是 5~9 分钟。

## 做法

进循环**之前**先花一次 vision 调用把图片读成结构化文本，之后所有决策轮、
所有工具调用、所有证据拼装都只看这段文本。视觉 token 只付一次。

## 为什么不在这里关思考

转写是「照着图念字」，本该关思考，但按操作名开覆盖需要改动
``OPERATION_THINKING_MODE``——那张表被知识库那条链路的实测结论绑着
（关思考 13× 收益，同时带着「不要全局关」的警告）。本模块用独立的 operation
名 + 一次性调用，收益主要来自「从 N 次变 1 次」，不叠加第二个变量，便于归因。

## 失败一律降级

任何异常、空结果、超时都返回 ``None``，调用方原样走今天的行为（每轮重发）。
这条路径绝不阻断主链路。
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from app.core.engine.attachments import ValidatedTaskImagePayload
from app.db.models import ModelConfig
from app.llm import LLMClient
from app.observability.spans import llm_operation

# 独立的 operation 名：出现在 trace 里能一眼看出「这轮是转写，不是决策」，
# 也让 token/耗时能和 harness.task_action 分开统计。
TRANSCRIBE_OPERATION = "harness.image_transcribe"

# 转写结果的字符上限。截图主要信息是报错原文 + 界面元素 + 数值，给足 4K 字符
# 已远超一张截图的文字量；再长说明模型在编故事，直接截断。
MAX_TRANSCRIPT_CHARS = 4_000

# 超时。转写本身是短输出任务，给它一个明确上限：网关挂死时快速失败降级，
# 而不是把整轮对话拖到模型级 600s。
TRANSCRIBE_TIMEOUT_SECONDS = 45.0

TRANSCRIBE_SYSTEM_PROMPT = """你是「看图取信息」的转写器。读用户上传的图片，输出它能确定的事实。

只输出下面五段，没有内容就写「无」。不要解释、不要建议、不要 markdown 标题：

1. 图中文字：按阅读顺序逐行抄录可见文字，保留报错的原始英文/代码/数字。长表格只抄表头与前若干行。
2. 界面状态：这是哪个界面的哪一部分、当前处于什么状态（报错弹窗/表单/列表/图表/终端）。
3. 错误与异常：报错原文、HTTP 状态码、异常名、堆栈关键行。逐字抄，不要改写。
4. 关键数据：数字、时间、ID、账号、版本号、金额等。
5. 不确定项：看不清或被遮挡的地方，明确写「看不清」，不要猜。

要求：看不清就说看不清。宁可少写，绝不编造图中没有的内容。"""


@dataclass(frozen=True)
class ImageTranscript:
    """一次转写的结果。``text`` 会拼进决策 payload 的文本部分。"""

    text: str
    image_count: int

    @property
    def usable(self) -> bool:
        return bool(self.text.strip())


def transcribe_images_once(
    image_payloads: list[ValidatedTaskImagePayload] | None,
    model_config: ModelConfig,
    *,
    user_message: str = "",
    deadline_monotonic: float | None = None,
    trace_sink: Any = None,
) -> ImageTranscript | None:
    """把本轮图片读成文字。返回 ``None`` 表示「没转成，按老路走」。

    只在「这一帧确实带图」时被调用；调用方负责把结果塞进 payload，并在成功时
    不再把原图交给决策轮。

    ``user_message`` 只用来给转写**聚焦**（「这个报错怎么解决」→ 重点抄报错），
    不参与任何判断。传空也照常工作。
    """

    images = [item for item in (image_payloads or []) if item.data_url]
    if not images:
        return None

    # 只取前若干张：一次贴 10 张截图的场景极少，而每张都是完整的视觉 token。
    # 超出的部分在文本里显式说明，避免模型以为「只有这一张」。
    selected = images[:MAX_IMAGES_PER_TRANSCRIBE]
    omitted = len(images) - len(selected)

    try:
        client = _bounded_client(model_config, deadline_monotonic)
        # 转写本身要几秒到十几秒，期间界面上没有任何变化。先发一条「开始读图」，
        # 让用户知道在等什么，而不是以为卡住了。
        _trace(
            trace_sink,
            "image_transcribe_started",
            {"image_count": len(selected)},
        )
        with llm_operation(
            TRANSCRIBE_OPERATION,
            image_count=len(selected),
            omitted_count=omitted,
        ):
            user_text = (
                "请按系统提示的五段结构转写这张图片。"
                if len(selected) == 1
                else f"请按系统提示的五段结构，分别转写这 {len(selected)} 张图片。"
            )
            focus = (user_message or "").strip()
            if focus:
                # 带上用户原问，让转写知道该重点抄什么。这里只影响「看哪里」，
                # 五段结构的硬要求不变，避免变成「按提问编答案」。
                user_text += (
                    f"\n\n用户随图提出的问题是：「{focus[:500]}」\n"
                    "请把与该问题相关的文字、报错、数值抄全，其余部分可略。"
                    "仍然只做转写，不要回答这个问题。"
                )
            text = client.generate_text(
                TRANSCRIBE_SYSTEM_PROMPT,
                {
                    "conversation_context": {
                        "messages": [
                            {
                                "role": "user",
                                "content": user_text,
                                "images": [
                                    {
                                        "type": "image_url",
                                        "image_url": {
                                            "url": item.data_url,
                                            "detail": "auto",
                                        },
                                    }
                                    for item in selected
                                ],
                            }
                        ]
                    }
                },
            )
    except Exception as exc:  # noqa: BLE001 - 转写失败绝不阻断主链路
        _trace(trace_sink, "image_transcribe_failed", {"error": type(exc).__name__})
        return None

    cleaned = _clean(text or "")
    if not cleaned:
        _trace(trace_sink, "image_transcribe_failed", {"error": "empty"})
        return None

    if omitted:
        cleaned = (
            f"{cleaned}\n\n（另有 {omitted} 张图片未转写，需要时请用户单独提供。）"
        )
    cleaned = cleaned[:MAX_TRANSCRIPT_CHARS]

    _trace(
        trace_sink,
        "image_transcribe_done",
        {"chars": len(cleaned), "images": len(selected)},
    )
    return ImageTranscript(text=cleaned, image_count=len(selected))


# 一次转写的图片数上限。
MAX_IMAGES_PER_TRANSCRIBE = 3


def _bounded_client(
    model_config: ModelConfig,
    deadline_monotonic: float | None,
) -> LLMClient:
    """给转写一个独立且更短的时间上限。

    复用 ``_deadline_llm_client`` 的思路，但这里不能 import step_loop（循环依赖），
    所以就地实现；同时用 ``TRANSCRIBE_TIMEOUT_SECONDS`` 兜一个比决策更紧的顶。
    """

    import time

    timeout_seconds = TRANSCRIBE_TIMEOUT_SECONDS
    if deadline_monotonic is not None:
        remaining = max(deadline_monotonic - time.monotonic(), 0.1)
        timeout_seconds = min(timeout_seconds, remaining)
    configured = getattr(model_config, "timeout_seconds", None)
    if configured:
        timeout_seconds = min(timeout_seconds, float(configured))

    try:
        if hasattr(model_config, "model_copy"):
            limited = model_config.model_copy(
                update={"timeout_seconds": timeout_seconds}
            )
        else:
            limited = replace(model_config, timeout_seconds=timeout_seconds)
    except Exception:  # noqa: BLE001 - 克隆失败就用原配置，仅失去超时收紧
        return LLMClient(model_config)
    return LLMClient(limited)


def _clean(text: str) -> str:
    """去掉模型偶尔套的外层代码块和多余空行。"""

    body = text.strip()
    if body.startswith("```"):
        lines = body.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        body = "\n".join(lines).strip()
    while "\n\n\n" in body:
        body = body.replace("\n\n\n", "\n\n")
    return body


def _trace(trace_sink: Any, event: str, payload: dict[str, Any]) -> None:
    if not callable(trace_sink):
        return
    try:
        trace_sink(event, payload)
    except Exception:  # noqa: BLE001, S110 - 观测失败绝不阻断主链路
        pass