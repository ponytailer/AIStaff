"""渠道凭证加密：bot_token 的对称加解密。

复用 Fernet 而不是引入新依赖；密钥优先取 ``CHANNEL_SECRET``，缺省时由
``APP_SECRET`` 派生（仅开发兜底，生产必须显式配置，否则换密钥即无法解密旧凭证）。
"""

from __future__ import annotations

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings

logger = logging.getLogger(__name__)

_warned_fallback_key = False


def _fernet_key() -> bytes:
    global _warned_fallback_key
    settings = get_settings()
    secret = getattr(settings, "channel_secret", "")
    if not secret:
        if not _warned_fallback_key:
            _warned_fallback_key = True
            logger.warning(
                "CHANNEL_SECRET 未配置，微信凭证改用 APP_SECRET 派生密钥加密，生产环境请务必配置"
            )
        secret = f"{settings.app_secret}:wechat"
    digest = hashlib.sha256(secret.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def encrypt_secret(plaintext: str) -> str:
    if not plaintext:
        return ""
    return Fernet(_fernet_key()).encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_secret(token: str) -> str:
    """解密失败返回空串而不是抛错：坏凭证应当表现为「未登录」，而不是打挂轮询线程。"""
    if not token:
        return ""
    try:
        return Fernet(_fernet_key()).decrypt(token.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError):
        logger.error("微信凭证解密失败，可能需要重新扫码绑定")
        return ""