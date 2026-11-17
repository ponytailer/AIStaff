"""助手答案尾部可直接点击的动作（目前只有「转人工」）。

为什么把判定放在后端、动作放答案 metadata：答案措辞是模型生成的，前端不该
对中文话术跑正则；后端在落库时判定一次（同一个 reply 只判定一次，答案改版
不会让前端行为漂移），前端只负责把结构化动作渲染成按钮。

判定只用于「答案里主动提出可以转人工」这一种情形（如知识不足时模型给的建议
路径）。真正转过去了（会话已进 handoff / 已有待回答单）不再给按钮，否则用户
点一下会重复建单。
"""

from __future__ import annotations

from typing import Any

#: 模型「愿意帮你转人工」的常见措辞。宁可少给按钮，也别把「已转接」「不提供
#: 人工服务」这类判断错——漏判只是用户继续手打，误判会让用户点了没反应。
_HANDOFF_OFFER_MARKERS = (
    "转接人工",
    "转人工",
    "人工同事",
    "人工客服",
    "人工坐席",
    "人工协助",
    "人工跟进",
)

#: 明确否定的措辞：出现就不给按钮（「无需转人工」「不用转人工」）。
_HANDOFF_DECLINE_MARKERS = (
    "无需转",
    "不用转",
    "不需要转",
    "无法转",
    "不能转",
)

#: 动作负载：type 给前端分派行为，text 是点击后要发的内容（走正常发消息链路，
#: 与用户手打「转人工」完全同一条路，转人工判定/建单逻辑不用复制一份）。
HANDOFF_ACTION: dict[str, str] = {
    "type": "handoff",
    "label": "转人工",
    "text": "转人工",
}


def offers_human_handoff(reply: str) -> bool:
    """答案是否主动提出可以转人工。"""

    text = str(reply or "")
    if not text.strip():
        return False
    if any(marker in text for marker in _HANDOFF_DECLINE_MARKERS):
        return False
    return any(marker in text for marker in _HANDOFF_OFFER_MARKERS)


def suggested_actions(reply: str, *, handoff_pending: bool) -> list[dict[str, Any]]:
    """答案落库时要带上的可点动作。"""

    if handoff_pending or not offers_human_handoff(reply):
        return []
    return [dict(HANDOFF_ACTION)]
