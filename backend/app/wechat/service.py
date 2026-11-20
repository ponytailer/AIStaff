"""单条微信入站消息的完整处理链路。

流程（顺序即代码顺序，每一步都有明确理由）：

1. **幂等登记** — 同一 ``(binding_id, event_id)`` 只处理一次。getupdates 重连/
   游标回退会重放消息，没有这层会重复调 LLM、重复发消息。
2. **typing 开启** — LLM 一轮可能要几十秒，微信"正在输入"是唯一的等待反馈
   （iLink 没有流式接口可用，见 ``client`` 顶部说明）。
3. **指令拦截** — 指令早于身份解析与会话创建，不进 AgentLoop（省一次 LLM 调用）。
4. **身份解析** — 已绑定取实名账号，未绑定懒建（``identity.ensure_channel_user``）。
5. **会话锚定** — 按 ``(agent_id, channel, external_conv_id)`` 取/建会话，这是
   "切换员工后旧消息各归各家"的实现基础。
6. **调 LLM** — 复用主聊天链路的 ``AgentLoop.handle_turn``，``channel='wechat'``。
7. **发送回复** — 2000 字拆条；若本轮员工已被切走，加 ``【员工名】`` 前缀标归属。
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.core import AgentLoop
from app.agents.model_policy import MODEL_GATE_REPLY_CODES
from app.agents import greeting as greeting_module
from app.db.models import (
    AgentProfile,
    ChatSession,
    Message,
    User,
    WechatBinding,
    WechatInboundEvent,
    WechatConvState,
    new_id,
    utc_now,
)
from app.session.session_schema import ChatTurnRequest
from app.wechat import handoff as handoff_mod
from app.wechat import identity, media, routing
from app.wechat.client import WeChatClient, WeChatApiError

logger = logging.getLogger(__name__)

# 同一会话串行执行：并发两条消息会让 AgentLoop 抢同一会话状态
_session_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()

ERROR_REPLY = "抱歉，这一轮处理失败了。可以稍后重试，或换个说法再问一次。"
BUSY_REPLY = "上一条消息还在处理中，请稍等。" 

TITLE_LIMIT = 20


def _session_lock(session_id: str) -> threading.Lock:
    with _locks_guard:
        lock = _session_locks.get(session_id)
        if lock is None:
            lock = threading.Lock()
            _session_locks[session_id] = lock
        return lock


def external_conv_id_for(external_user_id: str) -> str:
    """p2p 会话锚点。iLink 只支持单聊，所以不需要群维度。"""
    return f"wechat_p2p_{external_user_id}"


# ---- 会话锚定 ------------------------------------------------------------


def find_or_create_session(
    db: Session,
    binding: WechatBinding,
    user: User,
    agent_id: str,
    external_conv_id: str,
    first_text: str,
) -> ChatSession:
    """按 (agent_id, channel, external_conv_id) 锚定会话。

    同一微信好友 + 不同员工 → 不同会话，因此切换员工天然隔离上下文。
    """
    existing = db.exec(
        select(ChatSession).where(
            ChatSession.tenant_id == binding.tenant_id,
            ChatSession.agent_id == agent_id,
            ChatSession.channel == "wechat",
            ChatSession.channel_binding_id == binding.id,
            ChatSession.external_conv_id == external_conv_id,
        )
    ).first()
    if existing is not None:
        changed = False
        if existing.user_id != user.id:
            # 绑定/解绑换过归属：直接改归属而不是另起会话，历史才连得上
            existing.user_id = user.id
            changed = True
        if existing.status != "active":
            existing.status = "active"
            changed = True
        if changed:
            existing.updated_at = utc_now()
            db.add(existing)
        return existing

    title = (first_text or "").strip()[:TITLE_LIMIT] or None
    row = ChatSession(
        id=new_id("session"),
        tenant_id=binding.tenant_id,
        user_id=user.id,
        agent_id=agent_id,
        title=title,
        channel="wechat",
        channel_binding_id=binding.id,
        external_conv_id=external_conv_id,
    )
    db.add(row)
    db.flush()
    return row


# ---- 幂等登记 ------------------------------------------------------------


def claim_event(
    db: Session,
    binding: WechatBinding,
    event_id: str,
    external_conv_id: str,
    payload: dict[str, Any],
) -> Optional[WechatInboundEvent]:
    """登记入站事件；已登记过返回 None（调用方据此跳过本轮）。"""
    row = WechatInboundEvent(
        tenant_id=binding.tenant_id,
        binding_id=binding.id,
        event_id=event_id,
        external_conv_id=external_conv_id,
        status="processing",
        payload_json=payload,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        logger.debug("微信入站事件重复（已处理过） binding=%s event=%s", binding.id, event_id)
        return None
    return row


def finish_event(db: Session, event: WechatInboundEvent, *, status: str, error: str = "") -> None:
    event.status = status
    event.error = error[:500]
    event.updated_at = utc_now()
    db.add(event)


# ---- 开场白 --------------------------------------------------------------


def _greeting_marker(conv_id: str, agent_id: str) -> str:
    return f"wechat_greeting:{conv_id}:{agent_id}"


def _already_greeted(db: Session, binding: WechatBinding, conv_id: str, agent_id: str) -> bool:
    """这个微信 × 这个员工是否已经打过招呼。

    用 ``WechatInboundEvent`` 当账本而不是新加一张表/一列：它就是「按
    (binding, event_id) 只处理一次」的幂等表，语义完全对得上，且天然带唯一
    约束——并发两条首消息不会各发一遍开场白（第二条插入冲突后视为已发过）。
    """
    return (
        db.exec(
            select(WechatInboundEvent.id).where(
                WechatInboundEvent.binding_id == binding.id,
                WechatInboundEvent.event_id == _greeting_marker(conv_id, agent_id),
            )
        ).first()
        is not None
    )


def _claim_greeting(db: Session, binding: WechatBinding, conv_id: str, agent_id: str) -> bool:
    """抢占「这次由我发开场白」的名额；返回 False 表示已经被别人发过。

    用 savepoint 而不是裸 flush + rollback：调用方那个事务里还挂着入站事件的
    状态变更，直接 rollback 会把它们一起丢掉。
    """
    try:
        with db.begin_nested():
            db.add(
                WechatInboundEvent(
                    tenant_id=binding.tenant_id,
                    binding_id=binding.id,
                    event_id=_greeting_marker(conv_id, agent_id),
                    external_conv_id=conv_id,
                    status="greeting",
                )
            )
    except IntegrityError:
        return False
    return True


def greeting_for(
    db: Session,
    binding: WechatBinding,
    *,
    conv_id: str,
    agent_id: str,
    agent_name: str,
    user: User,
    session_id: str | None = None,
) -> str:
    """算出「该发给这个人的开场白」；没配 / 已发过 / 抢不到名额都返回空串。

    为什么绑定在「这个人 × 这个员工」而不是「这个人」：微信里可以 /切换 员工，
    换到另一个员工时，如果那个员工配了开场白，理应也自报一次家门；而切回原
    员工不该重复寒暄。key 里带 agent_id 正好满足这两点。

    为什么在**第一条消息**里发而不是扫码确认时发：iLink 的 sendmessage 必须带
    ``context_token``，它只能从入站消息拿到。扫码那一刻我们手上没有任何 token，
    服务端会静默丢弃（返回 200 但消息不投递）。所以「扫码成功后发送」在协议上
    只能是「用户扫完码发出的第一句话，我们顺带把开场白一起回过去」。

    ``session_id`` 非空时把这条开场白也**落库**成一条真实 assistant 消息。不能
    只发不落：用户随时可能回到网页端接着聊，那边历史里若少一条寒暄，就会看到
    "员工没打招呼"；而且模型下一轮读不到自己说过这句，容易再寒暄一次。
    """
    agent = db.get(AgentProfile, agent_id)
    body = greeting_module.agent_greeting_message(agent)
    if not body:
        return ""
    if _already_greeted(db, binding, conv_id, agent_id):
        return ""
    if not _claim_greeting(db, binding, conv_id, agent_id):
        return ""
    text = greeting_module.channel_greeting_text(
        body,
        user.display_name or user.username or "",
        agent_name,
    )
    if not text:
        return ""
    if session_id:
        db.add(
            Message(
                tenant_id=binding.tenant_id,
                session_id=session_id,
                role="assistant",
                content=text,
                metadata_json={
                    # 与站内开场白同一套标记：前端据此隐藏点评按钮、不参与分组。
                    "greeting": True,
                    "greeting_agent_id": agent_id,
                    "channel": "wechat",
                },
            )
        )
    return text


# ---- 发送 ----------------------------------------------------------------


def send_reply(
    client: WeChatClient,
    binding: WechatBinding,
    to_user_id: str,
    context_token: str,
    text: str,
    *,
    attribution: str = "",
) -> None:
    """发送回复；``attribution`` 非空时加【员工名】前缀标注归属。

    迟到的旧轮回复靠这个前缀避免被误认成新员工在说话。

    含图片时先发图再发文字：微信里图片消息独立成条，先图后文符合阅读顺序。
    图片取不到/上传失败一律降级成文字说明，绝不让整轮回复丢掉。
    """
    body = text or ""
    if attribution:
        body = f"【{attribution}】\n{body}"

    # 图片必须摘出来单独发：留在正文里会以 "![](...)" 原样出现在微信上，
    # 那正是「回复里的图片无法显示」的直接原因。
    total_images = len(media.MARKDOWN_IMAGE_PATTERN.findall(body))
    body, images = media.extract_inline_images(body)
    cid_base = f"staffdeck:{binding.id}:{utc_now().timestamp():.0f}"

    if total_images > len(images):
        # 超出单条上限的图被丢了：别让用户以为只有这几张
        logger.info(
            "微信发图：单条上限 %s，丢弃 %s 张",
            media.MAX_IMAGES_PER_REPLY,
            total_images - len(images),
        )

    sent_images = _send_images(
        client, to_user_id, context_token, images, cid_base, tenant_id=binding.tenant_id
    )
    if images and sent_images == 0:
        # 一张都没发出去：告诉用户有图但发不了，而不是悄悄少一截内容
        note = "（本条回复中的配图暂时无法在微信中显示，可在 StaffDeck 网页端查看）"
        body = f"{body}\n\n{note}" if body else note
    elif sent_images:
        # 微信图片消息没有 caption 位，图题不补一句就等于丢了
        caption_note = media._caption_note(images)
        if total_images > len(images):
            caption_note = f"{caption_note}，另有 {total_images - len(images)} 张图超出单条上限未发送"
        if caption_note:
            body = f"{body}\n\n{caption_note}" if body else caption_note

    if body:
        client.send_text_chunked(
            to_user_id,
            context_token,
            body,
            client_id=cid_base,
        )


def _send_images(
    client: WeChatClient,
    to_user_id: str,
    context_token: str,
    images: list[media.InlineImage],
    cid_base: str,
    *,
    tenant_id: str = "",
) -> int:
    """逐张上传并发送，返回成功张数。单张失败只跳过该张。"""
    if not images:
        return 0
    sent = 0
    for index, image in enumerate(images):
        loaded = media.load_image_bytes(image.url, tenant_id=tenant_id)
        if loaded is None:
            # warning 而非 debug：这里跳过就是用户侧「图片不显示」，
            # 用 debug 时线上完全看不到原因，只能靠猜。
            logger.warning(
                "微信发图：本地取不到图片（资产缺失/格式不支持/超限），跳过 url=%s",
                image.url,
            )
            continue
        data, mime = loaded
        # 大图先压再传：CDN 直连对大图不稳，原图发不出去等于没修
        shrunk = media.shrink_for_upload(data)
        if shrunk is not data:
            data, mime = shrunk, "image/jpeg"
        uploaded = media.upload_image(client, to_user_id, data, mime)
        if uploaded is None:
            continue
        try:
            client.send_image(
                to_user_id,
                context_token,
                uploaded.encrypt_query_param,
                uploaded.aes_key,
                mid_size=uploaded.encrypted_size,
                client_id=f"{cid_base}:img{index}",
            )
            sent += 1
        except Exception:  # noqa: BLE001 - 单张图失败不影响后续
            logger.warning("微信发图：发送失败 index=%s", index, exc_info=True)
    return sent


def _typing(client: WeChatClient, external_user_id: str, context_token: str, status: int) -> None:
    """best-effort：拿不到 ticket 就跳过，绝不影响主链路。"""
    try:
        conf = client.get_config(external_user_id, context_token)
        ticket = str(conf.get("typing_ticket") or "")
        if ticket:
            client.send_typing(external_user_id, ticket, status)
    except Exception:  # noqa: BLE001 - typing 是增强体验，任何失败都不应影响对话
        logger.debug("微信 typing 失败（忽略）", exc_info=True)


# ---- 主链路 --------------------------------------------------------------


def process_inbound(
    binding: WechatBinding,
    inbound: dict[str, Any],
    *,
    db_session_factory,
    client: Optional[WeChatClient] = None,
) -> bool:
    """处理一条入站消息，返回是否真正执行了一轮对话。

    ``db_session_factory`` 注入是为了测试可替换 engine；生产传 ``Session(engine)``。
    """
    external_user_id = str(inbound.get("from_user_id") or "").strip()
    text = str(inbound.get("text") or "").strip()
    context_token = str(inbound.get("context_token") or "")
    event_id = str(inbound.get("event_id") or "").strip()
    if not external_user_id or not event_id:
        return False

    conv_id = external_conv_id_for(external_user_id)
    own_client = client is None
    cli = client or WeChatClient(
        binding.base_url,
        bot_token=_binding_token(binding),
    )

    try:
        with db_session_factory() as db:
            fresh = db.get(WechatBinding, binding.id)
            if fresh is None or fresh.status != "active":
                return False
            event = claim_event(db, fresh, event_id, conv_id, inbound.get("raw") or {})
            if event is None:
                return False

            # 身份与指令都放到下面统一处理：指令里 /员工 的列表要看「发消息的人」，
            # 所以必须先解析身份（见下方「身份优先于一切」）。

            # 身份优先于一切：/员工 列表、切换校验、会话归属都要看「发消息的人是谁」。
            # 先后顺序错了会让同事共用 bot 时看到别人的员工（越权）。
            #
            # 扫码人本人发消息：直接绑定，用户体验上「扫码即完成绑定」。
            # 必须先于 ensure_channel_user：自动绑定后取到的应是实名账号。
            identity.maybe_auto_bind_scan_user(db, fresh, external_user_id)
            user = identity.ensure_channel_user(db, fresh.tenant_id, external_user_id)

            menu_ids = routing.menu_agent_ids(db, fresh, conv_id)
            command = routing.parse_command(text, menu_active=bool(menu_ids))
            if command is not None and command.kind in {"handoff", "cancel_handoff"}:
                # 转人工要先知道「转给谁管的员工」，所以放到员工解析之后统一处理
                pass
            elif command is not None:
                if command.kind == "unbind":
                    reply = identity.unbind(db, fresh.tenant_id, external_user_id)
                else:
                    reply = routing.run_command(
                        db, fresh, conv_id, command, user=user
                    )
                finish_event(db, event, status="done")
                db.commit()
                _typing(cli, external_user_id, context_token, 2)
                send_reply(cli, fresh, external_user_id, context_token, reply)
                return False

            agent_id, pointer_reset = routing.resolve_current_agent(
                db, fresh, conv_id, user=user
            )
            if not agent_id:
                finish_event(db, event, status="failed", error="no_mounted_agent")
                db.commit()
                send_reply(
                    cli, fresh, external_user_id, context_token,
                    "你名下还没有可用的数字员工。可以在 StaffDeck 里创建员工或"
                    "使用广场上已发布的员工，然后回到这里重试。",
                )
                return False

            names = routing.agent_names(db, fresh.tenant_id, [agent_id])
            agent_name = names.get(agent_id) or agent_id
            revision = _current_revision(db, fresh, conv_id)

            session = find_or_create_session(db, fresh, user, agent_id, conv_id, text)

            # ---- 转人工 --------------------------------------------------
            if command is not None and command.kind == "cancel_handoff":
                reply = handoff_mod.cancel_handoff(db, session, agent_name)
                finish_event(db, event, status="done")
                db.commit()
                _typing(cli, external_user_id, context_token, 2)
                send_reply(cli, fresh, external_user_id, context_token, reply)
                return False

            if command is not None and command.kind == "handoff":
                _, reply = handoff_mod.request_handoff(
                    db,
                    binding=fresh,
                    chat_session=session,
                    agent_id=agent_id,
                    agent_name=agent_name,
                    user_question=handoff_mod.last_user_question(db, fresh.tenant_id, session.id) or text,
                )
                finish_event(db, event, status="done")
                db.commit()
                _typing(cli, external_user_id, context_token, 2)
                send_reply(cli, fresh, external_user_id, context_token, reply)
                return False

            # 已挂起等人工：不再调 LLM，否则数字员工会在「等人工」时抢答
            if session.status == "handoff":
                finish_event(db, event, status="done")
                db.commit()
                _typing(cli, external_user_id, context_token, 2)
                send_reply(
                    cli, fresh, external_user_id, context_token,
                    handoff_mod.WAITING_REPLY,
                )
                return False

            # 开场白：扫码后没法主动推（sendmessage 必须有 context_token，而它只
            # 存在于入站消息里），所以在他发来第一句话时补上，并自报是哪个员工。
            # 抢名额与事件入库同一个事务，commit 之后才算数——抢不到就静默跳过。
            #
            # ⚠️ 这里刻意**不**单独 commit：下面的 send_reply 全在 with 块外面，
            # 那时 session 已关闭，而 commit 会让 fresh 的所有属性重新过期，
            # 再取 fresh.id 就是 DetachedInstanceError。所以并入下面那一次
            # finish_event 的 commit，靠它之后的 fresh.tenant_id 一次性刷新。
            greeting_text = greeting_for(
                db,
                fresh,
                conv_id=conv_id,
                agent_id=agent_id,
                agent_name=agent_name,
                user=user,
                session_id=session.id,
            )

            finish_event(db, event, status="processing")
            db.commit()
            session_id = session.id
            user_id = user.id
            tenant_id = fresh.tenant_id

        if pointer_reset:
            # 原员工被移除/停用：先告知，再让新员工接话
            send_reply(
                cli, fresh, external_user_id, context_token,
                f"原员工已不可用，已切换到「{agent_name}」。",
            )

        # 开场白先落地：用户先看到「我是谁」，再看到这一轮的回答。
        # 单独一条消息而不是拼进回复里，是为了让它在历史记录里也是独立一条，
        # 与站内「开场白是真实 assistant 消息」的口径一致。
        if greeting_text:
            send_reply(cli, fresh, external_user_id, context_token, greeting_text)

        _typing(cli, external_user_id, context_token, 1)
        reply, error_code = _run_turn(
            db_session_factory,
            tenant_id=tenant_id,
            session_id=session_id,
            agent_id=agent_id,
            user_id=user_id,
            text=text,
            event_id=event_id,
        )
        _typing(cli, external_user_id, context_token, 2)

        with db_session_factory() as db:
            event = db.exec(
                select(WechatInboundEvent).where(
                    WechatInboundEvent.binding_id == binding.id,
                    WechatInboundEvent.event_id == event_id,
                )
            ).first()
            if event is not None:
                finish_event(
                    db, event,
                    status="failed" if error_code else "done",
                    error=error_code or "",
                )
                db.commit()

        if error_code:
            # 模型闸门（缺模型 / 免费额度用尽）的提示是写给使用者看的、可操作的，
            # 直接透传原文；其余内部错误仍换成通用文案，不把错误码抛给用户。
            if error_code in MODEL_GATE_REPLY_CODES and reply:
                send_reply(cli, fresh, external_user_id, context_token, reply)
                return False
            # 会话冲突/忙：让用户稍后重试，不要把内部错误码抛给用户
            hint = BUSY_REPLY if "BUSY" in error_code or "CONFLICT" in error_code else ERROR_REPLY
            send_reply(cli, fresh, external_user_id, context_token, hint)
            return False
        if not reply:
            return True

        # 迟到判定：本轮跑完后指针已变（用户中途 /切换 了），标注归属
        attribution = _attribution_if_stale(db_session_factory, binding, conv_id, agent_id, revision)
        send_reply(
            cli, fresh, external_user_id, context_token, reply,
            attribution=agent_name if attribution else "",
        )
        return True
    finally:
        if own_client:
            cli.close()


def _current_revision(db: Session, binding: WechatBinding, conv_id: str) -> Optional[int]:
    state = db.exec(
        select(WechatConvState).where(
            WechatConvState.binding_id == binding.id,
            WechatConvState.external_conv_id == conv_id,
        )
    ).first()
    return state.routing_revision if state is not None else None


def _attribution_if_stale(
    db_session_factory,
    binding: WechatBinding,
    conv_id: str,
    agent_id: str,
    revision: Optional[int],
) -> bool:
    """本轮员工是否已被切走（指针变了或已指向别人）。"""
    with db_session_factory() as db:
        state = db.exec(
            select(WechatConvState).where(
                WechatConvState.binding_id == binding.id,
                WechatConvState.external_conv_id == conv_id,
            )
        ).first()
        if state is None:
            return False
        if revision is not None and state.routing_revision != revision:
            return True
        return bool(state.current_agent_id and state.current_agent_id != agent_id)


def _run_turn(
    db_session_factory,
    *,
    tenant_id: str,
    session_id: str,
    agent_id: str,
    user_id: str,
    text: str,
    event_id: str,
) -> tuple[str, str]:
    """跑一轮 AgentLoop，返回 (reply, runtime_error_code)。"""
    with _session_lock(session_id):
        with db_session_factory() as db:
            request = ChatTurnRequest(
                tenant_id=tenant_id,
                session_id=session_id,
                agent_id=agent_id,
                user_id=user_id,
                message=text,
                channel="wechat",
                # 与站内同语义：同一 client_turn_id 的重复请求由引擎幂等
                client_turn_id=event_id,
            )
            try:
                response = AgentLoop(db).handle_turn(request)
            except Exception:  # noqa: BLE001 - 单条消息失败不能打挂轮询线程
                logger.exception("微信对话轮失败 session=%s", session_id)
                db.rollback()
                return "", "CHANNEL_TURN_EXCEPTION"
            reply = str(getattr(response, "reply", "") or "")
            error_code = str(getattr(response, "runtime_error_code", "") or "")
            return reply, error_code


def _binding_token(binding: WechatBinding) -> str:
    from app.wechat.crypto import decrypt_secret

    return decrypt_secret(binding.bot_token_enc)