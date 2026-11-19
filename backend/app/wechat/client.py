"""腾讯 iLink 协议 HTTP 客户端。

协议事实（逆向确认，务必保留这些细节）：

- 基址 ``https://ilinkai.weixin.qq.com``，全部 POST JSON；认证用
  ``Authorization: Bearer <bot_token>`` + ``AuthorizationType: ilink_bot_token``
  + 每次随机生成的 ``X-WECHAT-UIN``。
- ``sendmessage`` **无论是成功还是被丢弃都返回 200 + 空 body**。缺任何一个
  ``from_user_id / client_id / message_type / message_state / context_token /
  base_info`` 字段，消息都会被服务端静默丢弃。这是本模块最容易回归的地方，
  ``_build_text_message`` 因此集中构造，测试直接断言字段完整性。
- ``getupdates`` 是长轮询（服务端 hold 约 35s），返回的 ``get_updates_buf``
  是增量游标，必须持久化续用，否则重连会重放旧消息。
- ``context_token`` 来自入站消息，可长期复用（不只是本轮），但用户新消息会刷新它。
- 该协议**没有**卡片 / 按钮 / 模板消息接口，SendMessage 只支持
  text/image/voice/file/video 五种 item。所以微信侧做不了真按钮菜单，
  员工切换只能靠文本（斜杠指令 + 编号回复）。
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
import uuid
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

CHANNEL_VERSION = "1.0.3"
TEXT_ITEM_TYPE = 1
MESSAGE_TYPE_BOT = 2
# message_state: 0=新建 1=生成中 2=完成。当前发送一律用「完成」；
# 1 预留给将来的流式增量（见 docs 里的真机验证项）。
MESSAGE_STATE_FINISH = 2
MESSAGE_STATE_GENERATING = 1

WECHAT_TEXT_LIMIT = 2000
GETUPDATES_TIMEOUT_SECONDS = 40.0
QRCODE_STATUS_TIMEOUT_SECONDS = 35.0

# 腾讯官方接入域名：业务请求携带 bot_token，redirect/baseurl 必须限制在官方域内
ALLOWED_HOSTS = ("ilinkai.weixin.qq.com", "weixin.qq.com")

# item_list 的 type 取值
ITEM_TEXT = 1
ITEM_IMAGE = 2


class WeChatApiError(RuntimeError):
    def __init__(self, code: int, message: str = "") -> None:
        self.code = code
        self.message = message
        super().__init__(f"iLink error {code}: {message}")


def validate_host(hostname: str) -> bool:
    host = (hostname or "").lower()
    return any(host == allowed or host.endswith("." + allowed) for allowed in ALLOWED_HOSTS)


def sanitize_base_url(value: str, default: str = "") -> str:
    """把 baseurl 钳制回官方域，防止凭证被引到第三方地址。"""
    fallback = default or get_settings().wechat_ilink_base_url
    raw = (value or "").strip()
    if not raw:
        return fallback.rstrip("/")
    parsed = urlparse(raw)
    if parsed.scheme != "https" or not validate_host(parsed.hostname or ""):
        logger.warning("拒绝非官方 iLink 基址，回退默认: %s", raw)
        return fallback.rstrip("/")
    return raw.rstrip("/")


def random_uin() -> str:
    """X-WECHAT-UIN：随机 uint32 的十进制字符串再 base64，每次请求重新生成（防重放）。"""
    value = int.from_bytes(os.urandom(4), "big")
    return base64.b64encode(str(value).encode("utf-8")).decode("utf-8")


def split_text(text: str, limit: int = WECHAT_TEXT_LIMIT) -> list[str]:
    """按 2000 字上限拆分，优先段落/换行/空格边界，找不到则硬切。

    微信单条文本上限 2000 字符，超长必须拆多条；直接截断会丢内容。
    """
    if not text:
        return []
    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        window = remaining[:limit]
        cut = -1
        for sep in ("\n\n", "\n", " "):
            cut = window.rfind(sep)
            if cut > 0:
                break
        if cut <= 0:
            chunks.append(remaining[:limit])
            remaining = remaining[limit:]
            continue
        chunk = remaining[:cut].rstrip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[cut:].lstrip("\n ")
    if remaining:
        chunks.append(remaining)
    return chunks


class WeChatClient:
    """单个 bot 账号的 iLink 客户端。线程安全（httpx.Client 本身线程安全）。"""

    def __init__(
        self,
        base_url: str = "",
        bot_token: str = "",
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 20.0,
    ) -> None:
        self.base_url = sanitize_base_url(base_url)
        self.bot_token = bot_token
        self._client = httpx.Client(transport=transport, timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> WeChatClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ---- 请求构造 ------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "X-WECHAT-UIN": random_uin(),
        }
        # 空 token 不能拼成 "Bearer "（非法请求头）；让它变成明确的鉴权错误
        if self.bot_token:
            headers["Authorization"] = f"Bearer {self.bot_token}"
        return headers

    @staticmethod
    def _base_info() -> dict[str, str]:
        return {"channel_version": CHANNEL_VERSION}

    def _post(self, endpoint: str, body: dict[str, Any], *, timeout: float = 20.0) -> dict[str, Any]:
        payload = dict(body)
        payload["base_info"] = self._base_info()
        # Content-Length 必须精确（按 UTF-8 字节算），否则偶发超时
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = self._headers()
        headers["Content-Length"] = str(len(raw))
        resp = self._client.post(
            f"{self.base_url}{endpoint}",
            content=raw,
            headers=headers,
            timeout=timeout,
        )
        resp.raise_for_status()
        if not resp.content:
            return {}
        try:
            data = json.loads(resp.content)
        except ValueError as exc:
            raise WeChatApiError(-1, "响应不是合法 JSON") from exc
        if not isinstance(data, dict):
            return {}
        errcode = int(data.get("errcode") or data.get("ret") or 0)
        if errcode:
            raise WeChatApiError(errcode, str(data.get("errmsg") or ""))
        return data

    def post_raw(self, endpoint: str, body: dict[str, Any], *, timeout: float = 20.0) -> dict[str, Any]:
        """与 ``_post`` 相同，但公开给媒体上传等外部逻辑复用鉴权头。

        分装一层是为了让 ``media.upload_image`` 不必重复实现 base_info /
        Content-Length / X-WECHAT-UIN 这些容易写错的协议细节。
        """
        return self._post(endpoint, body, timeout=timeout)

    # ---- 扫码登录 ------------------------------------------------------

    def get_bot_qrcode(self, local_tokens: list[str] | None = None) -> dict[str, Any]:
        """获取登录二维码。返回 ``qrcode`` / ``qrcode_img_content``。"""
        resp = self._client.post(
            f"{self.base_url}/ilink/bot/get_bot_qrcode",
            params={"bot_type": 3},
            # 最多 10 个已登录 token，用于同一微信重复扫码时恢复而非新建
            json={"local_token_list": list(local_tokens or [])[:10]},
            timeout=20.0,
        )
        resp.raise_for_status()
        return dict(resp.json() or {})

    def get_qrcode_status(self, qrcode: str, *, verify_code: str = "") -> dict[str, Any]:
        """轮询扫码状态：wait / scaned / confirmed / expired / cancelled。

        长轮询语义，服务端 hold 到状态变化才返回，所以客户端超时要略大于
        服务端 hold 时间，否则会把「正常等待」误判成失败。
        """
        params: dict[str, str] = {"qrcode": qrcode}
        if verify_code:
            params["verify_code"] = verify_code
        resp = self._client.get(
            f"{self.base_url}/ilink/bot/get_qrcode_status",
            params=params,
            headers={"iLink-App-ClientVersion": "1"},
            timeout=QRCODE_STATUS_TIMEOUT_SECONDS + 5.0,
        )
        resp.raise_for_status()
        return dict(resp.json() or {})

    # ---- 收消息 --------------------------------------------------------

    def get_updates(self, cursor: str = "", *, timeout_seconds: float = GETUPDATES_TIMEOUT_SECONDS) -> dict[str, Any]:
        """长轮询拉取新消息。返回 ``msgs`` 与新的 ``get_updates_buf``。"""
        return self._post(
            "/ilink/bot/getupdates",
            {"get_updates_buf": cursor or ""},
            timeout=timeout_seconds + 5.0,
        )

    # ---- 发消息 --------------------------------------------------------

    def _build_text_message(
        self,
        to_user_id: str,
        context_token: str,
        text: str,
        *,
        client_id: str = "",
        state: int = MESSAGE_STATE_FINISH,
        typing_ticket: str = "",
    ) -> dict[str, Any]:
        """集中构造 sendmessage 报文。

        这些字段一个都不能少（缺则 200 但静默丢弃）：
        from_user_id=""、client_id、message_type=2、message_state、context_token。
        client_id 传固定值即可获得幂等重试语义（同一 id 服务端去重）。
        """
        return self._build_message(
            to_user_id,
            context_token,
            [{"type": ITEM_TEXT, "text_item": {"text": text}}],
            client_id=client_id,
            state=state,
            typing_ticket=typing_ticket,
        )

    def _build_message(
        self,
        to_user_id: str,
        context_token: str,
        item_list: list[dict[str, Any]],
        *,
        client_id: str = "",
        state: int = MESSAGE_STATE_FINISH,
        typing_ticket: str = "",
    ) -> dict[str, Any]:
        """文本与图片共用同一套外层字段，避免两处各写一份再次踩坑。"""
        msg: dict[str, Any] = {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": client_id or f"staffdeck:{int(time.time() * 1000)}:{uuid.uuid4().hex[:8]}",
            "message_type": MESSAGE_TYPE_BOT,
            "message_state": state,
            "context_token": context_token,
            "item_list": item_list,
        }
        if typing_ticket:
            msg["typing_ticket"] = typing_ticket
        return {"msg": msg}

    def send_text(
        self,
        to_user_id: str,
        context_token: str,
        text: str,
        *,
        client_id: str = "",
        typing_ticket: str = "",
    ) -> None:
        if not text:
            return
        self._post(
            "/ilink/bot/sendmessage",
            self._build_text_message(
                to_user_id,
                context_token,
                text,
                client_id=client_id,
                typing_ticket=typing_ticket,
            ),
            timeout=20.0,
        )

    def send_text_chunked(
        self,
        to_user_id: str,
        context_token: str,
        text: str,
        *,
        client_id: str = "",
        typing_ticket: str = "",
    ) -> int:
        """按 2000 字拆多条发送，返回实际发送条数。

        同一条回复的多个分片共享同一个 client_id，服务端按 id 去重，
        重试时不会重复投递整段内容。
        """
        chunks = split_text(text)
        for index, chunk in enumerate(chunks):
            cid = f"{client_id}:{index}" if client_id else ""
            self.send_text(
                to_user_id,
                context_token,
                chunk,
                client_id=cid,
                typing_ticket=typing_ticket,
            )
        return len(chunks)

    def send_image(
        self,
        to_user_id: str,
        context_token: str,
        encrypt_query_param: str,
        aes_key: str,
        *,
        client_id: str = "",
        typing_ticket: str = "",
    ) -> None:
        """发送一条图片消息。

        ``image_item`` 的 CDN 引用字段名是 ``media``（协议里不是 ``cdn_media``）；
        ``aes_key`` 用 base64(raw 16 bytes)。字段写错的后果同样是
        ``200 + 空 body`` 的静默丢弃，所以这里集中构造并配测试。
        """
        item = {
            "type": ITEM_IMAGE,
            "image_item": {
                "media": {
                    "encrypt_query_param": encrypt_query_param,
                    "aes_key": aes_key,
                }
            },
        }
        self._post(
            "/ilink/bot/sendmessage",
            self._build_message(
                to_user_id,
                context_token,
                [item],
                client_id=client_id,
                typing_ticket=typing_ticket,
            ),
            timeout=30.0,
        )

    # ---- typing（"正在输入"）------------------------------------------

    def get_config(self, ilink_user_id: str, context_token: str = "") -> dict[str, Any]:
        return self._post(
            "/ilink/bot/getconfig",
            {"ilink_user_id": ilink_user_id, "context_token": context_token},
            timeout=15.0,
        )

    def send_typing(self, ilink_user_id: str, typing_ticket: str, status: int = 1) -> None:
        """status: 1=正在输入 2=取消输入。失败只记日志，不能阻塞主链路。"""
        if not typing_ticket:
            return
        try:
            self._post(
                "/ilink/bot/sendtyping",
                {
                    "ilink_user_id": ilink_user_id,
                    "typing_ticket": typing_ticket,
                    "status": status,
                },
                timeout=15.0,
            )
        except (httpx.HTTPError, WeChatApiError):
            logger.debug("微信 typing 状态发送失败（忽略） status=%s", status, exc_info=True)


def normalize_inbound_message(raw: dict[str, Any]) -> dict[str, Any] | None:
    """把 getupdates 的原始消息归一化成内部结构；无文本内容返回 None。

    iLink 的 item_list 里可能混有非文本 item（图片/文件），本版本只取文本；
    带附件但无文本的消息按「暂不支持」处理，避免进 AgentLoop 后空转一轮。
    """
    if not isinstance(raw, dict):
        return None
    from_user = str(raw.get("from_user_id") or "").strip()
    if not from_user:
        return None
    texts: list[str] = []
    for item in raw.get("item_list") or []:
        if not isinstance(item, dict):
            continue
        if int(item.get("type") or 0) == ITEM_TEXT:
            text_item = item.get("text_item") or {}
            value = str(text_item.get("text") or "")
            if value:
                texts.append(value)
    text = "\n".join(texts).strip()
    if not text:
        return None
    context_token = str(raw.get("context_token") or "").strip()
    # 事件 id 用于幂等：协议未给 message id 时用 会话+时间戳+内容摘要 兜底
    event_id = str(raw.get("msg_id") or raw.get("message_id") or "").strip()
    if not event_id:
        event_id = _fallback_event_id(raw, from_user, text)
    return {
        "event_id": event_id,
        "from_user_id": from_user,
        "context_token": context_token,
        "text": text,
        "raw": raw,
    }


def _fallback_event_id(raw: dict[str, Any], from_user: str, text: str) -> str:
    import hashlib

    created = str(raw.get("create_time") or raw.get("timestamp") or raw.get("ts") or "")
    digest = hashlib.sha256(f"{created}:{text}".encode("utf-8")).hexdigest()[:16]
    return f"{from_user}:{digest}"