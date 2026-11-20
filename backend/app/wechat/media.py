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
  ``{encrypt_query_param, aes_key, encrypt_type}``，另需 ``mid_size`` = 密文字节数。
- **aes_key 有双编码，写错就是「发出去了但显示灰框」**（2026-11-20 真机复现）：
  ``getuploadurl.aeskey`` 要 **hex 字符串**（32 字符），而
  ``CDNMedia.aes_key`` 要 **base64(hex 字符串)**（44 字符），都不是 base64(raw 16B)。
  客户端解码链是 ``b64decode → 32 个 ASCII hex → fromhex() → 16 字节密钥``；
  给 base64(raw) 时解出来是 16 字节非 hex 文本，取不到密钥 → AES 解密失败 → 灰框。
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

#: 上传前压缩的目标上限。CDN 直连对大图不稳（实测几百 KB 以上就开始偶发失败），
#: 而知识库截图动辄 1~3MB。压到 400KB 以内既不糊字，又能稳住投递率。
UPLOAD_TARGET_BYTES = 400 * 1024

#: 压缩时依次尝试的缩放边长与 JPEG 质量；命中第一条就停。
_COMPRESS_STEPS = ((1600, 82), (1280, 78), (960, 72), (720, 66))

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
    #: 密文字节数，供 image_item.mid_size 使用（微信据此在解密前分配展示位）。
    encrypted_size: int = 0


def aes_ecb_encrypt(data: bytes, key: bytes) -> bytes:
    """AES-128-ECB + PKCS7。iLink CDN 的固定加密方式。"""
    if len(key) != 16:
        raise ValueError("AES-128 key 必须是 16 字节")
    pad = 16 - len(data) % 16
    padded = data + bytes([pad]) * pad
    encryptor = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return encryptor.update(padded) + encryptor.finalize()


def aes_key_hex(key: bytes) -> str:
    """getuploadurl.aeskey 的格式：32 个十六进制字符。"""
    return key.hex()


def aes_key_for_media(key: bytes) -> str:
    """``CDNMedia.aes_key`` 的格式：**base64(hex 字符串)**，不是 base64(原始字节)。

    这是最容易写错的一处：两种写法外层看起来都是 base64，接收端按「解码后是否
    为 32 字节 hex 文本」判断，用错了不会报错，只会得到一张打不开的灰框图。
    """
    return base64.b64encode(key.hex().encode("ascii")).decode("ascii")


def _md5_hex(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


#: 兜底补图区块的标题（见 knowledge/image_refs.build_image_appendix）。
#: 图被摘成独立消息后，这行标题在微信里只会显示裸 markdown，必须一起去掉。
IMAGE_APPENDIX_HEADING = "**原文档配图**"
_HEADING_LINE_PATTERN = re.compile(r"^\s*" + re.escape(IMAGE_APPENDIX_HEADING) + r"\s*$")


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
    if images:
        cleaned = _strip_appendix_leftovers(cleaned)
    return cleaned, images


def _strip_appendix_leftovers(text: str) -> str:
    """去掉只为图片服务的标题与分隔线。

    ``build_image_appendix`` 产出的是 ``---\\n\\n**原文档配图**\\n\\n![](url)``。
    图被摘走后标题和分隔线还在，微信纯文本里就会看到 ``---`` 和
    ``**原文档配图**`` 这种裸标记——图没了，噪声还在。
    只删「末尾连续的空行/分隔线/标题行」，正文中间正常的 ``---`` 不动。
    """
    lines = text.split("\n")
    while lines:
        tail = lines[-1].strip()
        if not tail or tail == "---" or _HEADING_LINE_PATTERN.match(tail):
            lines.pop()
            continue
        break
    return "\n".join(lines).strip()


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
    # 两处 aes 编码不同，别合并：
    # - getuploadurl.aeskey → hex 字符串（32 字符）
    # - sendmessage.media.aes_key → base64(hex 字符串)（44 字符）
    upload_aes_key = aes_key_hex(aes_key)
    media_aes_key = aes_key_for_media(aes_key)

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
                "aeskey": upload_aes_key,
                # 不传缩略图，省一组 thumb_* 参数与一次上传
                "no_need_thumb": True,
            },
        )
    except Exception:  # noqa: BLE001
        logger.warning("微信发图：申请上传地址失败", exc_info=True)
        return None

    upload_param = str(resp.get("upload_param") or "").strip()
    upload_full_url = str(resp.get("upload_full_url") or "").strip()
    if not upload_param and not upload_full_url:
        # 业务层错误（session 过期 / 参数错）也是 200，必须把响应打出来
        logger.warning("微信发图：getuploadurl 未返回上传地址 resp=%s", resp)
        return None

    cdn_url = upload_full_url or f"{_cdn_base_url()}/upload"
    params = (
        None if upload_full_url
        else {"encrypted_query_param": upload_param, "filekey": filekey}
    )
    try:
        with httpx.Client(timeout=60.0) as http:
            # CDN 只认 POST（PUT 会 404）
            put = http.post(
                cdn_url,
                params=params,
                content=encrypted,
                headers={"Content-Type": "application/octet-stream"},
            )
            put.raise_for_status()
            # 下载参数在响应头，不在 body；URL 里那个是上传凭证，不是下载凭证
            encrypt_query_param = put.headers.get("x-encrypted-param", "").strip()
    except Exception:  # noqa: BLE001
        logger.warning("微信发图：CDN 上传失败", exc_info=True)
        return None

    if not encrypt_query_param:
        logger.warning("微信发图：CDN 未返回 x-encrypted-param")
        return None

    return UploadedImage(
        encrypt_query_param=encrypt_query_param,
        aes_key=media_aes_key,
        size=len(data),
        encrypted_size=len(encrypted),
    )


def guess_mime(url: str) -> str:
    mime, _ = mimetypes.guess_type(url.split("?")[0])
    return (mime or "image/jpeg").lower()


def shrink_for_upload(data: bytes) -> bytes:
    """把大图压到 ``UPLOAD_TARGET_BYTES`` 以内；压不动就原样返回。

    为什么必须做：iLink CDN 直连对体积敏感，几百 KB 以上失败率明显上升，而知识库
    里的截图常常 1~3MB。原图发不出去等于没修——用户看到的还是「配图无法显示」。

    只重编码不改语义：保留 EXIF 方向（``exif_transpose``），带透明通道的图转白底
    （微信不支持透明），动图/无法解析的一律原样返回，宁可原图碰运气也不丢图。
    """
    if len(data) <= UPLOAD_TARGET_BYTES:
        return data
    try:
        import io

        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(data)) as image:
            if getattr(image, "is_animated", False):
                return data
            image = ImageOps.exif_transpose(image)
            if image.mode in ("RGBA", "LA", "P"):
                image = image.convert("RGBA")
                background = Image.new("RGB", image.size, (255, 255, 255))
                background.paste(image, mask=image.split()[-1])
                image = background
            elif image.mode != "RGB":
                image = image.convert("RGB")

            for longest, quality in _COMPRESS_STEPS:
                candidate = image.copy()
                candidate.thumbnail((longest, longest), Image.LANCZOS)
                buffer = io.BytesIO()
                candidate.save(buffer, format="JPEG", quality=quality, optimize=True)
                encoded = buffer.getvalue()
                if len(encoded) <= UPLOAD_TARGET_BYTES:
                    return encoded
            return encoded
    except Exception:  # noqa: BLE001 - 压缩失败不该阻断发送，退回原图
        logger.debug("微信发图：压缩失败，改用原图", exc_info=True)
        return data