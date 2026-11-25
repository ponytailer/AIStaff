"""归一化与槽位抽取的测试。

**这份测试的价值在于逐条对应一个真实踩过的坑**：demo 阶段（
``docs/scenes/scene-*.test.js`` 共 133 条）在真实交互里暴露了 9 类脏值问题，
这里把断言照抄过来，避免 Python 实现重踩一遍。

运行：``cd backend && python -m pytest tests/test_scene_normalize.py -q``
"""

from __future__ import annotations

import math

import pytest

from app.scenes.normalize import extract_slots, format_number, normalize, unit_conflict

# ============================================================
# A. 基础数值
# ============================================================


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("3000", 3000),
        (3000, 3000),
        ("3000.5", 3000.5),
        (0, 0),
        ("0", 0),
    ],
)
def test_plain_numbers(raw, expected):
    n = normalize(raw)
    assert n is not None
    assert n.num == expected


@pytest.mark.parametrize("raw", [None, "", "   ", "面议", "TBD", "待定", "—"])
def test_unparsable_returns_none(raw):
    """解析失败必须返回 None，绝不能兜底成 0。

    兜底成 0 会让这行进入排序并排在「预算最接近 0」的位置，
    而用户永远不知道自己的表里有坏数据。
    """
    assert normalize(raw) is None


def test_thousands_separator():
    """1,000 必须解析成 1000。

    这是最恶的一种缺陷：朴素实现会解析成 1，差 1000 倍却不报错，
    结果看起来完全正常。所以这条测试必须单独存在。
    """
    assert normalize("1,000").num == 1000
    assert normalize("12,345").num == 12345
    # 不是千分位的逗号不能误伤
    assert normalize("1,23") is None or normalize("1,23").num != 123


def test_scientific_notation():
    assert normalize("1e5").num == 100000
    assert normalize("1E5").num == 100000
    assert normalize("2.5e3").num == 2500


@pytest.mark.parametrize("raw", ["¥3000", "$3000", "￥3000", "€3000", "£3000"])
def test_currency_prefix_stripped(raw):
    n = normalize(raw)
    assert n is not None, f"{raw} 不该返回 None"
    assert n.num == 3000


@pytest.mark.parametrize("raw", ["约3000", "起3000", "低至3000", "仅3000", "大概3000", "大约3000"])
def test_noise_prefix_stripped(raw):
    n = normalize(raw)
    assert n is not None, f"{raw} 不该返回 None"
    assert n.num == 3000


def test_fullwidth_digits():
    """全角数字必须先转半角，否则会被判成 null。"""
    assert normalize("３０００").num == 3000
    assert normalize("１，０００").num == 1000


def test_whitespace_inside():
    assert normalize("4 人").num == 4
    assert normalize(" 3000 元 ").num == 3000


# ============================================================
# B. 单位
# ============================================================


@pytest.mark.parametrize(
    "raw,unit",
    [
        ("4人", "人"), ("4位", "人"), ("4名", "人"), ("4个", "人"),
        ("5天", "天"), ("5日", "天"), ("5晚", "天"),
        ("3000元", "元"), ("3000块", "元"), ("3000块钱", "元"),
    ],
)
def test_unit_alias(raw, unit):
    n = normalize(raw)
    assert n is not None
    assert n.unit == unit


@pytest.mark.parametrize("raw,expected,unit", [
    ("3k", 3000, "元"),
    ("3K", 3000, "元"),
    ("3千", 3000, "元"),
    ("4万", 40000, "元"),
    ("4w", 40000, "元"),
    ("4W", 40000, "元"),
])
def test_scale_words(raw, expected, unit):
    """倍数词本身隐含单位：3k 是钱，不是 3 天。"""
    n = normalize(raw)
    assert n is not None
    assert n.num == expected
    assert n.unit == unit


def test_scale_word_does_not_change_unit_word():
    """带倍数词也带单位时，单位以单位词为准。"""
    n = normalize("3k元")
    assert n.num == 3000
    assert n.unit == "元"


# ============================================================
# C. 中文数字
# ============================================================


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("三千", 3000),
        ("两万", 20000),
        ("十五", 15),
        ("三百", 300),
        ("一百", 100),
        ("一万", 10000),
        ("三万五千", 35000),
        ("零", 0),
    ],
)
def test_chinese_numbers(raw, expected):
    n = normalize(raw)
    assert n is not None, f"{raw} 应能解析"
    assert n.num == expected


def test_chinese_number_mixed_with_other_chars_rejected():
    """混入其他字就判失败——「三千里」是距离不是「三千米」。"""
    assert normalize("三千里") is None
    assert normalize("三千块左右吧") is not None  # 前缀剥离后能解析
    assert normalize("差不多三千") is None


# ============================================================
# D. 区间与负数
# ============================================================


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("3000-4000", 4000),  # 取上界，不低估用户预算
        ("3000~4000", 4000),
        ("3000至4000", 4000),
        ("3000到4000", 4000),
        ("4k~3k", 4000),  # 写反了也不给出更小的值
        ("3k~4k", 4000),  # 两侧倍数词都要展开
        ("3千-4千", 4000),
    ],
)
def test_range_takes_upper_bound(raw, expected):
    n = normalize(raw)
    assert n is not None
    assert n.num == expected
    assert n.from_range is True


def test_negative():
    n = normalize("-3000")
    assert n is not None
    assert n.num == -3000


# ============================================================
# E. 单位冲突（这条是「人数=4 捞回所有 4 天」的唯一防线）
# ============================================================


def test_unit_conflict_detected():
    a = normalize("4人")
    b = normalize("4天")
    assert unit_conflict(a, b) is True


def test_unit_conflict_same_unit_ok():
    a = normalize("4人")
    b = normalize("4位")
    assert unit_conflict(a, b) is False  # 归并后都是「人」


def test_unit_conflict_one_side_missing_is_ok():
    """表里写 4、用户填 4人 是常态，不能拒。"""
    a = normalize("4")
    b = normalize("4人")
    assert unit_conflict(a, b) is False


def test_unit_conflict_both_missing_is_ok():
    assert unit_conflict(normalize("4"), normalize("4")) is False


def test_unit_conflict_none_is_ok():
    assert unit_conflict(None, normalize("4")) is False
    assert unit_conflict(normalize("4"), None) is False


# ============================================================
# F. extract_slots —— 从自然语言抽槽位
#
# 这一组来自一次真实翻车：用户说「换成 4 个人 3 天 预算 3000」，
# 人数和天数都更新了，预算却仍是上一次表单里的 5000。
# 根因是旧实现先跑一个泛数字正则，第一个命中是「4」（人），
# 而真正的 3000 因为前面没紧跟单位、压根没被取出来。
# ============================================================


def test_extract_full_sentence():
    r = extract_slots("换成 4 个人 3 天 预算 3000")
    assert r["any"] is True
    assert r["slots"]["people"] == 4
    assert r["slots"]["days"] == 3
    assert r["slots"]["budget"] == 3000


def test_extract_budget_after_keyword():
    r = extract_slots("预算 3000")
    assert r["slots"]["budget"] == 3000


@pytest.mark.parametrize("text,expected", [
    ("预算 3k", 3000),
    ("5k 就够了", 5000),
    ("预算三千", 3000),
    ("8000 元", 8000),
    ("预算 4500 块", 4500),
])
def test_extract_budget_units(text, expected):
    assert extract_slots(text)["slots"]["budget"] == expected


def test_extract_no_crosstalk():
    """三个数字混在一句里不会串位。"""
    r = extract_slots("我们 6 个人玩 4 天，预算 5k")
    assert r["slots"]["people"] == 6
    assert r["slots"]["days"] == 4
    assert r["slots"]["budget"] == 5000


def test_extract_bare_number_fallback_picks_max_100_plus():
    """兜底取 >=100 的最大值，避免把「2 大 1 小」的 2 当预算。"""
    r = extract_slots("2 大 1 小 大概 8000")
    assert r["slots"]["budget"] == 8000


def test_extract_small_numbers_not_budget():
    r = extract_slots("2 大 1 小")
    assert "budget" not in r["slots"]


def test_extract_nothing():
    r = extract_slots("那退款怎么弄")
    assert r["any"] is False
    assert r["slots"] == {}


def test_extract_people_only():
    r = extract_slots("我们 8 个人")
    assert r["any"] is True
    assert r["slots"]["people"] == 8
    assert "budget" not in r["slots"]


def test_extract_chinese_people_and_days():
    r = extract_slots("我们四个人玩三天")
    assert r["slots"]["people"] == 4
    assert r["slots"]["days"] == 3


# ============================================================
# G. format_number
# ============================================================


def test_format_number():
    assert format_number(3000) == "3000"
    assert format_number(3000.0) == "3000"
    assert format_number(3000.5) == "3000.5"
    assert format_number(None) == "—"
    assert format_number(math.nan) == "—"
    assert format_number(math.inf) == "—"