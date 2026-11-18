"""数字员工的「开场白」。

配置在 `agent_profiles.metadata_json["greeting_message"]`：员工档案里的一个
普通文本框。没配就什么都不做 —— 这条链路必须对存量员工零影响。

**为什么是落一条真实 assistant 消息，而不是前端假气泡**：
「主动发送开场白」的语义是它属于这段对话本身。只在前端画一个气泡，刷新就
消失、换端就看不到、导出记录里也没有；落库后历史回放、渠道同步、LLM 上下文
全都自然成立（模型也知道自己已经打过招呼，不会重复寒暄）。
"""

from __future__ import annotations

from datetime import timedelta

from sqlmodel import Session, select

from app.db.models import AgentProfile, ChatSession, Message, User, utc_now

# 开场白不进这些渠道：技能调试会话是用来观察 harness 原始行为的，
# 多一条寒暄会污染调试视图。
_GREETING_SKIPPED_CHANNELS = frozenset({"skill_test"})

GREETING_METADATA_KEY = "greeting_message"
# 单条开场白的长度上限。配置端也会限，这里再兜一次：脏数据不该撑爆气泡。
GREETING_MAX_LENGTH = 500


def greeting_text_for_user(greeting: str, display_name: str) -> str:
    """把配置的开场白拼成最终文案：``你好，{显示名}。`` + 换行 + 正文。

    显示名缺失（分享访客、历史脏数据）时退化成「你好。」—— 宁可少半句，
    也不要出现「你好，None。」这种一眼是 bug 的文案。
    """
    body = (greeting or "").strip()
    if not body:
        return ""
    name = (display_name or "").strip()
    if name:
        return f"你好，{name}。\n{body}"
    return f"你好。\n{body}"


def agent_greeting_message(agent: AgentProfile | None) -> str:
    """读出员工配置的开场白正文（未配置 / 非字符串一律返回空串）。"""
    if agent is None:
        return ""
    metadata = agent.metadata_json or {}
    value = metadata.get(GREETING_METADATA_KEY)
    if not isinstance(value, str):
        return ""
    return value.strip()[:GREETING_MAX_LENGTH]


def user_display_name(db: Session, user_id: str | None) -> str:
    """用户展示名：优先 display_name，缺省回落 username。

    与前端 `authUser.display_name || authUser.username` 同一口径 —— 两边不一致
    会让空态预览和落库后的正文对不上，用户会看到文案"跳"一下。
    """
    if not user_id:
        return ""
    user = db.get(User, user_id)
    if user is None:
        return ""
    return (user.display_name or user.username or "").strip()


def maybe_seed_greeting_message(db: Session, chat_session: ChatSession) -> Message | None:
    """会话**刚创建**时落一条开场白；已有消息则视为已播过，直接返回。

    幂等判据选「这个会话一条消息都没有」而不是「有没有 greeting 标记」：
    建会话的入口有三处（harness 首轮、调度入口、POST /sessions），任一处先
    落过之后，后到的调用都该安静退出；而且用户如果已经把对话推进了，也不该
    在中间插一条迟到的问候。

    调用方拿到的 Message 已经 add 到 session，但**不 commit** —— 与会话创建
    同一个事务，避免"会话建好了、开场白没落上"的中间态。
    """
    if chat_session.channel in _GREETING_SKIPPED_CHANNELS:
        return None
    if not chat_session.agent_id:
        return None

    existing = db.exec(
        select(Message.id).where(
            Message.tenant_id == chat_session.tenant_id,
            Message.session_id == chat_session.id,
        )
    ).first()
    if existing:
        return None

    agent = db.get(AgentProfile, chat_session.agent_id)
    greeting = agent_greeting_message(agent)
    if not greeting:
        return None

    content = greeting_text_for_user(
        greeting,
        user_display_name(db, chat_session.user_id),
    )
    if not content:
        return None

    message = Message(
        tenant_id=chat_session.tenant_id,
        session_id=chat_session.id,
        role="assistant",
        content=content,
        metadata_json={
            # 前端据此区分「开场白」与真实回复（不显示点评按钮、不参与分组）。
            "greeting": True,
            "greeting_agent_id": chat_session.agent_id,
        },
        # 比会话创建时间早 1ms：同一事务里 created_at 可能撞车，而这条必须
        # 稳定排在用户第一句之前，否则历史回放会把寒暄放到回答后面。
        created_at=utc_now() - timedelta(milliseconds=1),
    )
    db.add(message)
    db.flush()
    return message