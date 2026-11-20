"""微信发图链路测试：markdown 图片摘除、AES 加密、上传报文、降级行为。

覆盖用户报的「回复里的图片无法显示」：
原先正文里的 ``![图题](url)`` 被当纯文本发出去，用户看到一串标记。
现在必须摘成独立图片消息；发不出去时降级成文字说明。
"""

from __future__ import annotations

import base64

import pytest

from app.wechat import media
from app.wechat.client import ITEM_IMAGE, WeChatClient


# ---- 图片摘除 ------------------------------------------------------------


def test_extract_removes_markdown_image_from_body():
    text = "报销流程如下：\n\n![发票样例](/api/knowledge/assets/kasset_ab12?sig=abc)\n\n先上传发票。"
    body, images = media.extract_inline_images(text)

    assert "![" not in body
    assert "kasset_ab12" not in body
    assert "报销流程如下" in body
    assert "先上传发票" in body
    assert len(images) == 1
    assert images[0].url == "/api/knowledge/assets/kasset_ab12?sig=abc"
    assert images[0].caption == "发票样例"


def test_extract_handles_kasset_scheme():
    body, images = media.extract_inline_images("看图 ![配图](kasset://kasset_xyz)")
    assert body == "看图"
    assert images[0].url == "kasset://kasset_xyz"


def test_extract_plain_text_is_untouched():
    body, images = media.extract_inline_images("没有图片的一段话")
    assert body == "没有图片的一段话"
    assert images == []


def test_extract_strips_appendix_heading_and_rule():
    """兜底补图区块的标题/分隔线要跟着图一起摘掉，否则微信里是裸 markdown。"""
    text = "答案是A。\n\n---\n\n**原文档配图**\n\n![原文档配图 1](/api/knowledge/assets/kasset_a?sig=1)"
    body, images = media.extract_inline_images(text)

    assert len(images) == 1
    assert body == "答案是A。"
    assert "---" not in body
    assert "原文档配图" not in body


def test_extract_keeps_mid_text_rule():
    """正文中间的分隔线属于内容，不能误删。"""
    text = "第一部分\n\n---\n\n第二部分\n\n![图](/api/knowledge/assets/kasset_a?sig=1)"
    body, _ = media.extract_inline_images(text)
    assert "---" in body
    assert "第二部分" in body


def test_extract_caps_images_per_reply():
    text = "\n".join(
        f"![图{i}](/api/knowledge/assets/kasset_{i})"
        for i in range(media.MAX_IMAGES_PER_REPLY + 3)
    )
    body, images = media.extract_inline_images(text)

    assert len(images) == media.MAX_IMAGES_PER_REPLY
    # 超额的图片标记也必须清掉，否则 url 会以纯文本漏出去
    assert "![" not in body
    assert "kasset_" not in body


def test_caption_note_mentions_captions():
    note = media._caption_note(
        [media.InlineImage("u1", "发票样例"), media.InlineImage("u2", "流程图")]
    )
    assert "发票样例" in note
    assert "流程图" in note


# ---- AES-128-ECB --------------------------------------------------------


def test_aes_ecb_roundtrip_with_reference_impl():
    """用独立实现解回来，确认 ECB + PKCS7 正确（算法错则 CDN 直接拒绝）。"""
    import hashlib
    import hmac

    key = bytes(range(16))
    data = b"staffdeck image payload"
    encrypted = media.aes_ecb_encrypt(data, key)

    assert len(encrypted) % 16 == 0
    assert encrypted != data

    # 用同样的 key 手工解（ECB 无状态，逐块异或还原）
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    decryptor = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    padded = decryptor.update(encrypted) + decryptor.finalize()
    pad = padded[-1]
    assert padded[:-pad] == data
    assert hmac.compare_digest(hashlib.md5(data).hexdigest(), media._md5_hex(data))


def test_aes_ecb_pads_exact_block_multiple():
    key = b"0" * 16
    data = b"x" * 32  # 恰好整块，仍需补满一块
    encrypted = media.aes_ecb_encrypt(data, key)
    assert len(encrypted) == 48


def test_aes_ecb_rejects_wrong_key_length():
    with pytest.raises(ValueError):
        media.aes_ecb_encrypt(b"data", b"short")


# ---- 上传报文 -----------------------------------------------------------


class _FakeClient:
    """记录 getuploadurl 的请求体。"""

    def __init__(self, upload_param: str = "up-param") -> None:
        self.calls: list[tuple[str, dict]] = []
        self._upload_param = upload_param

    def post_raw(self, endpoint: str, body: dict, *, timeout: float = 20.0) -> dict:
        self.calls.append((endpoint, body))
        return {"upload_param": self._upload_param}


def test_upload_image_sends_required_fields(monkeypatch):
    client = _FakeClient()
    captured: list[dict] = []

    class _Resp:
        headers = {"x-encrypted-param": "dl-param"}

        def raise_for_status(self) -> None:
            return None

    class _Http:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc) -> None:
            return None

        def post(self, url, params=None, content=None, headers=None):
            captured.append({"url": url, "params": params, "content": content, "headers": headers})
            return _Resp()

    monkeypatch.setattr(media.httpx, "Client", _Http)

    data = b"fake-png-bytes"
    result = media.upload_image(client, "user@im.wechat", data, "image/png")

    assert result is not None
    assert result.encrypt_query_param == "dl-param"

    endpoint, body = client.calls[0]
    assert endpoint == "/ilink/bot/getuploadurl"
    assert body["media_type"] == media.MEDIA_TYPE_IMAGE
    assert body["to_user_id"] == "user@im.wechat"
    assert body["rawsize"] == len(data)
    assert body["filesize"] == len(media.aes_ecb_encrypt(data, bytes.fromhex(body["aeskey"])))
    assert body["no_need_thumb"] is True
    # getuploadurl.aeskey 必须是 hex 字符串（32 字符），不是 base64
    assert len(body["aeskey"]) == 32
    assert bytes.fromhex(body["aeskey"])

    # CDN 上传：加密后的字节，不是明文
    assert captured[0]["content"] == media.aes_ecb_encrypt(
        data, bytes.fromhex(body["aeskey"])
    )
    assert captured[0]["params"]["encrypted_query_param"] == "up-param"


def test_upload_image_returns_media_aes_key_as_base64_of_hex(monkeypatch):
    """CDNMedia.aes_key 要 base64(hex 字符串)，解出来必须是 32 字节 hex 文本。

    写成 base64(raw 16B) 不报错，只在客户端表现为灰框——真机复现过一次。
    """
    client = _FakeClient()

    class _Resp:
        headers = {"x-encrypted-param": "dl-param"}

        def raise_for_status(self) -> None:
            return None

    class _Http:
        def __init__(self, *a, **k) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *e) -> None:
            return None

        def post(self, *a, **k):
            return _Resp()

    monkeypatch.setattr(media.httpx, "Client", _Http)

    data = b"x" * 100
    result = media.upload_image(client, "u", data, "image/png")
    assert result is not None

    decoded = base64.b64decode(result.aes_key)
    assert len(decoded) == 32, "客户端按 32 字节 hex 文本解；长度 16 就是灰框"
    raw_key = bytes.fromhex(decoded.decode("ascii"))
    assert len(raw_key) == 16
    # 同一把密钥：上传接口用 hex，消息里用 base64(hex)
    assert client.calls[0][1]["aeskey"] == raw_key.hex()
    # mid_size 用密文长度
    assert result.encrypted_size == len(media.aes_ecb_encrypt(data, raw_key))


def test_upload_image_returns_none_without_upload_param(monkeypatch):
    client = _FakeClient(upload_param="")
    assert media.upload_image(client, "u", b"x", "image/png") is None


def test_upload_image_uses_upload_full_url_when_given(monkeypatch):
    """新版接口可能只给 upload_full_url；此时不能再拼 base 地址。"""
    seen: list[str] = []

    class _FullUrlClient:
        def post_raw(self, endpoint, body, *, timeout=20.0):
            return {"upload_full_url": "https://cdn.example.com/upload?token=t"}

    class _Resp:
        headers = {"x-encrypted-param": "dl"}

        def raise_for_status(self) -> None:
            return None

    class _Http:
        def __init__(self, *a, **k) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *e) -> None:
            return None

        def post(self, url, params=None, content=None, headers=None):
            seen.append(url)
            assert params is None, "已有完整 URL 就不该再拼 query"
            return _Resp()

    monkeypatch.setattr(media.httpx, "Client", _Http)
    result = media.upload_image(_FullUrlClient(), "u", b"img", "image/png")
    assert result is not None
    assert seen == ["https://cdn.example.com/upload?token=t"]


# ---- 大图压缩 ------------------------------------------------------------


def test_shrink_leaves_small_image_untouched():
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (32, 32), "red").save(buffer, "PNG")
    data = buffer.getvalue()
    assert media.shrink_for_upload(data) is data


def test_shrink_brings_large_image_under_target():
    """1MB+ 截图必须压到目标以内，否则 CDN 上传大概率失败。"""
    import os
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.frombytes("RGB", (2000, 1400), os.urandom(2000 * 1400 * 3)).save(
        buffer, "PNG"
    )
    data = buffer.getvalue()
    assert len(data) > media.UPLOAD_TARGET_BYTES

    shrunk = media.shrink_for_upload(data)
    assert len(shrunk) <= media.UPLOAD_TARGET_BYTES
    # 压缩结果必须仍是能打开的 JPEG
    out = Image.open(BytesIO(shrunk))
    assert out.format == "JPEG"
    assert max(out.size) <= media._COMPRESS_STEPS[0][0]


def test_shrink_returns_original_on_undecodable_bytes():
    """损坏/非图片字节不能抛异常——发图失败已降级，压缩不该再添一层崩。"""
    junk = b"\x00" * (media.UPLOAD_TARGET_BYTES + 1)
    assert media.shrink_for_upload(junk) is junk


def test_upload_image_returns_none_without_cdn_header(monkeypatch):
    client = _FakeClient()

    class _Resp:
        headers: dict = {}

        def raise_for_status(self) -> None:
            return None

    class _Http:
        def __init__(self, *a, **k) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *e) -> None:
            return None

        def post(self, *a, **k):
            return _Resp()

    monkeypatch.setattr(media.httpx, "Client", _Http)
    assert media.upload_image(client, "u", b"x", "image/png") is None


# ---- 发送报文 -----------------------------------------------------------


def test_send_image_builds_image_item_with_media_field():
    """image_item 的字段名必须是 media（协议不是 cdn_media）。"""
    sent: list[dict] = []

    class _Client(WeChatClient):
        def _post(self, endpoint: str, body: dict, *, timeout: float = 20.0) -> dict:
            sent.append(body)
            return {}

    client = _Client(bot_token="t")
    client.send_image("u@im.wechat", "ctx", "dl-param", "a2V5", mid_size=48)

    item = sent[0]["msg"]["item_list"][0]
    assert item["type"] == ITEM_IMAGE
    assert "image_item" in item
    media_info = item["image_item"]["media"]
    assert media_info["encrypt_query_param"] == "dl-param"
    assert media_info["aes_key"] == "a2V5"
    # encrypt_type=1 表示 AES-128-ECB；缺了客户端不知道用什么解
    assert media_info["encrypt_type"] == 1
    # mid_size 是密文字节数，微信据此在解密前占位
    assert item["image_item"]["mid_size"] == 48
    # 外层必填字段一个都不能少（缺则静默丢弃）
    msg = sent[0]["msg"]
    assert msg["from_user_id"] == ""
    assert msg["message_type"] == 2
    assert msg["message_state"] == 2
    assert msg["context_token"] == "ctx"


def test_send_image_omits_mid_size_when_unknown():
    sent: list[dict] = []

    class _Client(WeChatClient):
        def _post(self, endpoint: str, body: dict, *, timeout: float = 20.0) -> dict:
            sent.append(body)
            return {}

    _Client(bot_token="t").send_image("u", "ctx", "p", "k")
    assert "mid_size" not in sent[0]["msg"]["item_list"][0]["image_item"]


# ---- 降级 ---------------------------------------------------------------


def test_load_image_bytes_skips_svg():
    """微信不认矢量图，必须跳过而不是发一张裂图。"""
    assert media.load_image_bytes("/api/knowledge/assets/kasset_x?sig=1") is None


def test_load_image_bytes_ignores_external_url():
    assert media.load_image_bytes("https://example.com/a.png") is None


def test_caption_note_empty_when_no_captions():
    assert media._caption_note([media.InlineImage("u1", "")]) == ""

# ---- send_reply 集成 ----------------------------------------------------


class _RecordingClient:
    """记录文本与图片发送，用于验证 send_reply 的分支行为。"""

    def __init__(self) -> None:
        self.texts: list[str] = []
        self.images: list[tuple[str, str]] = []

    def send_text_chunked(self, to_user_id, context_token, text, *, client_id="", **kw):
        self.texts.append(text)
        return 1

    def send_image(self, to_user_id, context_token, param, key, *, client_id="", **kw):
        self.images.append((param, key))

    def post_raw(self, endpoint, body, *, timeout=20.0):
        return {"upload_param": "up"}


def _binding():
    class _B:
        id = "bind-1"
        tenant_id = "tenant_demo"

    return _B()


def test_send_reply_sends_image_then_text(monkeypatch):
    from app.wechat import service

    client = _RecordingClient()
    monkeypatch.setattr(media, "load_image_bytes", lambda url, tenant_id="": (b"png", "image/png"))
    monkeypatch.setattr(
        media, "upload_image",
        lambda c, u, d, m: media.UploadedImage("dl", "a2V5", len(d), len(d)),
    )

    service.send_reply(
        client, _binding(), "u@im.wechat", "ctx",
        "看这张图：\n\n![发票](/api/knowledge/assets/kasset_1?sig=x)\n\n以上就是流程。",
    )

    assert len(client.images) == 1
    assert client.images[0] == ("dl", "a2V5")
    joined = "\n".join(client.texts)
    # 正文里不能再残留 markdown 图片标记
    assert "![" not in joined
    assert "kasset_1" not in joined
    assert "以上就是流程" in joined


def test_send_reply_falls_back_when_images_unavailable(monkeypatch):
    from app.wechat import service

    client = _RecordingClient()
    # 本地取不到图 → 一张也发不出去
    monkeypatch.setattr(media, "load_image_bytes", lambda url, tenant_id="": None)

    service.send_reply(
        client, _binding(), "u@im.wechat", "ctx",
        "看这张图：\n\n![发票](/api/knowledge/assets/kasset_1?sig=x)",
    )

    assert client.images == []
    joined = "\n".join(client.texts)
    assert "![" not in joined
    # 必须明确告诉用户图没发出去，而不是悄悄少一截
    assert "无法在微信中显示" in joined


def test_send_reply_plain_text_unchanged(monkeypatch):
    from app.wechat import service

    client = _RecordingClient()
    service.send_reply(client, _binding(), "u@im.wechat", "ctx", "纯文本回复")

    assert client.images == []
    assert client.texts == ["纯文本回复"]


def test_send_reply_attribution_prefix_kept(monkeypatch):
    from app.wechat import service

    client = _RecordingClient()
    service.send_reply(
        client, _binding(), "u@im.wechat", "ctx", "回复内容", attribution="客服小李"
    )
    assert client.texts[0].startswith("【客服小李】")
