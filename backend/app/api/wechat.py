"""微信渠道 REST API：扫码接入、挂载员工。

权限口径：每个成员扫自己的码、配自己的微信，绑定行按 ``owner_user_id`` 隔离；
管理员能看/管全部绑定。
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.db import engine, get_session
from app.db.models import (
    AgentProfile,
    User,
    WechatBinding,
    WechatBindingAgent,
    utc_now,
)
from app.security.auth import get_current_user
from app.security.permissions import is_admin_user
from app.wechat import poller, routing
from app.wechat.client import WeChatApiError, WeChatClient, sanitize_base_url
from app.wechat.crypto import decrypt_secret, encrypt_secret

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/enterprise/wechat", tags=["enterprise:wechat"])

# 二维码缓存：qrcode key -> 创建时间，用于前端"已过期"判定与清理
_QRCODE_TTL_SECONDS = 300


# ---- schemas -------------------------------------------------------------


class QrcodeResponse(BaseModel):
    qrcode: str
    qrcode_url: str = ""
    expires_in: int = _QRCODE_TTL_SECONDS


class QrcodeStatusResponse(BaseModel):
    status: str
    binding_id: Optional[str] = None
    display_name: str = ""
    message: str = ""


class MountedAgentRead(BaseModel):
    agent_id: str
    name: str
    is_default: bool = False
    sort_order: int = 0


class BindingRead(BaseModel):
    id: str
    status: str
    display_name: str = ""
    ilink_bot_id: str = ""
    agents: list[MountedAgentRead] = Field(default_factory=list)
    last_error: str = ""
    last_seen_at: Optional[str] = None
    created_at: Optional[str] = None
    #: 这一行是不是当前登录用户自己扫的。列表接口现在只返回自己的行，因此恒为
    #: True；保留字段是为了前端在「非本人」场景下不误操作（防御性，不是常态）。
    owned_by_me: bool = True


class MountAgentsRequest(BaseModel):
    agent_ids: list[str] = Field(default_factory=list)
    default_agent_id: Optional[str] = None


# ---- helpers -------------------------------------------------------------


def _guard_tenant(tenant_id: str, current_user: User) -> None:
    if tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Tenant mismatch")


def _get_binding(db: Session, tenant_id: str, binding_id: str) -> WechatBinding:
    row = db.get(WechatBinding, binding_id)
    if row is None or row.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="微信绑定不存在")
    return row


def _get_owned_binding(
    db: Session, tenant_id: str, binding_id: str, current_user: User
) -> WechatBinding:
    """取「属于当前用户」的绑定。

    绑定是用户私有资源：别人扫的微信不该被你能改。管理员例外——排障与
    「这个 bot 出问题了」的场景需要能看能改。
    """
    row = _get_binding(db, tenant_id, binding_id)
    if row.owner_user_id == current_user.id or is_admin_user(current_user):
        return row
    raise HTTPException(status_code=404, detail="微信绑定不存在")


def _binding_read(
    db: Session,
    binding: WechatBinding,
    *,
    viewer: Optional[User] = None,
) -> BindingRead:
    mounts = list(
        db.exec(
            select(WechatBindingAgent)
            .where(WechatBindingAgent.binding_id == binding.id)
            .order_by(WechatBindingAgent.sort_order, WechatBindingAgent.created_at)
        ).all()
    )
    names: dict[str, str] = {}
    if mounts:
        rows = db.exec(
            select(AgentProfile).where(
                AgentProfile.tenant_id == binding.tenant_id,
                AgentProfile.id.in_([m.agent_id for m in mounts]),  # type: ignore[attr-defined]
            )
        ).all()
        names = {r.id: r.name for r in rows}
    return BindingRead(
        id=binding.id,
        status=binding.status,
        display_name=binding.display_name,
        ilink_bot_id=binding.ilink_bot_id,
        agents=[
            MountedAgentRead(
                agent_id=m.agent_id,
                name=names.get(m.agent_id, m.agent_id),
                is_default=m.is_default,
                sort_order=m.sort_order,
            )
            for m in mounts
        ],
        last_error=binding.last_error,
        last_seen_at=binding.last_seen_at.isoformat() if binding.last_seen_at else None,
        created_at=binding.created_at.isoformat() if binding.created_at else None,
        owned_by_me=(viewer is None or binding.owner_user_id == viewer.id),
    )


def _poller_kwargs():
    """轮询线程依赖：DB 会话工厂、客户端工厂、消息处理器。"""
    from app.wechat import service

    def client_factory(binding: WechatBinding) -> WeChatClient:
        return WeChatClient(binding.base_url, bot_token=decrypt_secret(binding.bot_token_enc))

    return {
        "db_session_factory": lambda: Session(engine),
        "client_factory": client_factory,
        "handler": lambda binding, inbound, client=None: service.process_inbound(
            binding,
            inbound,
            db_session_factory=lambda: Session(engine),
            client=client,
        ),
    }


def _stop_polling(binding_id: str) -> None:
    try:
        poller.stop(binding_id)
    except Exception:  # noqa: BLE001 - 停轮询失败不该阻塞换绑
        logger.exception("停止微信长轮询失败 binding=%s", binding_id)


def _start_polling(binding_id: str) -> None:
    try:
        poller.start(binding_id, **_poller_kwargs())
    except Exception:  # noqa: BLE001 - 轮询起不来不该阻塞绑定成功
        logger.exception("启动微信长轮询失败 binding=%s", binding_id)


# ---- 扫码接入 ------------------------------------------------------------


@router.post("/qrcode", response_model=QrcodeResponse)
def create_qrcode(
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> QrcodeResponse:
    """获取登录二维码。

    **任何成员都可以扫**：扫的是他自己的微信，接的是他自己的 bot，
    配的是他自己有权限的员工。不需要管理员代劳。

    但**一个账号只允许一条接入**（2026-11-20）：已经接入成功的用户，前端会把
    按钮置灰；这里再挡一次是为了防绕过（旧页面缓存、直接调接口）。否则重复扫码
    会在服务端悄悄把旧绑定断开换成新的，用户以为"多接了几个"，实际只有一个在跑。
    """
    _guard_tenant(tenant_id, current_user)

    existing = db.exec(
        select(WechatBinding).where(
            WechatBinding.tenant_id == tenant_id,
            WechatBinding.owner_user_id == current_user.id,
            WechatBinding.status == "active",
        )
    ).first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail="你已经接入了一个微信。如需换绑，请先断开当前接入。",
        )

    # 已登录过的 bot token 一并带上：同一微信重复扫码时服务端会恢复而非新建。
    # **只带自己的 token，管理员也不例外**。原先这里对管理员放开了全租户，
    # 后果远不止「看到别人的绑定」：iLink 拿到别人的旧 token 会把那个 bot
    # 恢复成新绑定，即管理员扫自己的码可能把别人的微信接管到自己名下
    # （2026-11-20 与「看到不属于自己的绑定」同批发现）。凭证归属不做角色豁免。
    token_owner = select(WechatBinding).where(
        WechatBinding.tenant_id == tenant_id,
        WechatBinding.bot_token_enc != "",
        WechatBinding.owner_user_id == current_user.id,
    )
    local_tokens = [
        token
        for token in (decrypt_secret(row.bot_token_enc) for row in db.exec(token_owner).all())
        if token
    ]

    client = WeChatClient(sanitize_base_url(""))
    try:
        data = client.get_bot_qrcode(local_tokens)
    except (WeChatApiError, Exception) as exc:  # noqa: BLE001
        logger.exception("获取微信二维码失败")
        raise HTTPException(status_code=502, detail=f"获取微信二维码失败：{exc}") from exc
    finally:
        client.close()

    qrcode = str(data.get("qrcode") or "")
    if not qrcode:
        raise HTTPException(status_code=502, detail="微信未返回二维码")
    return QrcodeResponse(
        qrcode=qrcode,
        qrcode_url=str(data.get("qrcode_img_content") or ""),
        expires_in=_QRCODE_TTL_SECONDS,
    )


@router.get("/qrcode/status", response_model=QrcodeStatusResponse)
def poll_qrcode_status(
    tenant_id: str = Query(...),
    qrcode: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> QrcodeStatusResponse:
    """轮询扫码状态；confirmed 时落库并拉起长轮询。

    与 ``/qrcode`` 一致：任何人扫自己的码，不再要求管理员。
    """
    _guard_tenant(tenant_id, current_user)

    client = WeChatClient(sanitize_base_url(""))
    try:
        data = client.get_qrcode_status(qrcode)
    except (WeChatApiError, Exception) as exc:  # noqa: BLE001
        logger.warning("查询扫码状态失败: %s", exc)
        raise HTTPException(status_code=502, detail="查询扫码状态失败，请重试") from exc
    finally:
        client.close()

    status = str(data.get("status") or "wait")
    if status != "confirmed":
        return QrcodeStatusResponse(status=status)

    bot_token = str(data.get("bot_token") or "")
    ilink_bot_id = str(data.get("ilink_bot_id") or "")
    ilink_user_id = str(data.get("ilink_user_id") or "")
    raw_base = str(data.get("baseurl") or "")
    if not bot_token:
        raise HTTPException(status_code=502, detail="微信未返回凭证，请重新扫码")

    # 同一 bot 重复扫码：恢复原绑定而不是新建（历史会话才能接上）
    binding = db.exec(
        select(WechatBinding).where(
            WechatBinding.tenant_id == tenant_id,
            WechatBinding.ilink_bot_id == ilink_bot_id,
        )
    ).first() if ilink_bot_id else None

    restored = binding is not None
    if binding is None:
        # 这个用户已有一条活跃绑定（换了微信号重新扫）：先断开旧的，
        # 保证「一人一微信」而不是留下两条都在跑轮询的绑定。
        previous = db.exec(
            select(WechatBinding).where(
                WechatBinding.tenant_id == tenant_id,
                WechatBinding.owner_user_id == current_user.id,
                WechatBinding.status == "active",
            )
        ).first()
        if previous is not None:
            previous.status = "disconnected"
            previous.updated_at = utc_now()
            db.add(previous)
            db.flush()
            _stop_polling(previous.id)

        binding = WechatBinding(
            tenant_id=tenant_id,
            owner_user_id=current_user.id,
            ilink_bot_id=ilink_bot_id,
            ilink_user_id=ilink_user_id,
            status="active",
        )
    binding.bot_token_enc = encrypt_secret(bot_token)
    binding.base_url = sanitize_base_url(raw_base)
    binding.ilink_user_id = ilink_user_id or binding.ilink_user_id
    binding.status = "active"
    binding.last_error = ""
    binding.updated_at = utc_now()
    # 重新登录后游标可能失效，清空让服务端按新会话重新给基线
    binding.updates_cursor = ""
    db.add(binding)
    try:
        db.commit()
    except IntegrityError:
        # 并发确认（前端重试 / 双击）撞上唯一约束：说明另一请求已经建好了，
        # 取回那一行继续，不要抛 500，也不要再起一个轮询线程。
        db.rollback()
        binding = db.exec(
            select(WechatBinding).where(
                WechatBinding.tenant_id == tenant_id,
                WechatBinding.ilink_bot_id == ilink_bot_id,
            )
        ).first()
        if binding is None:
            raise HTTPException(status_code=409, detail="接入冲突，请重试") from None
        restored = True
        # 只补凭证，不重复启动轮询
        binding.bot_token_enc = encrypt_secret(bot_token)
        binding.updates_cursor = ""
        db.add(binding)
        db.commit()
    db.refresh(binding)

    _start_polling(binding.id)
    return QrcodeStatusResponse(
        status="confirmed",
        binding_id=binding.id,
        display_name=binding.display_name,
        message="该微信已接入过，已恢复连接" if restored else "微信接入成功",
    )


# ---- 绑定管理 ------------------------------------------------------------


@router.get("/bindings", response_model=list[BindingRead])
def list_bindings(
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> list[BindingRead]:
    """我的微信接入：**只返回当前用户自己扫的那一条**。

    绑定是用户私有资源，这个页面是「我的微信」，不是租户绑定管理台。
    管理员身份不做豁免（2026-11-20 二次反馈「这里只看自己的即可，不需要看
    别人的」）：上一版曾给管理员返回租户内全部绑定用于排障，结果页面上出现了
    不属于自己的 bot，用户分不清哪行是自己的——排障需求不该污染这个页面。
    """
    _guard_tenant(tenant_id, current_user)
    rows = db.exec(
        select(WechatBinding)
        .where(
            WechatBinding.tenant_id == tenant_id,
            WechatBinding.owner_user_id == current_user.id,
        )
        .order_by(WechatBinding.created_at)
    ).all()
    return [_binding_read(db, row, viewer=current_user) for row in rows]


@router.get("/bindings/{binding_id}", response_model=BindingRead)
def get_binding(
    binding_id: str,
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> BindingRead:
    _guard_tenant(tenant_id, current_user)
    return _binding_read(
        db, _get_owned_binding(db, tenant_id, binding_id, current_user), viewer=current_user
    )


@router.put("/bindings/{binding_id}/agents", response_model=BindingRead)
def mount_agents(
    binding_id: str,
    payload: MountAgentsRequest,
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> BindingRead:
    """设置「我这个微信」能对话的员工集合与默认员工（整表替换）。"""
    _guard_tenant(tenant_id, current_user)
    binding = _get_owned_binding(db, tenant_id, binding_id, current_user)

    # 只能挂「自己有权限用的」员工：这条校验和 /员工 列表的回退集同源，
    # 否则会出现「网页上隐藏的员工被塞进微信」的越权。
    if payload.agent_ids:
        allowed = set(routing.visible_agent_ids_for(db, tenant_id, binding.owner_user_id))
        unknown = [aid for aid in payload.agent_ids if aid not in allowed]
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f"没有使用这些员工的权限或员工已停用：{unknown}",
            )

    default_id = payload.default_agent_id or (payload.agent_ids[0] if payload.agent_ids else "")
    if default_id and default_id not in payload.agent_ids:
        raise HTTPException(status_code=400, detail="默认员工必须在挂载列表内")

    db.exec(
        WechatBindingAgent.__table__.delete().where(
            WechatBindingAgent.binding_id == binding.id
        )
    )
    for order, agent_id in enumerate(payload.agent_ids):
        db.add(
            WechatBindingAgent(
                tenant_id=tenant_id,
                binding_id=binding.id,
                agent_id=agent_id,
                is_default=(agent_id == default_id),
                sort_order=order,
            )
        )
    binding.updated_at = utc_now()
    db.add(binding)
    db.commit()
    return _binding_read(db, binding, viewer=current_user)


@router.post("/bindings/{binding_id}/disconnect", response_model=BindingRead)
def disconnect_binding(
    binding_id: str,
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> BindingRead:
    """断开接入：停轮询、置 disconnected；会话记录保留，可重新扫码恢复。"""
    _guard_tenant(tenant_id, current_user)
    binding = _get_owned_binding(db, tenant_id, binding_id, current_user)

    poller.stop(binding.id)
    binding.status = "disconnected"
    binding.last_error = ""
    binding.updated_at = utc_now()
    db.add(binding)
    db.commit()
    return _binding_read(db, binding, viewer=current_user)


@router.delete("/bindings/{binding_id}")
def delete_binding(
    binding_id: str,
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    """彻底删除绑定与挂载配置。会话与消息不删（历史可读）。

    **必须先断开**（2026-11-20）：删除一条 active 绑定等于让一个还在跑的 bot
    失去归属——轮询线程会停，但用户那边看到的是「突然不回消息了」且无法自愈。
    先断开让用户明确知道「这个微信不再接了」，再删才没有歧义。
    """
    _guard_tenant(tenant_id, current_user)
    binding = _get_owned_binding(db, tenant_id, binding_id, current_user)
    if binding.status == "active":
        raise HTTPException(status_code=409, detail="请先断开接入，再删除这条记录。")

    poller.stop(binding.id)
    db.exec(
        WechatBindingAgent.__table__.delete().where(
            WechatBindingAgent.binding_id == binding.id
        )
    )
    db.delete(binding)
    db.commit()
    return {"status": "deleted"}
