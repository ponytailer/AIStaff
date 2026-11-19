"""微信侧发送图片：把回复正文里的 markdown 图片真正投递成微信图片消息。

为什么需要这一层
----------------
员工回复里带的是站内 markdown：``![图题](/api/knowledge/assets/kasset_x?sig=...)``。
原先一律走 ``send_text_chunked``，这些标记会**原样当文本**发到微信，用户看到的是
一长串 ``![...](...)`` —— 也就是「回复里的图片无法显示」。

iLink 发图必须走三步（协议事实，顺序不能变）：
1. ``getuploadurl`` 申请 CDN 上传凭据（带明文/密文大小与 MD5）；
2. 把 **AES-128-ECB 加密后**的字节 POST 到 CDN，从响应头 ``x-encrypted-param``
   拿到下载参数；
3. ``sendmessage`` 里放 ``item_list: [{type: 2, image_item: {media: {...}}}]``。

关键细节
--------
- ``image_item`` 的字段是 ``media``（不是 ``cdn_media``），``CDNMedia`` 为
  ``{encrypt_query_param, aes_key}``；图片的 ``aes_key`` 用 **base64(raw 16B)**。
- ``no_need_thumb: true`` 可以跳过缩略图，省掉一组 ``thumb_*`` 参数与额外上传；
  缩略图缺失在客户端只会走「下载原图」，不影响展示。
- 图片字节优先从本地资产库读（``kasset://`` / ``/api/knowledge/assets/...``），
  不依赖公网可达性——微信侧没必要绕一圈 HTTP 回源到自己的接口。
"""

from __future__ import annotations

import base64
import hashlib
import logging
import mimetypes
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

import httpx
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from app.config import get_settings

logger = logging.getLogger(__name__)

#: UploadMediaType.IMAGE
MEDIA_TYPE_IMAGE = 1
#: MessageItemType.IMAGE
ITEM_IMAGE = 2

#: markdown 图片：``![alt](url)``。URL 里可能带 ``?sig=`` 与括号之外的空白。
MARKDOWN_IMAGE_PATTERN = re.compile(r"!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)")

#: 只处理这些协议/路径的图片；其余（外链 http 图）不做远程抓取，
#: 避免把内网地址当成可抓取目标（SSRF）。
_LOCAL_ASSET_ID_PATTERN = re.compile(
    r"(?:kasset://|/api/knowledge/assets/)([A-Za-z0-9_]+)"
)

#: 微信客户端对图片有大小限制；超过就不发，退化成文字说明。
MAX_IMAGE_BYTES = 10 * 1024 * 1024

#: 单条回复最多发几张图，防止一轮几十张图刷屏。
MAX_IMAGES_PER_REPLY = 4

_IMAGE_MIME_PREFIX = "image/"

#: 微信不认的矢量/办公图格式，发了也是裂图，直接跳过。
_UNSUPPORTED_IMAGE_MIMES = {
    "image/svg+xml",
    "image/emf",
    "image/x-emf",
    "image/wmf",
    "image/tiff",
}


@dataclass
class InlineImage:
    """一段待发送的图片：URL + 图题（可空）。"""

    url: str
    caption: str = ""


@dataclass
class UploadedImage:
    """上传成功后的 CDN 引用。"""

    encrypt_query_param: str
    aes_key: str
    size: int


def aes_ecb_encrypt(data: bytes, key: bytes) -> bytes:
    """AES-128-ECB + PKCS7。iLink CDN 的固定加密方式。"""
    if len(key) != 16:
        raise ValueError("AES-128 key 必须是 16 字节")
    pad = 16 - len(data) % 16
    padded = data + bytes([pad]) * pad
    encryptor = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return encryptor.update(padded) + encryptor.finalize()


def _md5_hex(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def extract_inline_images(text: str) -> tuple[str, list[InlineImage]]:
    """从回复正文里摘出 markdown 图片，返回（剥掉图片的正文，图片列表）。

    图片在微信里会作为独立消息发送，正文里必须移除标记——否则用户看到的是
    一串 ``![图题](url)`` 噪声。图题保留在图片附近会不会丢信息？不会：微信图片
    消息本身没有 caption 字段，图题改由紧随其后的文本行补一句「见图：xxx」，
    由 ``_caption_note`` 统一生成。
    """
    if not text or "![" not in text:
        return text, []

    images: list[InlineImage] = []

    def _collect(match: re.Match[str]) -> str:
        url = (match.group(2) or "").strip()
        if not url or len(images) >= MAX_IMAGES_PER_REPLY:
            # 超额的图直接丢弃标记，避免把 url 当正文发出去
            return ""
        images.append(InlineImage(url=url, caption=(match.group(1) or "").strip()))
        return ""

    cleaned = MARKDOWN_IMAGE_PATTERN.sub(_collect, text)
    # 图片被摘掉后常留下整行空白，压掉连续空行免得微信里出现大片空白
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, images


def _caption_note(images: Iterable[InlineImage]) -> str:
    """图题变成一句话补在文本里（微信图片消息没有 caption 位）。"""
    captions = [img.caption for img in images if img.caption]
    if not captions:
        return ""
    return "（配图：" + "、".join(captions[:MAX_IMAGES_PER_REPLY]) + "）"


def load_image_bytes(url: str, tenant_id: str = "") -> Optional[tuple[bytes, str]]:
    """按 URL 取图片字节与 mime；只认本地知识库资产。

    ``tenant_id`` 给了就按租户过滤——图片 URL 是带签名的能力 URL，但发送方是
    后端自己，不该因为正文里出现别家资产 id 就读到别家的图。
    返回 None 表示这张图无法从本地取到（外链、资产已删除、格式不支持），
    调用方据此跳过——宁可少一张图，也不要发一张裂图或去抓内网地址。
    """
    match = _LOCAL_ASSET_ID_PATTERN.search(url or "")
    if match is None:
        return None
    asset_id = match.group(1)

    try:
        from sqlmodel import Session, select

        from app.db.database import engine
        from app.db.models import KnowledgeAsset
        from app.knowledge.assets import asset_file_path

        with Session(engine) as db:
            query = select(KnowledgeAsset).where(KnowledgeAsset.id == asset_id)
            if tenant_id:
                query = query.where(KnowledgeAsset.tenant_id == tenant_id)
            asset = db.exec(query).first()
            if asset is None:
                return None
            mime = str(asset.mime or "").lower()
            if mime in _UNSUPPORTED_IMAGE_MIMES or not mime.startswith(_IMAGE_MIME_PREFIX):
                return None
            path: Path = asset_file_path(asset)
            if not path.exists():
                return None
            size = path.stat().st_size
            if size <= 0 or size > MAX_IMAGE_BYTES:
                return None
            return path.read_bytes(), mime
    except Exception:  # noqa: BLE001 - 单张图取不到不能影响整轮回复
        logger.debug("微信发图：读取资产失败 url=%s", url, exc_info=True)
        return None


def _cdn_base_url() -> str:
    """CDN 基址。协议里固定为 c2c 通道，可用环境变量覆盖便于联调。"""
    configured = os.environ.get("WECHAT_CDN_BASE_URL", "").strip()
    if configured:
        return configured.rstrip("/")
    return "https://novac2c.cdn.weixin.qq.com/c2c"


def upload_image(
    client: Any,
    to_user_id: str,
    data: bytes,
    mime: str,
) -> Optional[UploadedImage]:
    """走 getuploadurl → CDN upload，返回 CDN 引用。

    ``client`` 传 ``WeChatClient``：复用它已配置好的 base_url / bot_token，
    保证鉴权头与业务请求完全一致。
    """
    aes_key = os.urandom(16)
    encrypted = aes_ecb_encrypt(data, aes_key)
    filekey = f"staffdeck_{uuid.uuid4().hex}"
    # 图片的 aes_key 编码：base64(raw 16 bytes)
    aes_key_b64 = base64.b64encode(aes_key).decode("utf-8")

    try:
        resp = client.post_raw(
            "/ilink/bot/getuploadurl",
            {
                "filekey": filekey,
                "media_type": MEDIA_TYPE_IMAGE,
                "to_user_id": to_user_id,
                "rawsize": len(data),
                "rawfilemd5": _md5_hex(data),
                "filesize": len(encrypted),
                "aeskey": aes_key_b64,
                # 不传缩略图，省一组 thumb_* 参数与一次上传
                "no_need_thumb": True,
            },
        )
    except Exception:  # noqa: BLE001
        logger.warning("微信发图：申请上传地址失败", exc_info=True)
        return None

    upload_param = str(resp.get("upload_param") or "").strip()
    if not upload_param:
        logger.warning("微信发图：getuploadurl 未返回 upload_param")
        return None

    cdn_url = f"{_cdn_base_url()}/upload"
    try:
        with httpx.Client(timeout=60.0) as http:
            put = http.post(
                cdn_url,
                params={"encrypted_query_param": upload_param, "filekey": filekey},
                content=encrypted,
                headers={"Content-Type": "application/octet-stream"},
            )
            put.raise_for_status()
            # 下载参数在响应头，不在 body
            encrypt_query_param = put.headers.get("x-encrypted-param", "").strip()
    except Exception:  # noqa: BLE001
        logger.warning("微信发图：CDN 上传失败", exc_info=True)
        return None

    if not encrypt_query_param:
        logger.warning("微信发图：CDN 未返回 x-encrypted-param")
        return None

    return UploadedImage(
        encrypt_query_param=encrypt_query_param,
        aes_key=aes_key_b64,
        size=len(data),
    )


def guess_mime(url: str) -> str:
    mime, _ = mimetypes.guess_type(url.split("?")[0])
    return (mime or "image/jpeg").lower()