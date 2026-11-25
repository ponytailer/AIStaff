"""匹配主流程：硬约束过滤 → 软打分 → 闸门 → 排序 → 兜底。

设计原则（每一条都对应一个真实缺陷）：

1. **槽位缺省即跳过该层，绝不当 0**。方案允许槽位非必填，
   把缺省当 0 会让「没填人数」变成「必须是 0 人」，全表淘汰。
2. **分母显式判 > 0**。预算填 0 或负数时不能做比率——除零得到 inf/nan，
   而 ``nan <= threshold`` 恒为 False，行会**静默消失**，看起来像「没匹配到」。
3. **nan 单独计数后淘汰**，不要依赖比较运算的副作用。
4. **归一化失败的行计入「跳过」并上报**，不能兜底成 0 混进排序。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from app.scenes.normalize import Normalized, format_number, normalize, unit_conflict

__all__ = ["MatchAction", "MatchResult", "MatchRow", "run_match"]


@dataclass
class MatchAction:
    """对应 ``scene.match_action_json``。"""

    # 软打分行权重；天数权重更高是因为「5 天变 6 天」对体验的影响大于预算浮动几百块
    days_weight: float = 1.5
    budget_weight: float = 1.0
    days_tolerance: int = 1
    # 超过这个分数视为完全不相关，直接淘汰（而不是排在最后）
    max_score: float = 2.0
    top_k: int = 3
    # 决策模型融合分里规则分的权重
    rule_weight: float = 0.5
    use_decision_model: bool = False

    @classmethod
    def from_json(cls, data: dict[str, Any] | None) -> MatchAction:
        data = data or {}
        defaults = cls()
        return cls(
            days_weight=_as_float(data.get("days_weight"), defaults.days_weight),
            budget_weight=_as_float(data.get("budget_weight"), defaults.budget_weight),
            days_tolerance=_as_int(data.get("days_tolerance"), defaults.days_tolerance),
            max_score=_as_float(data.get("max_score"), defaults.max_score),
            top_k=max(1, _as_int(data.get("top_k"), defaults.top_k)),
            rule_weight=_as_float(data.get("rule_weight"), defaults.rule_weight),
            use_decision_model=bool(data.get("use_decision_model", False)),
        )


# 每个槽位在表里「应该有」的单位。用于挡住「4天 冒充 4人」这类错列数据。
#
# 为什么必须在行侧校验，而不能靠 unit_conflict：
# 表单提交的槽位是纯数字（4），没有单位；而 unit_conflict 对「单边缺单位」
# 是**故意放行**的（表里写 4、用户填 4人 是常态，不能拒）。
# 两者叠加的结果是：槽位侧永远校验不出来，脏数据一路走到结果里。
# 唯一可靠的判据是「这一列的值带了个不该有的单位」——那是列映射错了。
#
# ⚠️ 这是**默认约定，不是唯一路径**（impl-map §1.1）：
# 调用方可以在 ``run_match(unit_by_slot=...)`` 里覆盖某个槽位的期望单位；
# 不传就用这里这三个。删掉它会让「5 行 → 4 行」变成「5 行 → 5 行」，
# R1 第一条断言直接破 —— 它是那条断言的**实际实现依赖**，不是历史包袱。
_EXPECTED_UNIT_BY_SLOT: dict[str, str] = {"people": "人", "days": "天", "budget": "元"}


@dataclass
class MatchRow:
    """一行数据 + 归一化结果 + 打分。"""

    id: str
    row: dict[str, Any]
    np: Normalized | None = None  # people
    nd: Normalized | None = None  # days
    nb: Normalized | None = None  # budget
    conf: float = 0.0  # 决策模型的置信度（仅重排时用）
    days_dev: float = 0.0
    budget_dev: float = 0.0
    score: float = 0.0
    rule_norm: float = 0.0
    fused: float | None = None


@dataclass
class MatchStep:
    key: str
    label: str
    detail: str
    from_: int
    to: int
    drop_text: str = ""
    ratio: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "detail": self.detail,
            "from": self.from_,
            "to": self.to,
            "dropText": self.drop_text,
            "ratio": self.ratio,
        }


@dataclass
class MatchResult:
    steps: list[MatchStep] = field(default_factory=list)
    ranked: list[MatchRow] = field(default_factory=list)
    all_scored: list[MatchRow] = field(default_factory=list)
    hits: list[MatchRow] = field(default_factory=list)
    total: int = 0
    normalized_count: int = 0
    unconvertible: int = 0
    gate_out: int = 0
    nan_count: int = 0
    reranked: bool = False
    model_used: bool = False
    invalid_budget: bool = False

    def steps_json(self) -> list[dict[str, Any]]:
        return [s.to_dict() for s in self.steps]


def _as_float(value: Any, default: float) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _row_id(row: dict[str, Any], fallback: int) -> str:
    """取行 id 用于排序稳定与重排比对。

    优先 ``__row_id__``（API 层注入的内部主键），其次 ``id`` / ``_id``
    （直接调 ``run_match`` 的调用方和既有测试这么传）。
    **不能**反过来：表里可能真有叫 ``id`` 的列，那是用户数据，不该劫持行标识。
    """
    return str(row.get("__row_id__") or row.get("id") or row.get("_id") or fallback)


def _wrong_unit(n: Normalized | None, expected: str) -> bool:
    """该值带了个不该有的单位 → 说明列映射错了或数据串列。

    只在**有单位且与期望不符**时报错。没有单位一律放行——表里写裸 ``4`` 是常态。
    """
    if n is None or not n.ok:
        return False
    if not n.unit:
        return False
    return n.unit != expected


def run_match(
    rows: list[dict[str, Any]],
    slots: dict[str, Any] | None,
    action: MatchAction | None = None,
    *,
    people_key: str = "people",
    days_key: str = "days",
    budget_key: str = "budget",
    # ⚠️ 以下是**新增的关键字参数，位置参数一个不动**。
    # rows / slots / action 的顺序与默认值一律不许动，people_key / days_key /
    # budget_key 也不许动（test_scene_matcher.py 有 29 条靠这三个默认值通过，
    # api 层与 channels 层都是关键字传参）。谁想「顺便整理一下参数顺序」，
    # 等于同时改 30 个 matcher 用例 + 11 个 /run 用例，直接撞 R1 红线。
    unit_by_slot: dict[str, str] | None = None,
) -> MatchResult:
    """跑一次匹配。

    ``rows`` 是原始行（``{列key: 原值}`` 再加一个 ``id``）。
    ``slots`` 是用户条件，允许整体为 None（等价于「没有任何条件」）。

    ``unit_by_slot``：槽位 → 期望单位的**可选覆盖**，三级回落的第一级：
      ① 这里显式传的 → ② 槽位声明里的 ``unit`` 由调用方解析后并入本参数
      → ③ 不传/未覆盖时用 ``_EXPECTED_UNIT_BY_SLOT`` 的三个默认。

    实际行为在 P0 等价于「传了就覆盖，没传用默认」——「从槽位声明读 unit」
    这一步在调用方（``scene_modules.channels.unit_by_slot_of``）完成，
    matcher 只认这个扁平 dict，不回头去读 ``Scene.slots_json``（它拿不到
    ``Scene``，也不该拿）。
    """
    action = action or MatchAction()
    slots = slots or {}

    # 三级回落在这里落地：显式传的优先，缺的用默认常量补齐。
    # 不修改入参（调用方可能复用同一个 dict），也不修改模块级常量。
    expected_units: dict[str, str] = dict(_EXPECTED_UNIT_BY_SLOT)
    if unit_by_slot:
        expected_units.update(
            {
                str(key): str(unit)
                for key, unit in unit_by_slot.items()
                if str(key).strip() and str(unit).strip()
            }
        )

    def _val(row: dict[str, Any], key: str) -> Any:
        # 行里允许有嵌套的 norm 结构，但优先取原始值让 normalize 再走一遍：
        # 原值是唯一可信来源，缓存的归一化结果可能是旧版本算的
        return row.get(key)

    total = len(rows)
    steps: list[MatchStep] = []

    # ① 归一化
    normalized: list[MatchRow] = []
    unconvertible = 0
    converted = 0
    partial = 0
    wrong_unit = 0
    for row in rows:
        p = normalize(_val(row, people_key))
        d = normalize(_val(row, days_key))
        b = normalize(_val(row, budget_key))
        # 只跳过「关键列坏掉」的行；人数/天数缺省仍保留，由后面各层决定
        if b is None or not b.ok:
            unconvertible += 1
            continue
        # 列里带了不该有的单位，说明表头映射错了（把天数列指给了人数）。
        # 这种行不能放进来：数值可能碰巧对上，给出一个完全错误的方案。
        #
        # 期望单位取自上面算好的 expected_units（显式覆盖 → 默认常量）。
        # 存量调用不传 unit_by_slot 时，它逐字等于 _EXPECTED_UNIT_BY_SLOT。
        if (
            _wrong_unit(p, expected_units.get("people", ""))
            or _wrong_unit(d, expected_units.get("days", ""))
            or _wrong_unit(b, expected_units.get("budget", ""))
        ):
            wrong_unit += 1
            continue
        if p is None or d is None:
            partial += 1
        if b.converted:
            converted += 1
        normalized.append(
            MatchRow(
                id=_row_id(row, len(normalized)),
                row=row,
                np=p,
                nd=d,
                nb=b,
                conf=_as_float(row.get("conf"), 0.0),
            )
        )

    drop_parts = []
    if unconvertible:
        drop_parts.append(f"跳过 {unconvertible} 行无法解析")
    if wrong_unit:
        drop_parts.append(f"{wrong_unit} 行单位与列不符")
    if partial:
        drop_parts.append(f"{partial} 行人员/天数缺失")
    steps.append(
        MatchStep(
            key="normalize",
            label="归一化",
            detail=f"{converted} 行单位换算（8千→8000）" if converted else "数值 + 单位解析",
            from_=total,
            to=len(normalized),
            drop_text="，".join(drop_parts),
            ratio=(len(normalized) / total) if total else 0.0,
        )
    )

    # ② 人数硬约束
    slot_people = normalize(slots.get("people"))
    if slot_people is not None and not slot_people.ok:
        slot_people = None

    def _pass_people(r: MatchRow) -> bool:
        if slot_people is None:
            return True  # 槽位缺 → 全放行
        if r.np is None or not r.np.ok:
            return False  # 行值坏 → 淘汰（不能当成匹配）
        if unit_conflict(slot_people, r.np):
            return False
        return abs(slot_people.num - r.np.num) < 1e-9

    after_people = [r for r in normalized if _pass_people(r)]
    dropped = len(normalized) - len(after_people)
    steps.append(
        MatchStep(
            key="people",
            label="人数硬约束",
            detail=(
                f"必须等于 {format_number(slot_people.num)} 人，"
                f"4 人团不能给 6 人方案"
                if slot_people
                else "未填人数，跳过该层"
            ),
            from_=len(normalized),
            to=len(after_people),
            drop_text=f"淘汰 {dropped} 行" if dropped else "",
            ratio=(len(after_people) / total) if total else 0.0,
        )
    )

    # ③ 天数 ±N
    slot_days = normalize(slots.get("days"))
    if slot_days is not None and not slot_days.ok:
        slot_days = None
    if slot_days is not None:
        after_days = [
            r
            for r in after_people
            if r.nd is not None
            and r.nd.ok
            and abs(slot_days.num - r.nd.num) <= action.days_tolerance
        ]
    else:
        after_days = after_people
    dropped = len(after_people) - len(after_days)
    if slot_days is not None:
        lo = format_number(slot_days.num - action.days_tolerance)
        hi = format_number(slot_days.num + action.days_tolerance)
        bad = format_number(slot_days.num + action.days_tolerance + 1)
        day_detail = f"{format_number(slot_days.num)} 天可接受 {lo}~{hi} 天，但不能是 {bad} 天"
    else:
        day_detail = "未填天数，跳过该层"
    steps.append(
        MatchStep(
            key="days",
            label=f"天数 ±{action.days_tolerance}",
            detail=day_detail,
            from_=len(after_people),
            to=len(after_days),
            drop_text=f"淘汰 {dropped} 行" if dropped else "",
            ratio=(len(after_days) / total) if total else 0.0,
        )
    )

    # ④ 相对偏差打分 + 闸门
    slot_budget = normalize(slots.get("budget"))
    if slot_budget is not None and not slot_budget.ok:
        slot_budget = None

    # 槽位 <= 0 不能做比率：除零得 inf/nan，会静默污染整张排序。
    # 负数同样不接受——预算不可能为负，出现即视为脏输入。
    days_base = slot_days.num if (slot_days and slot_days.num > 0) else None
    budget_base = slot_budget.num if (slot_budget and slot_budget.num > 0) else None
    invalid_budget = bool(slot_budget and slot_budget.num <= 0)

    w_d = action.days_weight
    w_b = action.budget_weight
    w_sum = w_d + w_b
    if w_sum <= 0:
        w_d, w_b, w_sum = 1.5, 1.0, 2.5

    scored: list[MatchRow] = []
    for r in after_days:
        days_dev = (
            abs(days_base - r.nd.num) / days_base if (days_base and r.nd and r.nd.ok) else 0.0
        )
        budget_dev = (
            abs(budget_base - r.nb.num) / budget_base if (budget_base and r.nb) else 0.0
        )
        score = (w_d * days_dev + w_b * budget_dev) / w_sum
        r.days_dev = days_dev
        r.budget_dev = budget_dev
        r.score = score
        scored.append(r)

    # nan 绝不会通过 <= 比较，会静默消失；显式过滤保证「异常行被淘汰」而非「结果变少」
    gated: list[MatchRow] = []
    nan_count = 0
    for r in scored:
        if not math.isfinite(r.score):
            nan_count += 1
            continue
        if r.score <= action.max_score:
            gated.append(r)
    gate_out = len(scored) - len(gated)

    if invalid_budget:
        score_detail = "预算非正数，无法计算偏差，本次只按天数排序"
    elif nan_count:
        score_detail = (
            f"天数权重 {format_number(w_d)} / 预算权重 {format_number(w_b)}，"
            f"{nan_count} 行无法计算偏差被淘汰"
        )
    else:
        score_detail = (
            f"天数权重 {format_number(w_d)} / 预算权重 {format_number(w_b)}，"
            f"超过 {format_number(action.max_score)} 视为完全不相关"
        )
    steps.append(
        MatchStep(
            key="score",
            label="相对偏差打分",
            detail=score_detail,
            from_=len(after_days),
            to=len(gated),
            drop_text=f"闸门淘汰 {gate_out} 行" if gate_out else "",
            ratio=(len(gated) / total) if total else 0.0,
        )
    )

    # ⑤ 排序：同分按预算升序（同等偏差下先看便宜的）
    ranked = sorted(gated, key=lambda r: (r.score, r.nb.num if r.nb else 0.0))

    reranked = False
    model_used = False
    if action.use_decision_model and ranked:
        before = [r.id for r in ranked]
        model_used = True
        for r in ranked:
            r.rule_norm = 1 - min(r.score, 1.0)
            r.fused = action.rule_weight * r.rule_norm + (1 - action.rule_weight) * r.conf
        ranked.sort(key=lambda r: -(r.fused if r.fused is not None else 0.0))
        reranked = before != [r.id for r in ranked]

    steps.append(
        MatchStep(
            key="topk",
            label=f"取 top-{action.top_k}",
            detail="同分时预算更低者优先",
            from_=len(ranked),
            to=min(action.top_k, len(ranked)),
            drop_text="",
            ratio=(min(action.top_k, len(ranked)) / total) if total else 0.0,
        )
    )

    return MatchResult(
        steps=steps,
        ranked=ranked,
        all_scored=sorted(scored, key=lambda r: r.score),
        hits=ranked[: action.top_k],
        total=total,
        normalized_count=len(normalized),
        unconvertible=unconvertible,
        gate_out=gate_out,
        nan_count=nan_count,
        reranked=reranked,
        model_used=model_used,
        invalid_budget=invalid_budget,
    )