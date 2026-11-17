"""Planner 快速路径与追问短路（零 LLM 合成 answer_only 计划）。

自 planner.py 拆出（行数控制）；planner.py 保持 re-export。判定原则与
守卫说明见各函数 docstring。
"""

from __future__ import annotations

import re
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


def is_handoff_intent(message: str) -> bool:
    """消息是否就是在要求转人工（而不是顺带提到人工）。

    「转人工」按钮发的就是字面量，用户手打的也多是「转人工」「我要人工客服」
    这类短句。判定只看关键词命中，与 planner 快速路径守卫同源——宁可多走
    一次 LLM，也不把「报销怎么弄，不然我转人工吧」这种混合诉求直接建单。
    """

    text = " ".join(str(message or "").split()).strip().lower()
    if not text:
        return False
    return any(keyword in text for keyword in FAST_PATH_HANDOFF_KEYWORDS)


#: 转人工直通（execution_mode=handoff_intent）的固定答复。
#: 只陈述事实：已建单 + 坐席会接手。不再让模型自由发挥，也就不会出现
#: 「当前会话中暂无可自动创建的工单或在线客服接口…」这种把内部实现细节
#: 抖给用户的段落。
HANDOFF_INTENT_REPLY = "已为你转接人工同事，稍后会有同事在这里回复你。"


#: bot 自己生成的转接话术开头。历史数据里 `pending_question` 被写成了这些
#: 长文本（旧 bug），它既不是用户问法也不是 SOP 待确认事项，不能当问法用。
_BOT_HANDOFF_SCRIPT_PREFIXES = (
    "已为您转接",
    "正在为您转接",
    "已收到您的转人工请求",
    "已为您发起人工客服转接",
    "好的，已为您转接",
    "已转接人工",
    "已为您转接人工",
)


def is_bot_handoff_script(text: str) -> bool:
    """文本是否是 bot 自己生成的转接话术（而不是用户提问）。

    历史数据排查用：旧版 `HumanHandoffService.pending_question` 会落 bot 的
    转接话术，这些记录在「待沉淀」里显示成一大段「已为您转接人工同事跟进。
    - 转接事项：…」，采成 FAQ 问法后关键词变成「已为 / 为您 / 您转 / 转接」
    这类纯噪声。

    判定故意收紧到「开头标记 + 足够长」：真实用户的「帮我转人工」不会被误判，
    而 bot 话术都是几十上百字、且必然以这些短语起头。
    """

    body = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(body) < 40:
        return False
    return body.startswith(_BOT_HANDOFF_SCRIPT_PREFIXES)


def is_handoff_trigger_only(message: str) -> bool:
    """消息是否**只是**在点「转人工」（不含任何真实问题）。

    与 :func:`is_handoff_intent` 的区别：后者判「想去人工」，前者判「除了
    想去人工什么都没说」。这个区别决定了它能不能被当成用户问法——

    线上踩坑：答案尾部「转人工」按钮发出的就是一条内容为「转人工」的 user
    消息。FAQ 采纳侧取「会话最后一条用户消息」当用户问法、再拿它提关键词，
    结果问法变成「转人工」、关键词变成「转人 / 人工」，采出来的 FAQ 以后
    凡带「人工」二字的提问都会误命中。

    判定：去标点后精确等于某个关键词，或（长度 ≤ 10 且含关键词）——
    「我要人工客服」「转人工！」算，而「报销怎么弄，不然我转人工吧」不算。
    """

    text = re.sub(r"[\s\W_]+", "", str(message or "").lower())
    if not text:
        return False
    for keyword in FAST_PATH_HANDOFF_KEYWORDS:
        needle = re.sub(r"[\s\W_]+", "", keyword.lower())
        if not needle:
            continue
        if text == needle:
            return True
        if len(text) <= 10 and needle in text:
            return True
    return False


def _handoff_shortcircuit_plan(
    session: ChatSession,
    message: str,
    available_skills: list[Skill],
    task_frame_state: list[dict[str, Any]] | None,
    interaction_mode: str,
) -> TurnPlan | None:
    """「转人工」直通：零 LLM 直接建单，不再查知识库/能力。

    症状：点答案尾部的「转人工」按钮后，员工先去检索知识库（trace 里
    ``knowledge_prefetch_conversation`` 的 query 就是「转人工」），再走 3 轮
    Harness 决策（含 ``capability_search`` 找工单接口），最后吐一段「当前会话
    中暂无可自动创建的工单或在线客服接口…请注意留意会话」的啰嗦话术，十几秒
    才把单建好。用户点的是动作按钮，语义是明确的，没有任何需要规划的歧义。

    守卫（与 planner 快速路径同源，逐条都不能少）：
    - 只在 interaction_mode=normal 时介入；
    - 会话没有活跃 SOP / 待处理任务 / 待补槽 / 进行中帧——那些场景下「转人工」
      可能是 SOP 节点内的转交，得让流程自己决定；
    - 消息必须命中转人工关键词（复用 is_handoff_intent）。

    命中即返回 handoff_human 计划；下游 turn_frames 的 conversation handoff
    分支负责真正建单，话术由 handoff_reply_text 统一给（不再让模型自由发挥）。
    """

    if interaction_mode != "normal":
        return None
    if (
        str(session.active_skill_id or "").strip()
        or str(session.active_step_id or "").strip()
        or session.pending_tasks_json
        or session.awaiting_input_json
    ):
        return None
    blocking_frames = [
        frame
        for frame in (task_frame_state or [])
        if not (
            str(frame.get("kind") or "") == "conversation"
            and str(frame.get("status") or "") == "handoff"
        )
    ]
    if blocking_frames:
        return None
    if available_skills:
        # 有 SOP 可选时让 LLM 判断：这条消息可能是在触发某个流程而不是要人。
        return None
    text = " ".join(str(message or "").split()).strip()
    if not text or not is_handoff_intent(text):
        return None
    return TurnPlan(
        decision="handoff_human",
        confidence=1.0,
        user_intent=text,
        reason="handoff shortcircuit: explicit human handoff request",
        task_frames=[
            PlannedTaskFrame(
                kind="conversation",
                decision="handoff_human",
                execution_mode="handoff_intent",
                user_intent=text,
                source_message=message,
            )
        ],
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

    # 等待人工回复的 conversation 帧不挡 FAQ 短路：转人工挂起期间用户继续
    # 提问，正是最该用标准答案回答的场景。线上踩坑：handoff 帧是非终态
    # （终态只有 completed/cancelled/failed），用户转人工后再问一遍
    # 「怎么报销」，守卫把短路静默拦下（连未命中 trace 都不发），回复
    # 退化成 LLM 泛答且没有任何执行记录。其余非终态帧（in_progress 的
    # conversation、任何 SOP 帧）仍照常拦截。
    blocking_frames = [
        frame
        for frame in (task_frame_state or [])
        if not (
            str(frame.get("kind") or "") == "conversation"
            and str(frame.get("status") or "") == "handoff"
        )
    ]
    if (
        interaction_mode != "normal"
        or str(session.active_skill_id or "").strip()
        or str(session.active_step_id or "").strip()
        or session.pending_tasks_json
        or blocking_frames
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
