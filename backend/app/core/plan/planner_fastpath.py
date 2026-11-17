"""Planner 快速路径与追问短路（零 LLM 合成 answer_only 计划）。

自 planner.py 拆出（行数控制）；planner.py 保持 re-export。判定原则与
守卫说明见各函数 docstring。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.config import get_settings
from app.db.models import ChatSession, Skill
from app.faq.service import (
    FAQ_ANSWER_SLOT,
    FAQ_ITEM_ID_SLOT,
    FAQ_QUESTION_SLOT,
    match_faq_with_stats,
)
from app.session.session_schema import (
    PlannedTaskFrame,
    TurnPlan,
)


# Planner 快速路径的转人工类关键词：命中即回落 LLM 规划器。
# 宁可慢一轮 LLM，也不把「转人工」误按成知识问答——漏判只损失 12s，
# 错判是真实事故。英文小写匹配。
FAST_PATH_HANDOFF_KEYWORDS = (
    "转人工",
    "人工客服",
    "人工服务",
    "真人客服",
    "转接人工",
    "human agent",
    "human support",
    "real person",
)


def _faq_shortcircuit_plan(
    db: Any,
    session: ChatSession,
    message: str,
    available_skills: list[Skill],
    task_frame_state: list[dict[str, Any]] | None,
    interaction_mode: str,
    *,
    on_trace: Callable[[str, dict[str, Any]], None] | None = None,
) -> TurnPlan | None:
    """FAQ 词法命中短路（反馈自进化）：零 LLM 直接返回标准答案。

    检索顺序：**先 FAQ，未命中再走知识库/完整规划**——FAQ 是 owner 确认过的
    标准答案，它比知识库检索更权威也更便宜。

    守卫与 fast path 同源：结构性上下文必须排除路由决策空间（无活跃 SOP /
    待处理任务 / 待补槽），消息不命中转人工关键词——用户要人时不能拿 FAQ
    挡。命中判定见 app.faq.service.match_faq（任意 1 个关键词命中即可）。
    任何守卫不满足即返回 None，回落完整规划。

    on_trace：命中/未命中都要能在「本轮执行」里看见，否则用户无法判断到底
    有没有查 FAQ（线上「我加了 FAQ 但没命中」的排查成本全靠这一行）。
    """

    if (
        interaction_mode != "normal"
        or str(session.active_skill_id or "").strip()
        or str(session.active_step_id or "").strip()
        or session.pending_tasks_json
        or task_frame_state
        or session.awaiting_input_json
    ):
        return
    text = " ".join(str(message or "").split()).strip()
    if not text or text.startswith("/"):
        return
    lowered = text.lower()
    if any(keyword in lowered for keyword in FAST_PATH_HANDOFF_KEYWORDS):
        return
    item, candidates, hits = match_faq_with_stats(
        db, session.tenant_id, session.agent_id or "", text
    )
    if item is None or not str(item.answer_markdown or "").strip():
        # 一条 FAQ 都没有的 agent 不刷这条线（否则每轮都挂一行无信息量的「未命中」）。
        if on_trace is not None and candidates:
            on_trace(
                f"检索 FAQ：未命中（候选 {candidates} 条）",
                {"query": text, "faq_candidates": candidates, "faq_hit": False},
            )
        return
    if on_trace is not None:
        on_trace(
            f"命中 FAQ：{item.question}",
            {
                "query": text,
                "faq_candidates": candidates,
                "faq_hit": True,
                "faq_keywords": hits,
                "faq_item_id": item.id,
            },
        )
    return TurnPlan(
        decision="answer_only",
        confidence=0.9,
        user_intent=text,
        reason="faq shortcircuit: keyword match on adopted FAQ",
        task_frames=[
            PlannedTaskFrame(
                kind="conversation",
                decision="answer_only",
                execution_mode="faq_hit",
                user_intent=text,
                source_message=message,
                slot_hints={
                    FAQ_ANSWER_SLOT: str(item.answer_markdown),
                    FAQ_QUESTION_SLOT: str(item.question),
                    FAQ_ITEM_ID_SLOT: str(item.id),
                },
            )
        ],
    )


def _fast_path_plan(
    session: ChatSession,
    message: str,
    available_skills: list[Skill],
    task_frame_state: list[dict[str, Any]] | None,
    interaction_mode: str,
) -> TurnPlan | None:
    """结构性守卫全部命中时，跳过 planner LLM 直接合成 answer_only 计划。

    守卫的设计原则：只在「LLM 没有任何路由决策空间」时直通——当前 agent
    没有配置任何 SOP、也没有任何进行中/待处理的任务语义。此时 LLM 的理性
    输出几乎必然是 answer_only + conversation 帧，12-15s 的规划调用是纯
    固定开销。任何守卫不满足即返回 None，回落完整 LLM 规划（不猜语义）。

    2026-10-26 起不再有 `PLANNER_FAST_PATH_ENABLED` 开关：模式长期稳定，
    判定本身就是唯一路径（要回滚只能改代码，属于有意的取舍）。
    """
    if (
        interaction_mode != "normal" \
        # 有 SOP 可选时必须走 LLM：消息可能想触发某个 SOP 的 trigger_intents。
        or available_skills \
        # 有活跃 SOP / 待处理任务 / 待补槽 / 恢复中的帧时，决策空间非空，走 LLM。
        or str(session.active_skill_id or "").strip() \
        or str(session.active_step_id or "").strip() \
        or session.pending_tasks_json \
        or task_frame_state or session.awaiting_input_json
    ):
        return
    text = " ".join(str(message or "").split()).strip()
    if not text or text.startswith("/"):
        return
    lowered = text.lower()
    if any(keyword in lowered for keyword in FAST_PATH_HANDOFF_KEYWORDS):
        return
    return TurnPlan(
        decision="answer_only",
        confidence=1.0,
        user_intent=text,
        reason="planner fast path: no SOP context, direct conversation",
        task_frames=[
            PlannedTaskFrame(
                kind="conversation",
                decision="answer_only",
                user_intent=text,
                source_message=message,
            )
        ],
    )


def _followup_shortcircuit_plan(
    session: ChatSession,
    message: str,
    available_skills: list[Skill],
    conversation_context: dict[str, object] | None,
    task_frame_state: list[dict[str, Any]] | None,
    interaction_mode: str,
) -> TurnPlan | None:
    """会话续跑短路（qa-optimization I6 增量）。

    fast path 只覆盖「没有任何 SOP」的员工；有 SOP 时短追问（S5：上一轮知识
    问答完成后「那住客呢」）仍会白走一次 planner LLM（实测 ~5s）。当结构性
    上下文同样排除路由空间、有对话历史（非首条消息）、消息很短、且不命中任何
    SOP 的 trigger_intents 关键词时，合成 answer_only 计划直接续跑会话帧。
    任何守卫不满足即返回 None，回落完整 LLM 规划（不猜语义）。
    """

    settings = get_settings()
    if not settings.planner_followup_shortcircuit_enabled:
        return
    if (
        interaction_mode != "normal"
        or str(session.active_skill_id or "").strip()
        or str(session.active_step_id or "").strip()
        or session.pending_tasks_json
        or task_frame_state
        or session.awaiting_input_json
    ):
        return
    if not conversation_context:
        # 首条消息没有对话历史，语义判断交给完整 planner。
        return
    text = " ".join(str(message or "").split()).strip()
    if not text or text.startswith("/") or len(text) > 20:
        return
    lowered = text.lower()
    if any(keyword in lowered for keyword in FAST_PATH_HANDOFF_KEYWORDS):
        return
    for skill in available_skills:
        content = skill.content_json if isinstance(skill.content_json, dict) else {}
        for trigger in content.get("trigger_intents") or []:
            trigger_text = str(trigger or "").strip().lower()
            if trigger_text and trigger_text in lowered:
                # 消息可能想触发某个 SOP，路由决策空间非空，走 LLM。
                return
    return TurnPlan(
        decision="answer_only",
        confidence=0.0,
        user_intent=text,
        reason="planner followup short-circuit: short follow-up, no SOP trigger",
        task_frames=[
            PlannedTaskFrame(
                kind="conversation",
                decision="answer_only",
                user_intent=text,
                source_message=message,
            )
        ],
    )
