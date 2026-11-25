"""值归一化：把表里和用户输入里的脏值统一成 ``(数值, 单位)`` 二元组。

为什么需要这一层：表里的脏值是常态——``1,000`` / ``¥3000`` / ``三千`` /
``３０００`` / ``3000-4000``。每一条都会让朴素解析**安静地**给出错值
（``1,000`` → ``1`` 是最恶的一种：差 1000 倍却不报错，结果看起来完全正常）。

一条铁律：**解析失败必须返回 None，绝不允许兜底成 0**。上层据此把它计入
「跳过行数」统计并显式告知用户，而不是当成一个真实的 0 参与排序。
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

__all__ = ["Normalized", "extract_slots", "format_number", "normalize", "unit_conflict"]


# 单位同义归并。顺序无关，这里用 dict 直查。
UNIT_ALIAS: dict[str, str] = {
    "人": "人", "位": "人", "名": "人", "个": "人",
    "天": "天", "日": "天", "晚": "天",
    "元": "元", "块": "元", "块钱": "元",
}

# 倍数词：万/千/k 不改单位，只改量级
SCALE: dict[str, float] = {"万": 1e4, "w": 1e4, "W": 1e4, "千": 1e3, "k": 1e3, "K": 1e3}

_CN_DIGIT: dict[str, int] = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3,
    "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}
_CN_UNIT: dict[str, int] = {"十": 10, "百": 100, "千": 1000}
_CN_ALL = set(_CN_DIGIT) | set(_CN_UNIT) | {"万", "亿", "负"}

_FULLWIDTH_DIGITS = {c: c - 0xFEE0 for c in range(0xFF10, 0xFF1A)}
_FULLWIDTH_PUNCT = {0xFF0C: ",", 0xFF0E: ".", 0xFF0D: "-"}
# 注意：str.translate 的 key 必须是 **ordinal（int）**，传字符串 key 会被静默忽略——
# 写成 {"３": "3"} 不会报错，但全角转换会整个失效，然后 ３０００ 被判成无法解析。
_FULLWIDTH = {**_FULLWIDTH_DIGITS, **_FULLWIDTH_PUNCT}

_CURRENCY_PREFIX = re.compile(r"^[¥$￥€£]")
_NOISE_PREFIX = re.compile(r"^(约|起|低至|仅|大概|大约)")
# 尾部口语助词。只剥「不带语义的语气词与范围词」——
# 千万不能把「块 / 元」也放进来：那是单位信息，剥掉后 3000块 会丢失 unit=元，
# 于是「人数=3000」和「预算=3000」就区分不开了。
_SUFFIX_NOISE = re.compile(r"(左右|上下|出头|以内|以下|以上|吧|呢|啊|的)+$")

# 区间：两侧都可能带倍数词（3k~4k），所以两边都要单独展开
_RANGE_RE = re.compile(
    r"^(\d+(?:\.\d+)?)\s*([万wW千kK])?\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*([万wW千kK])?"
)
_SCI_RE = re.compile(r"^(\d+(?:\.\d+)?)[eE]([+-]?\d+)")
# 千分位：只删「后面正好跟三位数字」的逗号，避免把 1,23 这种误伤
_THOUSANDS_RE = re.compile(r"(\d),(?=\d{3}(?:\D|$))")
_PLAIN_RE = re.compile(
    r"^(\d+(?:\.\d+)?)\s*([万wW千kK])?\s*(块钱|人|位|名|个|天|日|晚|元|块)?"
)


@dataclass(frozen=True)
class Normalized:
    """归一化结果。

    ``unit`` 为空串表示「没说单位」——这与「单位是人」是两件事，
    前者可与任何单位兼容，后者不能。见 :func:`unit_conflict`。
    """

    num: float
    unit: str = ""
    converted: bool = False
    from_range: bool = False

    @property
    def ok(self) -> bool:
        return math.isfinite(self.num)


def _cn_to_number(text: str) -> float | None:
    """中文数字 → 数值。只处理常见写法（三千/两万/十五/三百），不做完整解析。

    遇到无法解释的字就返回 None——宁可报「解析不了」也不要猜，
    猜错的代价比缺值大得多（缺值会走「跳过」分支并在界面提示）。
    """
    total = 0.0
    section = 0.0
    digit = -1
    negative = False

    for ch in text:
        if ch == "负":
            negative = True
            continue
        if ch in _CN_DIGIT:
            digit = _CN_DIGIT[ch]
            continue
        if ch in _CN_UNIT:
            # 「十五」的十前面没数字，按 1 算
            section += (1 if digit < 0 else digit) * _CN_UNIT[ch]
            digit = -1
            continue
        if ch in ("万", "亿"):
            mult = 1e4 if ch == "万" else 1e8
            section += max(digit, 0)
            total += (section or 1) * mult
            section = 0.0
            digit = -1
            continue
        return None

    if digit >= 0:
        section += digit
    value = total + section
    if value == 0 and not re.search(r"[零〇]", text):
        return None
    return -value if negative else value


def normalize(raw: Any) -> Normalized | None:
    """把任意值归一化成 ``(数值, 单位)``。

    处理顺序有依赖，不可调换：
    全角→半角 → 剥符号/前缀语 → 区间 → 科学计数 → 千分位 → 中文数字 → 数值+倍数+单位。
    """
    if raw is None:
        return None
    s = str(raw).strip().translate(_FULLWIDTH)
    s = re.sub(r"\s+", "", s)
    if not s:
        return None

    negative = False
    if s[0] in "-−":
        negative = True
        s = s[1:]

    s = _CURRENCY_PREFIX.sub("", s)
    s = _NOISE_PREFIX.sub("", s)
    if not s:
        return None

    # 去掉尾部的口语助词：「三千块左右」「3000 元左右」「5k 上下」。
    # 不做这一步，「三千块左右吧」整串里有无法解释的字，会被判成无法解析——
    # 而这恰恰是用户最自然的说话方式。
    s = _SUFFIX_NOISE.sub("", s)
    if not s:
        return None

    # 区间取上界：用户报区间时按能给的上限算，不会低估预算。
    # 顺序写反（4k~3k）也取较大者，不至于给出更小的值。
    m = _RANGE_RE.match(s)
    if m:
        lo = float(m.group(1)) * (SCALE[m.group(2)] if m.group(2) else 1)
        hi = float(m.group(3)) * (SCALE[m.group(4)] if m.group(4) else 1)
        num = max(lo, hi)
        return Normalized(num=-num if negative else num, unit="", converted=True, from_range=True)

    m = _SCI_RE.match(s)
    if m:
        num = float(m.group(1)) * (10 ** int(m.group(2)))
        return Normalized(num=-num if negative else num, unit="", converted=True)

    # 千分位必须在普通数值解析之前，否则 1,000 会变成 1
    plain = _THOUSANDS_RE.sub(r"\1", s)

    # 中文数字：只有整串都是中文数字词才算，混入其他字就判失败。
    # 但「三千块」这种带单位的中文数字很常见，先把尾部的单位词摘出来再判。
    cn_unit = ""
    cn_plain = plain
    m_unit = re.search(r"(块钱|人|位|名|个|天|日|晚|元|块)$", cn_plain)
    if m_unit and all(ch in _CN_ALL for ch in cn_plain[: m_unit.start()]):
        cn_unit = UNIT_ALIAS.get(m_unit.group(1), "")
        cn_plain = cn_plain[: m_unit.start()]

    if cn_plain and all(ch in _CN_ALL for ch in cn_plain):
        n = _cn_to_number(cn_plain)
        if n is None:
            return None
        return Normalized(
            num=-n if negative else n, unit=cn_unit, converted=True
        )

    m = _PLAIN_RE.match(plain)
    if not m:
        return None

    try:
        num = float(m.group(1))
    except ValueError:
        return None
    if not math.isfinite(num):
        return None

    scale_key = m.group(2) or ""
    raw_unit = m.group(3) or ""
    converted = False
    if scale_key:
        num *= SCALE[scale_key]
        converted = True
    if negative:
        num = -num

    # 倍数词本身隐含单位：3k 是钱不是 3 天
    if raw_unit:
        unit = UNIT_ALIAS.get(raw_unit, "")
    elif scale_key:
        unit = "元"
    else:
        unit = ""

    return Normalized(num=num, unit=unit, converted=converted)


def unit_conflict(a: Normalized | None, b: Normalized | None) -> bool:
    """两侧都写了单位且不兼容 → 冲突。

    这是「人数=4 会把所有 4 天的行全捞出来」的唯一防线：
    ``4人`` 与 ``4天`` 数值都是 4，只有单位能区分。
    单边有单位时放行——表里写 ``4``、用户填 ``4人`` 是常见情形，不该拒。
    """
    if a is None or b is None:
        return False
    if not a.unit or not b.unit:
        return False
    return a.unit != b.unit


# ============================================================
# 反向操作：从一整句话里抽槽位
#
# normalize 解决的是「拿到一个值怎么解析」，这里解决「从一句话里先切出哪个是哪个」。
# normalize 再强，切错片段也救不回来。
# ============================================================

_PPL_RE = re.compile(r"(\d+|[一二两三四五六七八九十])\s*(?:个人|人|位)")
_DAY_RE = re.compile(r"(\d+|[一二两三四五六七八九十])\s*(?:天|日|晚)")
_CN_CLASS = "[零〇一二两三四五六七八九十百千万亿]+"
_NUM_PAT = rf"(?:\d+(?:\.\d+)?|{_CN_CLASS})"
_MONEY_UNIT_RE = re.compile(rf"({_NUM_PAT})\s*(?:k|K|千|万|元|块)")
_AFTER_KW_RE = re.compile(rf"预算\s*[:：]?\s*({_NUM_PAT})\s*(k|K|千|万|元|块)?")
_BARE_NUM_RE = re.compile(r"\d+(?:\.\d+)?")


def extract_slots(text: str) -> dict[str, Any]:
    """从自然语言里抽 people / days / budget。

    返回 ``{"any": bool, "slots": {...}}``。

    顺序很关键：**先把人数、天数从文本里抠掉，再找预算**。否则
    「4 个人 3 天 预算 3000」里第一个数字 4 会被当成预算候选，
    而真正的 3000 因为前面没有紧跟单位而漏掉——这个 bug 真实发生过：
    用户说「预算 3000」，界面仍按上一次表单的 5000 查表。
    """
    out: dict[str, Any] = {"any": False, "slots": {}}
    rest = text

    m = _PPL_RE.search(rest)
    if m:
        n = normalize(m.group(1))
        if n and n.num > 0:
            out["slots"]["people"] = n.num
            out["any"] = True
        rest = rest.replace(m.group(0), " ")

    m = _DAY_RE.search(rest)
    if m:
        n = normalize(m.group(1))
        if n and n.num > 0:
            out["slots"]["days"] = n.num
            out["any"] = True
        rest = rest.replace(m.group(0), " ")

    # 预算三档优先级，由强到弱：
    # ① 带钱单位（3k / 5千 / 8000元 / 三千）—— 最可信
    # ② 「预算」关键词后跟的数字 —— 用户意图明确
    # ③ 剩余文本里 >= 100 的最大数字 —— 兜底
    #
    # 中文数字必须单独列一支：normalize("三千") 本身能算对，但如果这一层
    # 的正则写成 \d+，中文数字连机会都没有——这是两层之间的契约漏洞。
    picked: Normalized | None = None
    m = _MONEY_UNIT_RE.search(rest)
    if m:
        picked = normalize(m.group(0))
    else:
        m = _AFTER_KW_RE.search(rest)
        if m:
            picked = normalize(m.group(1) + (m.group(2) or ""))
        else:
            # 兜底只看阿拉伯数字：纯中文数字没有单位时歧义太大
            # （「三千」是钱还是「三千里」），宁可追问也不要猜错
            nums = [float(v) for v in _BARE_NUM_RE.findall(rest)]
            nums = [v for v in nums if v >= 100]
            if nums:
                picked = Normalized(num=max(nums), unit="元")

    if picked and picked.num > 0:
        out["slots"]["budget"] = picked.num
        out["any"] = True

    return out


def format_number(value: float | None) -> str:
    """展示用：去掉无意义的小数尾巴，None 显示为「—」而不是 NaN。"""
    if value is None:
        return "—"
    if isinstance(value, float) and not math.isfinite(value):
        return "—"
    if float(value) == int(value):
        return str(int(value))
    return f"{value:.2f}".rstrip("0").rstrip(".")