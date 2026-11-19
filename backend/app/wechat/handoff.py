"""微信侧的「转人工」：把微信对话升级给真人，并把人工回复送回微信。

设计取向
--------
**复用站内已有的 HumanHandoffRequest，不另造一套工单。** 理由：
- 站内已有完整的待回答收件箱、权限、FAQ 沉淀、会话恢复链路；
- 管理员/负责人在同一个地方处理微信和网页的转人工，不需要两个入口；
- 唯一缺的一环是「回复怎么回到微信」，这一环在 ``deliver_human_reply``。

状态流转（与站内一致）
--------------------
``pending`` → （人工回复）``answered`` / （无需回答）``dismissed``

微信特有的两件事
--------------
1. **挂起期间不再调 LLM**：会话 ``status`` 已是 ``handoff``，但 polling 线程仍在
   收消息。若继续抛给 AgentLoop，数字员工会在「等人工」时抢答，用户会困惑。
   因此挂起时只把消息落库，回一句「已转人工，请稍等」。
2. **回复要回传到微信**：人工在站内回复后，AI/员工不该再复述一遍，直接把人工
   的原文发到微信，并标注是谁回答的（``【人工·张三】``）。
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from sqlmodel import Session, select

from app.db.models import (
    AgentProfile,
    ChatSession,
    HumanHandoffRequest,
    User,
    WechatBinding,
    utc_now,
)

logger = logging.getLogger(__name__)

#: 挂起期间用户再发消息时的固定提示（避免每一轮都跑 LLM）
WAITING_REPLY = (
    "已转接人工同事，你的消息已记录，请稍等回复。\n"
    "如需取消，发送 /取消转人工 可继续与数字员工对话。"
)

REQUESTED_REPLY_TEMPLATE = "已为你转接人工同事，稍后会有真人在这个对话里回复。\n（如需取消，发送 /取消转人工）"

CANCELLED_REPLY = "已取消转人工，继续由「{agent_name}」为你服务。"

NOTHING_TO_CANCEL_REPLY = "当前没有进行中的转人工。"


def _internal_user(db: Session, tenant_id: str, user_id: Optional[str]) -> Optional[User]:
    """只认站内账号——微信侧懒建的用户不该被派单。"""
    if not user_id:
        return None
    user = db.get(User, user_id)
    if user is None or user.tenant_id != tenant_id:
        return None
    return user if user.source == "web" else None


def resolve_assignee(db: Session, tenant_id: str, agent_id: Optional[str]) -> Optional[str]:
    """处理人优先级：员工 owner/创建人 → 租户管理员。

    与 ``HumanHandoffService.assignee_user_id`` 保持同一套优先级，这样微信转人工
    和站内转人工会落到同一个人手上。
    """
    if agent_id:
        agent = db.exec(
            select(AgentProfile).where(
                AgentProfile.tenant_id == tenant_id, AgentProfile.id == agent_id
            )
        ).first()
        metadata = agent.metadata_json if agent else {}
        if isinstance(metadata, dict):
            for key in (
                "owner_user_id",
                "created_by_user_id",
                "creator_user_id",
                "created_by",
                "owner_id",
            ):
                candidate = str(metadata.get(key) or "").strip() or None
                if _internal_user(db, tenant_id, candidate) is not None:
                    return candidate

    admin = db.exec(
        select(User)
        .where(User.tenant_id == tenant_id, User.role == "admin")
        .order_by(User.created_at)
    ).first()
    return admin.id if admin else None


def pending_handoff(db: Session, session_id: str) -> Optional[HumanHandoffRequest]:
    return db.exec(
        select(HumanHandoffRequest)
        .where(HumanHandoffRequest.session_id == session_id)
        .where(HumanHandoffRequest.status == "pending")
    ).first()


def request_handoff(
    db: Session,
    *,
    binding: WechatBinding,
    chat_session: ChatSession,
    agent_id: Optional[str],
    agent_name: str,
    user_question: str,
) -> tuple[bool, str]:
    """为一条微信会话创建（或复用）转人工请求。

    返回（是否新建，要回给用户的文本）。已有 pending 时直接复用——用户连发几条
    「转人工」不该产生多张工单。
    """
    existing = pending_handoff(db, chat_session.id)
    if existing is not None:
        return False, WAITING_REPLY

    assignee = resolve_assignee(db, binding.tenant_id, agent_id)
    if not assignee:
        # 没有可派单的站内账号：说清楚而不是静默失败
        return False, "暂时找不到可接手的同事，请联系管理员在 StaffDeck 里配置负责人。"

    handoff = HumanHandoffRequest(
        tenant_id=binding.tenant_id,
        session_id=chat_session.id,
        agent_id=agent_id,
        requester_user_id=chat_session.user_id,
        assignee_user_id=assignee,
        context_summary=f"微信用户请求人工协助（渠道：微信）",
        pending_question=user_question[:500],
        resume_payload_json={
            "channel": "wechat",
            "binding_id": binding.id,
            "external_conv_id": chat_session.external_conv_id,
        },
        metadata_json={
            "channel": "wechat",
            "binding_id": binding.id,
            "agent_name": agent_name,
            "assignee_notify_channel": "web",
        },
    )
    db.add(handoff)
    chat_session.status = "handoff"
    chat_session.awaiting_input_json = {
        "type": "human_handoff",
        "handoff_id": handoff.id,
        "pending_question": handoff.pending_question,
    }
    chat_session.updated_at = utc_now()
    db.add(chat_session)
    db.commit()
    logger.info(
        "微信转人工已创建 session=%s assignee=%s agent=%s",
        chat_session.id, assignee, agent_id,
    )
    return True, REQUESTED_REPLY_TEMPLATE


def cancel_handoff(db: Session, chat_session: ChatSession, agent_name: str) -> str:
    """用户主动取消转人工，回到数字员工。"""
    existing = pending_handoff(db, chat_session.id)
    if existing is None:
        return NOTHING_TO_CANCEL_REPLY
    existing.status = "dismissed"
    existing.updated_at = utc_now()
    db.add(existing)
    chat_session.status = "active"
    chat_session.awaiting_input_json = None
    chat_session.updated_at = utc_now()
    db.add(chat_session)
    db.commit()
    return CANCELLED_REPLY.format(agent_name=agent_name)


# ---- 人工回复回传微信 ----------------------------------------------------


def _reply_sender_name(db: Session, user_id: Optional[str]) -> str:
    if not user_id:
        return "人工"
    row = db.get(User, user_id)
    if row is None:
        return "人工"
    return row.display_name or row.username or "人工"


def deliver_human_reply(
    db: Session,
    handoff: HumanHandoffRequest,
    reply: str,
    *,
    answered_by_user_id: Optional[str] = None,
) -> bool:
    """把人工回复推送到微信。

    由站内回复链路在 ``_apply_handoff_reply`` 之后调用；只处理渠道为微信的
    handoff（``metadata_json.channel == 'wechat'``），其余原样跳过。

    返回是否真的投递了（False 表示不是微信 handoff 或缺少投递信息）。
    """
    metadata = handoff.metadata_json or {}
    if str(metadata.get("channel") or "") != "wechat":
        return False

    binding_id = str(metadata.get("binding_id") or "")
    external_conv_id = str(
        (handoff.resume_payload_json or {}).get("external_conv_id") or ""
    )
    if not binding_id or not external_conv_id:
        logger.warning("微信转人工回复缺少投递信息 handoff=%s", handoff.id)
        return False

    binding = db.get(WechatBinding, binding_id)
    if binding is None or binding.status != "active":
        logger.warning("微信转人工回复：绑定不可用 handoff=%s", handoff.id)
        return False

    # external_conv_id 形如 wechat_p2p_<external_user_id>
    external_user_id = external_conv_id.rsplit("wechat_p2p_", 1)[-1]
    if not external_user_id:
        return False

    context_token = _latest_context_token(db, binding.id, external_conv_id)
    if not context_token:
        logger.warning("微信转人工回复：找不到 context_token handoff=%s", handoff.id)
        return False

    sender = _reply_sender_name(db, answered_by_user_id or handoff.assignee_user_id)
    body = f"【人工·{sender}】\n{reply}" if reply else ""

    # 延迟导入：service 依赖本模块，模块级互引导会成环
    from app.wechat.crypto import decrypt_secret
    from app.wechat.service import send_reply
    from app.wechat.client import WeChatClient

    client = WeChatClient(binding.base_url, bot_token=decrypt_secret(binding.bot_token_enc))
    try:
        send_reply(client, binding, external_user_id, context_token, body)
    except Exception:  # noqa: BLE001 - 投递失败不能影响站内回复已落库
        logger.exception("微信转人工回复投递失败 handoff=%s", handoff.id)
        return False
    finally:
        client.close()
    return True


def _latest_context_token(db: Session, binding_id: str, external_conv_id: str) -> str:
    """取该会话最近的 context_token。

    ``context_token`` 在 iLink 里可长期复用，用户新消息会刷新它。入站事件表里
    存了原始报文，按 (binding, conv) 精确取最近一条即可，不必另建表。
    """
    from app.db.models import WechatInboundEvent

    row = db.exec(
        select(WechatInboundEvent)
        .where(WechatInboundEvent.binding_id == binding_id)
        .where(WechatInboundEvent.external_conv_id == external_conv_id)
        .order_by(WechatInboundEvent.created_at.desc())
        .limit(1)
    ).first()
    if row is None:
        return ""
    payload = row.payload_json or {}
    return str(payload.get("context_token") or "")


def resolve_conv_session_id(db: Session, binding_id: str, external_conv_id: str) -> Optional[str]:
    return db.exec(
        select(ChatSession.id)
        .where(ChatSession.channel_binding_id == binding_id)
        .where(ChatSession.external_conv_id == external_conv_id)
        .order_by(ChatSession.updated_at.desc())
        .limit(1)
    ).first()


#: 纯转人工触发词：不能当「用户的问题」写进工单，否则处理人看到的只有「转人工」。
_HANDOFF_TRIGGERS = {"转人工", "人工", "人工客服", "handoff", "human", "/转人工", "/人工"}


def last_user_question(db: Session, tenant_id: str, session_id: str) -> str:
    """会话里用户最后一条真实提问（跳过纯触发词与人工资讯记录）。"""
    from app.db.models import Message

    if not session_id:
        return ""
    rows = db.exec(
        select(Message)
        .where(
            Message.tenant_id == tenant_id,
            Message.session_id == session_id,
            Message.role == "user",
        )
        .order_by(Message.created_at.desc())
        .limit(20)
    ).all()
    for row in rows:
        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
        # 人工回复也以 user 角色落库，不能当问法
        if metadata.get("human_reply"):
            continue
        text = (row.content or "").strip()
        if not text or text.lower() in _HANDOFF_TRIGGERS:
            continue
        return text[:500]
    return ""