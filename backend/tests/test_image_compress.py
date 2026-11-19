"""图片上传压缩：把「4~12MB 静默丢视觉」修成可用。

## 要锁住的缺陷

上传上限 ``MAX_CHAT_ATTACHMENT_BYTES`` = 12MB，但图片转 data URL 的上限
``IMAGE_DATA_URL_LIMIT_BYTES`` = 4MB。``_image_attachment`` 超过 4MB 就把
``data_url`` 置为 ``None``。于是 4~12MB 的图：上传成功、缩略图正常、
``image_payloads_from_attachments`` 却因 ``not data_url`` 整条跳过 ——
**模型完全看不见，用户以为传上去了**。

## 第二个要锁的约束

``stage_chat_attachment`` 用传入的 bytes 算 sha256 并落盘，
``validate_chat_turn_attachments`` 又要求 ``sha256(data_url 解出的 bytes)``
与之相等。压缩后若三者不同源，turn 发送时直接抛
「图片 data URL 与上传文件不一致」。所以 ``parse_chat_attachment_with_bytes``
必须返回**压缩后的**那份 bytes。
"""

from __future__ import annotations

import base64
import hashlib
import io
import os

from app.session.attachments import (
    IMAGE_DATA_URL_LIMIT_BYTES,
    parse_chat_attachment,
    parse_chat_attachment_with_bytes,
)
from app.session.image_compress import (
    MAX_EDGE,
    TARGET_BYTES,
    compress_image_for_upload,
)

# 4MB 与 5MB 之间：一定超过 data_url 上限，但远低于 12MB 上传上限。
# 用随机噪声保证 PNG 压不动，从而稳定落在这个区间。
_OVERSIZE_BYTES = 4_600_000


def _noise_png(width: int = 1300, height: int = 1200) -> bytes:
    """随机噪声 PNG：压缩率极低，体积约等于原始像素数。"""

    from PIL import Image

    image = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _screenshot_like_png(width: int = 1400, height: int = 900) -> bytes:
    """白底 + 大量细线条 + 轻微噪点，模拟「真实截图」。

    为什么加噪点：纯白底 + 规则矩形是 PNG 的最优场景，压出来只有几十 KB，
    构造不出「需要压缩」的用例。真实截图有抗锯齿、字体 hinting、渐变阴影，
    体积远大于 1MB。这里用稀疏噪点近似那个熵水平，同时保持颜色数很少
    （仍是 PNG 友好型，用来验证「截图不转 JPEG」）。
    """

    from PIL import Image, ImageDraw

    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    for y in range(20, height - 20, 18):
        draw.rectangle([30, y, 30 + (y * 11) % (width - 80), y + 8], fill=(24, 24, 24))
    # 稀疏噪点抬高熵，模拟抗锯齿/字体渲染的视觉噪声
    noise = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
    image = Image.blend(image, noise, 0.055)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_oversize_image_keeps_vision_available() -> None:
    """核心回归：4~12MB 的图压缩后必须拿到 data_url。

    改动前这条断言必然失败（data_url 为 None，视觉静默丢失）。
    """

    data = _noise_png()
    assert len(data) > IMAGE_DATA_URL_LIMIT_BYTES, (
        f"测试前置条件：需要一张超 4MB 的图，实际 {len(data)} bytes"
    )

    attachment = parse_chat_attachment("shot.png", "image/png", data, extract_text=False)

    assert attachment.data_url is not None, (
        "超过 4MB 的图片应当被压缩后保留 data_url，否则模型看不见图"
    )
    decoded = base64.b64decode(attachment.data_url.split(",", 1)[1])
    assert len(decoded) <= IMAGE_DATA_URL_LIMIT_BYTES
    assert len(decoded) == attachment.size


def test_compressed_bytes_are_the_persisted_ones() -> None:
    """落盘 bytes 必须与 data_url 解出的 bytes 同源，否则 turn 回程校验会炸。"""

    data = _noise_png()
    attachment, payload_bytes = parse_chat_attachment_with_bytes(
        "shot.png", "image/png", data, extract_text=False
    )

    assert attachment.data_url is not None
    decoded = base64.b64decode(attachment.data_url.split(",", 1)[1])

    assert payload_bytes == decoded, "返回的 bytes 必须就是 data_url 里那份"
    assert len(payload_bytes) == attachment.size
    assert hashlib.sha256(payload_bytes).hexdigest() == hashlib.sha256(decoded).hexdigest()
    # 压缩确实发生了
    assert len(payload_bytes) < len(data)


def test_small_image_is_not_touched() -> None:
    """小图不值得压：省掉解码开销，也避免无谓的画质损失。"""

    # 用更小的尺寸保证落在 NO_COMPRESS_BELOW_BYTES 之下
    data = _screenshot_like_png(width=520, height=320)
    assert len(data) < 1_000_000, f"前置条件：需要小图，实际 {len(data)} bytes"

    result = compress_image_for_upload(data, "image/png")

    assert result.changed is False
    assert result.data is data, "未压缩时应原样返回同一个对象"


def test_small_png_stays_png_when_it_fits() -> None:
    """PNG 装得下就用 PNG（无损）：不该无谓地转 JPEG 丢质量。

    注意这是「装得下」的场景。真实大截图即使缩到 2560，PNG 仍有 6MB 以上
    （实测），必然落到 JPEG —— 那是格式物理限制，不是策略问题。
    """

    from PIL import Image, ImageDraw

    # 低噪点 + 大量线条：体积上到 1MB 以上，但 PNG 仍能压进 TARGET_BYTES
    image = Image.new("RGB", (2400, 1500), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    for y in range(20, 1480, 22):
        draw.rectangle([30, y, 30 + (y * 7) % 2300, y + 9], fill=(20, 20, 20))
    noise = Image.frombytes("RGB", (2400, 1500), os.urandom(2400 * 1500 * 3))
    image = Image.blend(image, noise, 0.010)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    data = buffer.getvalue()
    assert len(data) > 1_000_000, f"前置条件：需要进压缩流程，实际 {len(data)} bytes"

    result = compress_image_for_upload(data, "image/png")

    assert result.changed is True
    assert result.content_type == "image/png", "PNG 装得下就该保留无损格式"


def test_oversize_screenshot_falls_back_to_jpeg() -> None:
    """真实大截图必须转 JPEG —— PNG 无损压不进 4MB（实测 6.1MB）。

    这条锁住的是「不要为了保持 PNG 而放弃视觉能力」：宁可转格式，也不能让
    data_url 变成 None。
    """

    data = _screenshot_like_png(width=3000, height=2000)
    assert len(data) > 1_000_000, f"前置条件：需要大截图，实际 {len(data)} bytes"

    result = compress_image_for_upload(data, "image/png")

    assert result.changed is True
    assert result.content_type == "image/jpeg", "大截图 PNG 压不进上限，必须转 JPEG"
    assert len(result.data) <= TARGET_BYTES


def test_long_edge_is_capped() -> None:
    """长边超过 MAX_EDGE 时要缩放，否则像素白花、token 白付。"""

    data = _noise_png(width=3000, height=1200)

    result = compress_image_for_upload(data, "image/png")

    assert result.changed is True
    assert max(result.width, result.height) <= MAX_EDGE


def test_animated_and_vector_images_are_left_alone() -> None:
    """动图只取首帧等于丢信息；SVG 是矢量，不该被位图化。"""

    data = _noise_png()
    assert compress_image_for_upload(data, "image/gif").changed is False
    assert compress_image_for_upload(data, "image/svg+xml").changed is False


def test_corrupt_image_degrades_to_original() -> None:
    """解码失败绝不能阻断上传：原样返回。"""

    broken = b"\x89PNG\r\n\x1a\n" + b"not really a png" * 100_000

    result = compress_image_for_upload(broken, "image/png")

    assert result.changed is False
    assert result.data == broken


def test_compressed_output_respects_target_budget() -> None:
    """压缩产物应落在目标预算内，不能「压了但还是太大」。"""

    data = _noise_png() * 2
    result = compress_image_for_upload(data, "image/png")

    assert result.changed is True
    assert len(result.data) <= TARGET_BYTES, (
        f"压缩后 {len(result.data)} 超过目标 {TARGET_BYTES}"
    )