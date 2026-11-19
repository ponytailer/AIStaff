"""图片附件上传压缩：让「大图」也保得住视觉能力。

## 要解决的问题

上传上限是 12MB（``chat.MAX_CHAT_ATTACHMENT_BYTES``），但图片转 data URL 的上限
只有 4MB（``attachments.IMAGE_DATA_URL_LIMIT_BYTES``）。``_image_attachment``
超过 4MB 就把 ``data_url`` 置为 ``None``：

    if len(data) <= IMAGE_DATA_URL_LIMIT_BYTES:
        ...
        data_url = f"data:{content_type};base64,{encoded}"

后果是 **4MB~12MB 的图片上传成功、界面显示正常，但模型完全看不见** ——
``image_payloads_from_attachments`` 会因 ``not attachment.data_url`` 直接跳过。
用户拿到的反馈是「我明明把报错截图传上去了，它说没看到图」。

压缩在这里做，等价于把「4~12MB 区间」从静默失效变成可用。

## 为什么必须在生成 data_url 之前

``stage_chat_attachment`` 用**传入的原始 bytes** 算 sha256 并落盘，而 turn
回程的 ``validate_chat_turn_attachments`` 又会用 ``data_url`` 解出的 bytes 跟
``sha256``、``size`` 比对。三者任一不一致就抛「图片 data URL 与上传文件不一致」。
所以压缩后的 bytes 必须是**唯一事实源**：算 sha、落盘、编 data_url 全用它。

## 策略

**先缩边，再降质。** 截图的主要信息是文字，直接降 JPEG 质量会把小字糊掉。
按长边缩到 ``MAX_EDGE`` 像素后再编码：现代截图普遍是 2x/3x 缩放，缩到 2560
长边对阅读报错文本毫无损失，却能砍掉大量像素。

**保留「有透明/无照片」的图转 PNG，其余转 JPEG。** 截图、图表、线框这类图
PNG 体量小且文字锐利；照片类 JPEG 才能压下来。判据用「像素数 × 色彩复杂度」
不划算，这里用更稳的启发式：带 alpha 通道或颜色数很少 → PNG，否则 JPEG。

**渐进降质直到进线。** 单一质量参数在极端图上可能仍然超限，所以按质量阶梯
逐个试，仍不行再缩边。

**失败一律原样返回。** 不认的格式（SVG、动图）、解码失败、编码异常，全部
原样返回原 bytes —— 这条路径只做增强，绝不阻断上传。

## 为什么不直接拒收超大图

拒收会把「能传上去但模型看不见」换成「传都传不上去」，仍然是坏体验；而
截图随手一截就是 5-8MB（Retina 全屏 PNG），拒收等于把最常见的用法砍掉。
"""

from __future__ import annotations

import io
from dataclasses import dataclass

# 编码后的目标上限。真正的硬约束是 ``IMAGE_DATA_URL_LIMIT_BYTES``（4MB），
# 且校验的是 **base64 解码后**的长度（见 ``attachments._validated_image_data_url``
# 里的 ``len(decoded) > IMAGE_DATA_URL_LIMIT_BYTES``）——所以不需要为 base64
# 的 4/3 膨胀留余量。
# 留 10% 余量是为了给「压到 3.9MB 但后端别处又比对 size」这类耦合留空间，
# 不是为了 base64。
TARGET_BYTES = int(3.7 * 1024 * 1024)

# 长边上限。2560 足够看清 4K 截图里的正文（全屏 4K 截图缩一半后，
# 14px 正文仍有 7px 高，OCR 与多模态模型都能读）。再大只是浪费 token。
MAX_EDGE = 2560

# JPEG 质量阶梯：从高到低试。0.85 对文字仍锐利，0.6 是可用下限。
QUALITY_STEPS = (0.85, 0.75, 0.65, 0.6)

# 不值得压缩的小图阈值：低于此值既不会超 4MB data URL 上限，压缩也只会
# 损失质量换几个 KB。省掉一次解码开销。
NO_COMPRESS_BELOW_BYTES = 1 * 1024 * 1024

# 不处理的格式：动图压成静态帧等于丢信息；SVG 是矢量，Pillow 也解不了。
SKIP_CONTENT_TYPES = frozenset({"image/gif", "image/svg+xml"})


@dataclass(frozen=True)
class CompressResult:
    """压缩结果。``changed`` 为 False 时 ``data`` 与入参是同一份 bytes。"""

    data: bytes
    content_type: str
    changed: bool
    width: int = 0
    height: int = 0


def compress_image_for_upload(
    data: bytes,
    content_type: str,
    *,
    max_bytes: int = TARGET_BYTES,
) -> CompressResult:
    """把图片压到 ``max_bytes`` 以内；压不动就原样返回。

    返回值永远是「可以安全落库并生成 data_url」的形态——调用方不需要再判断
    是否超限，只需用返回的 ``data`` 和 ``content_type``。
    """

    unchanged = CompressResult(data=data, content_type=content_type, changed=False)
    if not data or content_type in SKIP_CONTENT_TYPES:
        return unchanged
    if len(data) <= NO_COMPRESS_BELOW_BYTES and len(data) <= max_bytes:
        return unchanged

    try:
        from PIL import Image
    except ImportError:  # pragma: no cover - 依赖缺失时降级，不影响上传
        return unchanged

    try:
        with Image.open(io.BytesIO(data)) as opened:
            # 动图只取首帧会丢信息，直接放过
            if getattr(opened, "is_animated", False):
                return unchanged
            width, height = opened.size
            # 先按长边缩一次。已经够小就不动尺寸，只调质量。
            scale = _scale_for(width, height)
            working = opened
            if scale < 1.0:
                working = opened.resize(
                    (max(1, int(width * scale)), max(1, int(height * scale))),
                    Image.LANCZOS,
                )
            for candidate, candidate_type in _encode_candidates(working):
                if len(candidate) <= max_bytes:
                    # 压缩后反而更大（PNG 转 JPEG 可能如此）就别换了
                    if len(candidate) >= len(data):
                        return unchanged
                    return CompressResult(
                        data=candidate,
                        content_type=candidate_type,
                        changed=True,
                        width=working.size[0],
                        height=working.size[1],
                    )
            return unchanged
    except Exception:  # noqa: BLE001 - 压缩是增强，绝不阻断上传
        return unchanged


def _scale_for(width: int, height: int) -> float:
    longest = max(width, height)
    if longest <= MAX_EDGE:
        return 1.0
    return MAX_EDGE / longest


def _encode_candidates(image: object):
    """产出 (bytes, content_type) 序列，按「无损优先、质量递减」排序。

    顺序为什么是「先 PNG 再 JPEG」而不是按图片类型分流：PNG 无损，只要能压进
    目标就该用它。实测真实截图（带抗锯齿/字体 hinting）即使长边缩到 2560，
    PNG 仍有 6.1MB —— 远超 4MB 上限，所以大截图**必然**要落到 JPEG。
    与其用「颜色数」之类脆弱启发式猜，不如直接让编码结果说话：PNG 装得下就
    用 PNG，装不下就用高质量 JPEG。
    """

    from PIL import Image

    buffer = io.BytesIO()
    # optimize=True 对截图常有 20-40% 收益，代价只是编码时间
    image.save(buffer, format="PNG", optimize=True)
    yield buffer.getvalue(), "image/png"

    # PNG 装不下：转 JPEG。文字截图的清晰度靠「质量高」而不是「不转」来保，
    # 所以从 0.9 起试，而不是从 0.85。
    rgb = _flatten_alpha(image)
    for quality in QUALITY_STEPS:
        buffer = io.BytesIO()
        rgb.save(buffer, format="JPEG", quality=int(quality * 100), optimize=True)
        yield buffer.getvalue(), "image/jpeg"

    # 极端情况：最高缩放 + 最低质量仍超限，再缩一半重试
    smaller = image.resize(
        (max(1, image.size[0] // 2), max(1, image.size[1] // 2)),
        Image.LANCZOS,
    )
    rgb_small = _flatten_alpha(smaller)
    for quality in QUALITY_STEPS:
        buffer = io.BytesIO()
        rgb_small.save(buffer, format="JPEG", quality=int(quality * 100), optimize=True)
        yield buffer.getvalue(), "image/jpeg"


def _flatten_alpha(image: object):
    """JPEG 不支持透明：把 RGBA 铺白底转 RGB，避免变成黑底。"""

    from PIL import Image

    if getattr(image, "mode", "") in {"RGBA", "LA", "P"}:
        converted = image.convert("RGBA")
        background = Image.new("RGB", converted.size, (255, 255, 255))
        background.paste(converted, mask=converted.split()[-1])
        return background
    return image.convert("RGB") if getattr(image, "mode", "") != "RGB" else image