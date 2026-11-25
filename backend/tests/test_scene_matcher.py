"""匹配主流程的测试。

对应 ``docs/scenes/scene-matcher.test.js`` 的漏斗部分（C/D/E/F 组），
另加约束：这几条断言在后端实现时**必须照抄**，因为每一条都对应一个
「结果看起来正常、其实全错」的静默缺陷。

运行：``cd backend && python -m pytest tests/test_scene_matcher.py -q``
"""

from __future__ import annotations

import math

import pytest

from app.scenes.matcher import MatchAction, run_match

# ============================================================
# 测试数据：一个刻意做脏的表
# ============================================================

ROWS = [
    # id, people, days, budget
    {"id": "1", "people": "4", "days": "5", "budget": "3000"},        # 精确档
    {"id": "2", "people": "4", "days": "5", "budget": "4000"},        # 预算高 33%
    {"id": "3", "people": "4", "days": "5", "budget": "2000"},        # 预算低 33%
    {"id": "4", "people": "6", "days": "5", "budget": "3000"},        # 人数不符
    {"id": "5", "people": "4", "days": "7", "budget": "3000"},        # 天数差 2
    {"id": "6", "people": "4", "days": "4", "budget": "2800"},        # 天数差 1
    {"id": "7", "people": "4", "days": "6", "budget": "5000"},        # 天数差 1
    {"id": "8", "people": "2", "days": "5", "budget": "1800"},        # 人数不符
    {"id": "9", "people": "4", "days": "5", "budget": "8千"},         # 单位换算
    {"id": "10", "people": "4", "days": "5", "budget": "20000"},      # 闸门淘汰
    {"id": "11", "people": "8", "days": "5", "budget": "6000"},       # 人数不符
    {"id": "12", "people": "4", "days": "3", "budget": "1500"},       # 天数差 2
    {"id": "13", "people": "4", "days": "5", "budget": "面议"},        # 无法解析
]


def ids(rows):
    return [r.id for r in rows]


# ============================================================
# A. 漏斗基本行为
# ============================================================


def test_exact_match_ranks_first_with_zero_deviation():
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000})
    assert r.hits, "应有命中"
    assert r.hits[0].id == "1", "精确档必须排第一"
    assert r.hits[0].score == pytest.approx(0.0), "精确档偏离必须为 0"


def test_unparsable_row_skipped_not_zero():
    """「面议」这行必须被跳过，不能兜底成 0 参与排序。

    若兜底成 0，它会以「预算最接近 0」的身份出现在结果里，
    而用户完全不知道自己的表里有坏数据。
    """
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000})
    assert "13" not in ids(r.ranked)
    assert r.unconvertible == 1, "应报告 1 行无法解析"


def test_unit_conversion_row_included():
    """8千 应被换算成 8000 并参与匹配，不能被当成无法解析。"""
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000})
    assert "9" in ids(r.ranked)


def test_gate_drops_far_outlier():
    """20000 对 3000 偏差 5.67，超过 maxScore=2，必须被闸门淘汰。"""
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000})
    assert "10" not in ids(r.ranked)
    assert r.gate_out >= 1


def test_people_is_hard_constraint():
    """4 人团不能给 6 人方案。"""
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000})
    for bad in ("4", "8", "11"):
        assert bad not in ids(r.ranked), f"{bad} 人数不符，不该出现在结果里"


def test_unit_conflict_blocks_same_number_different_unit():
    """人数层必须有单位冲突校验，否则「4 人」会把「4 天」的行全捞出来。

    这条单独存在是因为上面那张表**测不出这个缺陷**：
    表里 people 和 days 恰好从不同时等于 4 加同预算，去掉校验也照样通过。
    所以必须专门构造一组「数值相同、单位不同」的脏数据。
    """
    rows = [
        # 表头错位：人数列写成了天数，这是真实导入时最常见的脏数据
        {"id": "swapped", "people": "4天", "days": "4", "budget": "3000"},
        # 正常行，人数是 4 人
        {"id": "ok", "people": "4人", "days": "4", "budget": "3000"},
    ]
    r = run_match(rows, {"people": 4, "days": 4, "budget": 3000})
    assert "swapped" not in ids(r.ranked), "4天 冒充 4人，必须被单位冲突挡住"
    assert "ok" in ids(r.ranked)


def test_days_tolerance_plus_minus_one():
    """5 天可接受 4~6 天，但不能是 7 天。"""
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000})
    ranked = ids(r.ranked)
    assert "6" in ranked, "4 天在容差内"
    assert "7" in ranked, "6 天在容差内"
    assert "5" not in ranked, "7 天差 2，超出容差"
    assert "12" not in ranked, "3 天差 2，超出容差"


# ============================================================
# B. 槽位缺省（方案 §3.3 允许非必填）
# ============================================================


def test_empty_slots_returns_all_sorted():
    """全空等价于「没有任何条件」，返回可解析的行按预算升序。"""
    r = run_match(ROWS, {})
    assert len(r.ranked) == 12, "除面议外都该保留"
    assert r.ranked[0].nb.num <= r.ranked[-1].nb.num


def test_slots_none_does_not_crash():
    r = run_match(ROWS, None)
    assert r.total == len(ROWS)


def test_missing_people_slot_skips_layer():
    r = run_match(ROWS, {"days": 5, "budget": 3000})
    # 人数层跳过，6 人和 8 人的行应该回来
    assert "4" in ids(r.ranked) or "11" in ids(r.ranked)


def test_missing_days_slot_skips_layer():
    r = run_match(ROWS, {"people": 4, "budget": 3000})
    # 天数层跳过，7 天和 3 天的行应该回来（若预算闸门放行）
    assert "5" in ids(r.ranked) or "12" in ids(r.ranked)


def test_rows_with_missing_days_still_kept_when_slot_absent():
    rows = [
        {"id": "a", "people": "4", "days": "", "budget": "3000"},
        {"id": "b", "people": "4", "budget": "3000"},
    ]
    r = run_match(rows, {"people": 4, "budget": 3000})
    assert len(r.ranked) == 2, "天数缺省不该导致整行被扔"


# ============================================================
# C. 除零 / 负数 / nan —— 静默污染的三个来源
# ============================================================


def test_zero_budget_slot_no_crash():
    """预算填 0 不能做比率。

    除零得到 inf/nan，而 ``nan <= threshold`` 恒为 False，
    行会静默消失，看起来像「没匹配到」而不是「输入有问题」。
    """
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 0})
    assert r.invalid_budget is True
    # 不该崩，且不该把全部行都淘汰
    assert len(r.all_scored) > 0
    for row in r.all_scored:
        assert math.isfinite(row.score)


def test_negative_budget_slot_treated_as_invalid():
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": -100})
    assert r.invalid_budget is True
    assert all(math.isfinite(x.score) for x in r.all_scored)


def test_zero_budget_row_handled():
    """行里的预算是 0（免费档）也是合法数据，不能因此崩。"""
    rows = [{"id": "free", "people": "4", "days": "5", "budget": "0"}]
    r = run_match(rows, {"people": 4, "days": 5, "budget": 3000})
    assert all(math.isfinite(x.score) for x in r.all_scored)


def test_nan_never_passes_gate():
    """显式过滤保证「异常行被淘汰」而非「结果变少」。"""
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 0})
    for row in r.ranked:
        assert math.isfinite(row.score)


# ============================================================
# D. 排序与同分
# ============================================================


def test_tie_broken_by_lower_budget():
    """同分时预算更低者优先——同等偏差下先看便宜的。"""
    rows = [
        {"id": "high", "people": "4", "days": "5", "budget": "4000"},
        {"id": "low", "people": "4", "days": "5", "budget": "2000"},
    ]
    r = run_match(rows, {"people": 4, "days": 5, "budget": 3000})
    assert r.ranked[0].id == "low"


def test_top_k_respected():
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000}, MatchAction(top_k=2))
    assert len(r.hits) == 2


def test_top_k_never_exceeds_candidates():
    rows = [{"id": "only", "people": "4", "days": "5", "budget": "3000"}]
    r = run_match(rows, {"people": 4, "days": 5, "budget": 3000}, MatchAction(top_k=5))
    assert len(r.hits) == 1


# ============================================================
# E. 决策模型重排
# ============================================================


def test_model_rerank_changes_order():
    """置信度高但规则分略差的候选应被提上来。"""
    rows = [
        {"id": "rule-best", "people": "4", "days": "5", "budget": "3000", "conf": 0.1},
        {"id": "conf-best", "people": "4", "days": "5", "budget": "3400", "conf": 0.99},
    ]
    r_off = run_match(rows, {"people": 4, "days": 5, "budget": 3000}, MatchAction(use_decision_model=False))
    r_on = run_match(rows, {"people": 4, "days": 5, "budget": 3000}, MatchAction(use_decision_model=True))
    assert r_off.ranked[0].id == "rule-best"
    assert r_on.ranked[0].id == "conf-best"
    assert r_on.reranked is True


def test_model_off_means_model_not_used():
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000}, MatchAction(use_decision_model=False))
    assert r.model_used is False


def test_model_fused_score_computed():
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000}, MatchAction(use_decision_model=True))
    for row in r.ranked:
        assert row.fused is not None
        assert 0.0 <= row.fused <= 1.0


# ============================================================
# F. trace / 契约
# ============================================================


def test_steps_are_five_and_ordered():
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000})
    assert [s.key for s in r.steps] == ["normalize", "people", "days", "score", "topk"]


def test_steps_ratio_in_range():
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000})
    for s in r.steps:
        assert 0.0 <= s.ratio <= 1.0


def test_all_scored_covers_rows_before_gate():
    r = run_match(ROWS, {"people": 4, "days": 5, "budget": 3000})
    score_step = next(s for s in r.steps if s.key == "score")
    assert len(r.all_scored) == score_step.from_


def test_result_has_no_match_when_nothing_fits():
    r = run_match(ROWS, {"people": 99, "days": 5, "budget": 3000})
    assert r.hits == []
    assert r.ranked == []


def test_empty_rows_table():
    r = run_match([], {"people": 4, "days": 5, "budget": 3000})
    assert r.total == 0
    assert r.hits == []
    for s in r.steps:
        assert s.ratio == 0.0, "空表不能出现除零"


def test_custom_column_keys():
    """真实场景的列 key 不是 people/days/budget，是用户表头映射出来的。"""
    rows = [{"id": "x", "人数": "4", "天数": "5", "预算": "3000"}]
    r = run_match(
        rows,
        {"people": 4, "days": 5, "budget": 3000},
        people_key="人数",
        days_key="天数",
        budget_key="预算",
    )
    assert len(r.hits) == 1


def test_action_from_json_with_garbage():
    """配置里的脏值不能让整条链路崩。"""
    a = MatchAction.from_json({"top_k": "abc", "max_score": None, "days_weight": -1})
    assert a.top_k == 3
    assert a.max_score == 2.0
    assert a.days_weight == -1  # 保留原值，但下面的兜底会处理 w_sum<=0


def test_zero_weights_do_not_crash():
    rows = [{"id": "1", "people": "4", "days": "5", "budget": "3000"}]
    r = run_match(rows, {"people": 4, "days": 5, "budget": 3000}, MatchAction(days_weight=0, budget_weight=0))
    assert len(r.hits) == 1
    assert math.isfinite(r.hits[0].score)