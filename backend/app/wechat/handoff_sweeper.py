"""微信转人工的「静默超时自动结束」。

业务规则（2026-11-20）
--------------------
人工回复之后，如果用户半小时内一句话都没说，就认为这次人工协助已经结束：
把会话放回可对话状态，并在微信里补一句说明。不这么做的话会有两个具体问题：

1. **用户以为还在等人工**。人工答完就没人再说话了，界面却没有任何「结束」信号，
   用户下一条消息发出去，被正在等待的会话状态挡住（或反过来被数字员工抢答，
   他分不清刚才是谁在答）。
2. **会话可能卡在 handoff**。人工回复链路会尽力把会话置回 ``active``，但恢复
   轮次失败、附件重放异常等分支会留下 ``status == "handoff"`` 的会话；此后每条
   消息都只会收到「请稍等」——而那头已经没有人了。

判定「用户说过话」的依据是**入站事件表**而不是消息表：会话挂起期间不跑 LLM，
用户消息不会落成 ``Message``，只留 ``WechatInboundEvent``。用消息表判断会把
「用户追问了两句」误判成静默，提前结束人工。

为什么不动 handoff.status
-----------------------
``answered`` 是本模块之外还有语义的状态：FAQ 沉淀（``api/faq``）只收
``answered`` 的人工回答来生成候选条目。为了「超时」把它改成 dismissed/resolved，
等于把这些已经付出人工成本的好答案从沉淀池里删掉。所以超时只写
``metadata.auto_closed_at`` + 会话状态，状态机留给业务本身。
"""

from __future__ import annotations

import logging
import threading
from datetime import timedelta
from typing import Optional

from sqlmodel import Session, select

from app.db.models import (
    ChatSession,
    HumanHandoffRequest,
    Message,
    WechatBinding,
    WechatInboundEvent,
    utc_now,
)

logger = logging.getLogger(__name__)

#: 人工回复后多久没动静就自动结束。产品定为半小时。
DEFAULT_IDLE_MINUTES = 30

SWEEP_INTERVAL_SECONDS = 120.0

AUTO_CLOSED_TEXT = (
    "本次人工协助已结束（{minutes} 分钟没有新消息）。\n"
    "后续消息继续由「{agent_name}」为你服务；需要真人时发送 /转人工。"
)

_stop_event = threading.Event()
_sweeper_thread: Optional[threading.Thread] = None


def _external_user_id(handoff: HumanHandoffRequest) -> str:
    """从 resume_payload 里的会话锚点取微信外部用户 id。

    锚点形如 ``wechat_p2p_<external_user_id>``；对外部 id 里本身含下划线的情况
    （``u1@im.wechat`` 不会，但别的租户可能）用 ``rsplit`` 只切一次，保证拿到
    完整尾部。
    """
    payload = handoff.resume_payload_json or {}
    conv_id = str(payload.get("external_conv_id") or "")
    if "wechat_p2p_" not in conv_id:
        return ""
    return conv_id.rsplit("wechat_p2p_", 1)[-1]


def _user_spoke_since(db: Session, handoff: HumanHandoffRequest, since) -> bool:
    """人工回复之后用户是否发过消息（入站事件或真实 user 消息都算）。"""
    payload = handoff.resume_payload_json or {}
    conv_id = str(payload.get("external_conv_id") or "")
    binding_id = str((handoff.metadata_json or {}).get("binding_id") or "")

    if binding_id and conv_id:
        event = db.exec(
            select(WechatInboundEvent.id)
            .where(WechatInboundEvent.binding_id == binding_id)
            .where(WechatInboundEvent.external_conv_id == conv_id)
            .where(WechatInboundEvent.created_at > since)
            .limit(1)
        ).first()
        if event is not None:
            return True

    # 兜底：站内投影里的人工回复也是 role=user，必须按 metadata 排除，
    # 否则「人工刚答完」会被当成「用户刚说过话」，永远不结束。
    rows = db.exec(
        select(Message)
        .where(Message.session_id == handoff.session_id)
        .where(Message.role == "user")
        .where(Message.created_at > since)
        .limit(20)
    ).all()
    for row in rows:
        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
        if metadata.get("human_reply"):
            continue
        return True
    return False


def _notify(
    db: Session,
    handoff: HumanHandoffRequest,
    text: str,
) -> bool:
    """把结束提示发到微信，并在会话里落一条同样的 assistant 消息。

    落库是为了网页端历史一致：用户回来看这段对话时，应该看得到「人工已结束」
    这条分割线，而不是莫名其妙又变成数字员工在答。
    """
    metadata = handoff.metadata_json if isinstance(handoff.metadata_json, dict) else {}
    binding_id = str(metadata.get("binding_id") or "")
    external_user_id = _external_user_id(handoff)

    db.add(
        Message(
            tenant_id=handoff.tenant_id,
            session_id=handoff.session_id,
            role="assistant",
            content=text,
            metadata_json={
                "channel": "wechat",
                "handoff_auto_closed": True,
                "handoff_id": handoff.id,
            },
            created_at=utc_now(),
        )
    )
    db.add(
        _agent_event(handoff, "human_handoff_auto_closed", {"reply": text})
    )

    if not binding_id or not external_user_id:
        return False

    binding = db.get(WechatBinding, binding_id)
    if binding is None or binding.status != "active":
        return False

    # 延迟导入：service 依赖 handoff 模块，模块级导入会成环
    from app.wechat import handoff as handoff_mod
    from app.wechat.client import WeChatClient
    from app.wechat.crypto import decrypt_secret
    from app.wechat.service import send_reply

    context_token = handoff_mod._latest_context_token(db, binding.id, f"wechat_p2p_{external_user_id}")
    if not context_token:
        # 拿不到 token 说明用户很久没开口，iLink 也不允许主动推送；落库即可
        logger.info("微信自动结束人工：无 context_token，仅落库 handoff=%s", handoff.id)
        return False

    client = WeChatClient(binding.base_url, bot_token=decrypt_secret(binding.bot_token_enc))
    try:
        send_reply(client, binding, external_user_id, context_token, text)
    except Exception:  # noqa: BLE001 - 通知失败不影响状态已结束
        logger.warning("微信自动结束人工：提示发送失败 handoff=%s", handoff.id, exc_info=True)
        return False
    finally:
        client.close()
    return True


def _agent_event(handoff: HumanHandoffRequest, event_type: str, extra: dict):
    from app.db.models import AgentEvent

    return AgentEvent(
        tenant_id=handoff.tenant_id,
        session_id=handoff.session_id,
        event_type=event_type,
        payload_json={"handoff_id": handoff.id, "agent_id": handoff.agent_id, **extra},
        created_at=utc_now(),
    )


def sweep_idle_handoffs(
    db: Session,
    *,
    idle_minutes: int = DEFAULT_IDLE_MINUTES,
    now=None,
) -> int:
    """把「人工回复后静默超时」的微信转人工收尾，返回处理条数。

    ``now`` 可注入，测试不必 sleep。
    """
    current = now or utc_now()
    deadline = current - timedelta(minutes=max(1, int(idle_minutes)))

    rows = db.exec(
        select(HumanHandoffRequest)
        .where(HumanHandoffRequest.status == "answered")
        .where(HumanHandoffRequest.answered_at.is_not(None))
        .where(HumanHandoffRequest.answered_at <= deadline)
        .order_by(HumanHandoffRequest.answered_at)
        .limit(200)
    ).all()

    closed = 0
    for handoff in rows:
        metadata = handoff.metadata_json if isinstance(handoff.metadata_json, dict) else {}
        if str(metadata.get("channel") or "") != "wechat":
            continue
        if metadata.get("auto_closed_at"):
            continue
        answered_at = handoff.answered_at
        if answered_at is None:
            continue
        if _user_spoke_since(db, handoff, answered_at):
            # 用户在窗口内说过话：这次人工协助还在进行，下个周期再看
            continue

        agent_name = str(metadata.get("agent_name") or "数字员工")
        text = AUTO_CLOSED_TEXT.format(minutes=int(idle_minutes), agent_name=agent_name)

        # 会话必须回到可对话状态，否则用户下一条消息只会收到「请稍等人工」
        chat_session = db.get(ChatSession, handoff.session_id)
        if chat_session is not None and chat_session.tenant_id == handoff.tenant_id:
            chat_session.status = "active"
            chat_session.awaiting_input_json = None
            chat_session.updated_at = current
            db.add(chat_session)

        handoff.metadata_json = {
            **metadata,
            "auto_closed_at": current.isoformat(),
            "auto_closed_reason": "idle_timeout",
            "auto_closed_idle_minutes": int(idle_minutes),
        }
        handoff.updated_at = current
        db.add(handoff)
        db.flush()

        try:
            _notify(db, handoff, text)
        except Exception:  # noqa: BLE001
            # 提示发不出去（网络、token 失效、模板异常）不该把已经结束的状态回滚掉：
            # 用户至少还能在网页端看到这条分割线，下个周期也不会重复扫同一张工单。
            logger.warning("微信自动结束人工：提示失败 handoff=%s", handoff.id, exc_info=True)
        closed += 1
        logger.info(
            "微信转人工静默超时自动结束 handoff=%s session=%s idle=%smin",
            handoff.id, handoff.session_id, idle_minutes,
        )

    if closed:
        db.commit()
    return closed


def _sweep_loop(interval_seconds: float, idle_minutes: int) -> None:
    from app.db import engine

    while not _stop_event.wait(max(5.0, interval_seconds)):
        try:
            with Session(engine) as db:
                count = sweep_idle_handoffs(db, idle_minutes=idle_minutes)
                if count:
                    logger.info("微信转人工静默超时处理 %s 条", count)
        except Exception:  # noqa: BLE001 - 扫描失败不能打死线程
            logger.exception("微信转人工超时扫描失败")


def start_handoff_sweeper(
    *, interval_seconds: float = SWEEP_INTERVAL_SECONDS, idle_minutes: int = DEFAULT_IDLE_MINUTES
) -> None:
    """只在负责微信轮询的那个进程里启动，避免多副本重复发提示。"""
    global _sweeper_thread
    if _sweeper_thread is not None and _sweeper_thread.is_alive():
        return
    _stop_event.clear()
    _sweeper_thread = threading.Thread(
        target=_sweep_loop,
        args=(interval_seconds, idle_minutes),
        name="wechat-handoff-sweeper",
        daemon=True,
    )
    _sweeper_thread.start()


def stop_handoff_sweeper() -> None:
    _stop_event.set()