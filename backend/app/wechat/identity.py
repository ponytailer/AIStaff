"""微信身份：懒建账号、自动绑定、/解绑。

设计取舍：

- 未绑定的微信用户按外部 id **懒建**一个 ``source='wechat'`` 的账号，这样
  零配置就能对话，也不占用租户成员名额（用户管理列表默认隐藏这类账号）。
- 扫码人本人发来第一句话时**自动**把微信身份接到实名 StaffDeck 账号，会话归属
  和记忆随之迁到实名用户，便于在网页端看到「我在微信里聊过的记录」。
- ``/解绑`` 反向迁回懒建账号，不删任何数据（解绑只是换归属，历史仍可追溯）。

绑定关系只有一个入口：扫码。iLink 扫码返回的 ``ilink_user_id`` 就是扫码登录
bot 的那个人，而这个 bot 只有他自己的微信能登录，所以「扫码」本身就足以确定
身份，不需要任何手动认领步骤。
"""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.db.models import (
    ChatSession,
    MemoryRecord,
    User,
    WechatBinding,
    WechatIdentityLink,
    utc_now,
)
from app.security.auth import hash_password

logger = logging.getLogger(__name__)

_USERNAME_UNSAFE = re.compile(r"[^a-zA-Z0-9_.@-]")


# ---- 懒建账号 ------------------------------------------------------------


def channel_username(tenant_id: str, external_user_id: str) -> str:
    """稳定可读的渠道用户名：微信 ID 清洗后 + 身份哈希后缀（防撞名/超长）。"""
    cleaned = _USERNAME_UNSAFE.sub("_", external_user_id)
    digest = hashlib.sha256(f"{tenant_id}:wechat:{external_user_id}".encode("utf-8")).hexdigest()[:8]
    if len(cleaned) > 53:
        cleaned = cleaned[:53]
    return f"wechat_{cleaned}..{digest}"


def display_name_for(external_user_id: str) -> str:
    body = external_user_id.split("@", 1)[0]
    suffix = body[-8:] if len(body) > 8 else body
    return f"微信用户 {suffix}"


def ensure_channel_user(db: Session, tenant_id: str, external_user_id: str) -> User:
    """取该微信身份对应的账号：已绑定返回实名账号，否则取/建懒建账号。"""
    link = find_link(db, tenant_id, external_user_id)
    if link is not None:
        user = db.get(User, link.user_id)
        if user is not None and user.tenant_id == tenant_id:
            return user

    username = channel_username(tenant_id, external_user_id)
    existing = db.exec(
        select(User).where(User.tenant_id == tenant_id, User.username == username)
    ).first()
    if existing is not None:
        return existing

    user = User(
        tenant_id=tenant_id,
        username=username,
        display_name=display_name_for(external_user_id),
        role="member",
        source="wechat",
        # 懒建账号不用于登录，口令随机且不落明文
        password_hash=hash_password(secrets.token_urlsafe(32)),
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        # 并发两条首消息同时懒建：回滚后取已存在的那一行
        db.rollback()
        user = db.exec(
            select(User).where(User.tenant_id == tenant_id, User.username == username)
        ).first()
        if user is None:
            raise
    return user


def find_link(db: Session, tenant_id: str, external_user_id: str) -> Optional[WechatIdentityLink]:
    return db.exec(
        select(WechatIdentityLink).where(
            WechatIdentityLink.tenant_id == tenant_id,
            WechatIdentityLink.external_user_id == external_user_id,
        )
    ).first()


def maybe_auto_bind_scan_user(
    db: Session,
    binding: WechatBinding,
    external_user_id: str,
) -> bool:
    """扫码人本人发消息时，自动完成绑定。

    前提：iLink 扫码返回的 ``ilink_user_id`` 是**扫码登录 bot 的那个人**，
    而不是每个使用者的身份。因此只有「发消息的人 == 扫码人」时才能确定
    他就是操作者本人，这时自动绑定到 ``owner_user_id`` 是安全且合理的。

    发消息的人与扫码人不一致（别人的微信发到了这个 bot 上）时不自动绑定，
    按普通微信访客处理，不会拿到 bot 主人的任何私有员工。
    """
    if not external_user_id or not binding.ilink_user_id:
        return False
    if external_user_id != binding.ilink_user_id:
        return False
    owner_id = binding.owner_user_id
    if not owner_id:
        return False
    if find_link(db, binding.tenant_id, external_user_id) is not None:
        return False

    owner = db.get(User, owner_id)
    if owner is None or owner.tenant_id != binding.tenant_id:
        return False

    channel_user = db.exec(
        select(User).where(
            User.tenant_id == binding.tenant_id,
            User.username == channel_username(binding.tenant_id, external_user_id),
        )
    ).first()

    moved = 0
    if channel_user is not None and channel_user.id != owner.id:
        moved = migrate_ownership(
            db, binding.tenant_id, from_user_id=channel_user.id, to_user_id=owner.id
        )

    db.add(
        WechatIdentityLink(
            tenant_id=binding.tenant_id,
            binding_id=binding.id,
            external_user_id=external_user_id,
            channel_user_id=channel_user.id if channel_user else "",
            user_id=owner.id,
        )
    )
    db.flush()
    logger.info(
        "扫码人本人首次对话，已自动绑定 external=%s user=%s moved=%s",
        external_user_id, owner.id, moved,
    )
    return True


def unbind(db: Session, tenant_id: str, external_user_id: str) -> str:
    """解绑并把人会话/记忆迁回懒建账号；数据不删除。"""
    link = find_link(db, tenant_id, external_user_id)
    if link is None:
        return "你的微信还没有绑定 StaffDeck 账号，无需解绑。"

    fallback = db.get(User, link.channel_user_id) if link.channel_user_id else None
    if fallback is None:
        fallback = ensure_channel_user(db, tenant_id, external_user_id)
    moved = migrate_ownership(db, tenant_id, from_user_id=link.user_id, to_user_id=fallback.id)
    db.delete(link)
    db.flush()
    suffix = f"，{moved} 条会话已迁回微信账号" if moved else ""
    return f"已解除绑定{suffix}。之后的对话仍可正常进行。"


def migrate_ownership(
    db: Session,
    tenant_id: str,
    *,
    from_user_id: str,
    to_user_id: str,
) -> int:
    """把渠道会话与记忆的归属从 A 迁到 B，返回迁移的会话数。

    只迁 ``channel='wechat'`` 的会话——站内会话不该因为一次微信绑定而换主人。
    """
    if not from_user_id or not to_user_id or from_user_id == to_user_id:
        return 0
    sessions = list(
        db.exec(
            select(ChatSession).where(
                ChatSession.tenant_id == tenant_id,
                ChatSession.user_id == from_user_id,
                ChatSession.channel == "wechat",
            )
        ).all()
    )
    for row in sessions:
        row.user_id = to_user_id
        row.updated_at = utc_now()
        db.add(row)

    memories = list(
        db.exec(
            select(MemoryRecord).where(
                MemoryRecord.tenant_id == tenant_id,
                MemoryRecord.user_id == from_user_id,
            )
        ).all()
    )
    for row in memories:
        row.user_id = to_user_id
        row.updated_at = utc_now()
        db.add(row)

    db.flush()
    return len(sessions)


def _link_display(db: Session, link: WechatIdentityLink) -> str:
    user = db.get(User, link.user_id)
    if user is None:
        return link.user_id
    return user.display_name or user.username