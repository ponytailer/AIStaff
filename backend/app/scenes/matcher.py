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
    # 人数容差。**默认 0 = 严格相等**，这是业务上的常规预期
    # （4 人团不能给 6 人方案）。配成 >0 才放宽，且放宽后命中的行会在
    # 步骤漏斗里被单独计数（`people_widened`），不做静默放宽。
    people_tolerance: int = 0
    # 超过这个分数视为完全不相关，直接淘汰（而不是排在最后）
    max_score: float = 2.0
    top_k: int = 3
    # 决策模型融合分里规则分的权重
    rule_weight: float = 0.5
    use_decision_model: bool = False
    # 空结果策略。**三态，与前端的下拉一一对应**（`SceneEditor` 的
    # 「完全没有命中时」）：
    #
    #   nearest → 给差距最小的一批参考（标注为「不是符合的」）+ 放宽建议
    #   clarify → 不给近似项，反过来问用户能不能放宽，并给出放宽建议
    #   none    → 只说明没有结果，不给近似项、不给建议按钮
    #
    # 历史坑：前端下拉的第三个值写的是 `nothing`，而后端只认 `none`，
    # 用户选了「只说明没有结果」会被 `_as_choice` 静默回落成 `nearest` ——
    # 界面上选项变了、库里也存了，运行行为却一模一样。现在两边都收
    # `none`（`nothing` 作为旧值别名兜着），并在 `_ON_EMPTY_ALIASES` 里说明。
    on_empty: str = "nearest"

    @classmethod
    def from_json(cls, data: dict[str, Any] | None) -> MatchAction:
        data = data or {}
        defaults = cls()
        return cls(
            days_weight=_as_float(data.get("days_weight"), defaults.days_weight),
            budget_weight=_as_float(data.get("budget_weight"), defaults.budget_weight),
            days_tolerance=_as_int(data.get("days_tolerance"), defaults.days_tolerance),
            # 负容差没有意义，钳到 0，否则 abs(diff) <= -1 恒 False → 全灭且无解释
            people_tolerance=max(0, _as_int(data.get("people_tolerance"), defaults.people_tolerance)),
            max_score=_as_float(data.get("max_score"), defaults.max_score),
            top_k=max(1, _as_int(data.get("top_k"), defaults.top_k)),
            rule_weight=_as_float(data.get("rule_weight"), defaults.rule_weight),
            use_decision_model=bool(data.get("use_decision_model", False)),
            on_empty=_as_choice(
                _normalise_on_empty(data.get("on_empty")),
                defaults.on_empty,
                ("nearest", "clarify", "none"),
            ),
        )


#: `on_empty` 的历史别名 → 现取值。
#:
#: 前端下拉曾经写的是 `nothing`（`SceneEditor.tsx` 的 `<option value="nothing">`），
#: 而后端 `_as_choice` 的白名单里是 `none`。于是「只说明没有结果」这一档
#: 在运行时被静默回落成 `nearest` —— 配置存进去了、界面也回显正常，就是
#: 行为不变。别名表让**已经存进库的老配置**也能正确生效，不用写迁移脚本。
_ON_EMPTY_ALIASES: dict[str, str] = {"nothing": "none", "": ""}


def _normalise_on_empty(value: Any) -> str:
    text = str(value or "").strip().lower()
    return _ON_EMPTY_ALIASES.get(text, text)


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
    # 被人数容差（people_tolerance>0）放宽才进来的行数。默认 0 = 严格模式，
    # 与历史行为一致。>0 时上层必须在文案/卡片里告诉用户「放宽了人数」。
    people_widened: int = 0
    # 空结果时若 on_empty="nearest"，这里给差距最小的一批（不当作命中）。
    nearest: list[MatchRow] = field(default_factory=list)
    # 每行的人数 / 天数 / 预算三元组（三列都有效的行）。
    #
    # 供空结果建议按钮算出**能命中**的成套取值（`channels._rerun_patch`）。
    #
    # 为什么要整行、而不是各列分别给一份候选值：单列候选只保证「这个值在表里
    # 存在」，不保证**组合**能命中。真实案例：3 人 / 4 天 空结果，people 列里
    # 有 4、days 列里有 5，但「4 人 4 天」这个组合在表里根本不存在 —— 只改
    # 人数等于没改，用户点完还是空。
    #
    # 为什么不在 `channels.py` 里自己扫表：能在某一层之后还活着的行，只有
    # matcher 知道（它逐层过滤）。在别处重算等于把过滤逻辑实现第二遍，两边
    # 一旦漂移，按钮就会给出「改成 6 天」但 6 天其实也没结果 —— 那比不给
    # 建议更坏，用户会以为系统在骗他。
    row_combos: list[dict[str, float]] = field(default_factory=list)

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


def _as_choice(value: Any, default: str, allowed: tuple[str, ...]) -> str:
    """枚举字段：不认识的取值一律回落默认，不让脏配置漏到运行期。"""
    text = str(value or "").strip().lower()
    return text if text in allowed else default


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
            # 标签是**给用户看的**，不是给开发者看的。
            #
            # 原先是「归一化」—— 工程内部词，用户读不懂。漏斗出现在
            # 聊天里的空结果卡上（`SceneEmptyCard`），看到「归一化 / 人数硬约束 /
            # 相对偏差打分 / 取 top-3」的普通用户只会觉得「这是在给我看日志吗」。
            #
            # 改成语义直白的「读表里的数据」，与下面各层的「筛选行数」形成
            # 一条可读的链：读进来 5 行 → 人数对上 0 行。
            #
            # ⚠️ 试跑面板（`SceneEditor` 的 RunPanel）读的是同一个 `label`，
            # 所以管理员看到的也一起变了。这是有意的 —— 管理员也需要看懂
            # 自己在调什么，而不是背「归一化」这个词。
            label="读表",
            detail=f"{converted} 行单位换算（8千→8000）" if converted else "数值 + 单位解析",
            from_=total,
            to=len(normalized),
            drop_text="，".join(drop_parts),
            ratio=(len(normalized) / total) if total else 0.0,
        )
    )

    # ② 人数约束（默认严格相等；配了 people_tolerance 才放宽）
    slot_people = normalize(slots.get("people"))
    if slot_people is not None and not slot_people.ok:
        slot_people = None

    people_tol = max(0, int(action.people_tolerance))
    # 被容差放进来、但人数并不相等的行。必须单独计数上报，
    # 不能混进「精确命中」里 —— 用户填 4 人拿到 6 人方案，
    # 如果界面不说是放宽来的，他会以为系统算错了。
    people_widened_ids: list[str] = []

    def _pass_people(r: MatchRow) -> bool:
        if slot_people is None:
            return True  # 槽位缺 → 全放行
        if r.np is None or not r.np.ok:
            return False  # 行值坏 → 淘汰（不能当成匹配）
        if unit_conflict(slot_people, r.np):
            return False
        diff = abs(slot_people.num - r.np.num)
        if diff < 1e-9:
            return True
        if people_tol and diff <= people_tol + 1e-9:
            people_widened_ids.append(r.id)
            return True
        return False

    after_people = [r for r in normalized if _pass_people(r)]
    dropped = len(normalized) - len(after_people)
    if slot_people is None:
        people_detail = "未填人数，跳过该层"
        people_label = "人数"
    elif people_tol:
        people_detail = (
            f"{format_number(slot_people.num)} 人可接受 "
            f"{format_number(slot_people.num - people_tol)}~"
            f"{format_number(slot_people.num + people_tol)} 人"
            f"（已配置容差 ±{people_tol}）"
        )
        # ⚠️ 不要写成「人数 ±1」。±N 是配置的样子，不是用户关心的东西：
        # 用户只想知道「我要 4 人，表里有几行能满足」。容差多少已经在
        # `detail` 里写全（展开可见），标签统一成「人数对上」，
        # 与下一层「天数对上」句式一致，三层连起来读是一句话：
        #   读表 → 人数对上 → 天数对上
        people_label = "人数对上"
    else:
        people_detail = (
            f"必须等于 {format_number(slot_people.num)} 人，"
            f"4 人团不能给 6 人方案"
        )
        # 「人数硬约束」是配置术语，用户看到会以为在做技术校验。
        # 直接说「人数对上」—— 与下一层「天数对上」句式一致，读起来是一条链：
        #   读表 5 → 人数对上 0
        people_label = "人数对上"
    steps.append(
        MatchStep(
            key="people",
            label=people_label,
            detail=people_detail,
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
            # 原先是「天数 ±1」。±N 是**配置的样子**，不是用户关心的东西：
            # 用户只想知道「我要 5 天，表里有几行能满足」。所以标签改成
            # 「天数对上」，容差多少留给 `detail`（展开可见，不占主视觉）。
            #
            # 这也让三层标签成为一句话：读表 → 人数对上 → 天数对上。
            label="天数对上",
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
            # 「相对偏差打分」是在描述算法，用户读不出「所以呢」。
            # 这一层实际做的是：按预算接近程度排序，并把差太多的整行剔除。
            # 标签说「预算接近」，detail 里保留权重/阈值的完整口径。
            label="预算接近",
            detail=score_detail,
            from_=len(after_days),
            to=len(gated),
            drop_text=f"淘汰 {gate_out} 行" if gate_out else "",
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
            # 「取 top-3」是 SQL 语言的写法。这一层对用户的意思是
            # 「最多给你看几条」，所以标签说「最终给出」。
            label="最终给出",
            detail=f"最多 {action.top_k} 条，同分时预算更低者优先",
            from_=len(ranked),
            to=min(action.top_k, len(ranked)),
            drop_text="",
            ratio=(min(action.top_k, len(ranked)) / total) if total else 0.0,
        )
    )

    hits = ranked[: action.top_k]

    # ⑥ 漏斗截断：某一层归零后，后面的层不可能再有行进来（只会继续 0 → 0）。
    #
    # 这是「用户看不懂」的第二大来源。截图里三行连着的
    #     0 → 天数 ±1
    #     0 → 相对偏差打分
    #     0 → 取 top-3
    # 全部是**必然的 0**，读起来像「系统又拒了我三次」，实际只有第一行
    # （人数 5→0）有信息量。这几行还占了卡片一半高度。
    #
    # 所以：第一层归零之后，**只保留它自己**，后续步骤整段丢掉。
    # 为什么不在前端裁：试跑面板（`SceneEditor` 的 RunPanel）读的是同一份
    # steps，管理员看「归零之后的步骤还在跑」是**有意义的**（能看出流程
    # 走完了、没崩）。把裁剪放在产出侧会让两边都少信息。
    #
    # 所以裁剪放在 `channels.py` 组装 `empty` 块时做（见 `_visible_funnel`），
    # matcher 原样返回完整 steps。此处只留注释，不改数据结构 ——
    # `detail.steps` 与 `trace` 都还要完整版给排障用。

    # ⑦ 空结果策略：`on_empty` 决定给不给近似项。
    #
    # 注意这里的 `nearest` **不是命中**：它不进 `hits`、`status` 仍是 no_match、
    # 文案也必须说清「这些不是符合的，是最接近的」。把它当命中返回会让
    # 用户拿到一个根本不满足条件的推荐，比没有推荐更糟。
    #
    # 只有 `nearest` 才产出近似项；`clarify` / `none` 一律为空 —— 它们的
    # 区别不在 matcher，而在 `channels.py` 怎么组织正文（反问 / 只报空）。
    # 这样 matcher 里只有一个 if，语义边界清楚。
    #
    # 排序依据是 score（已算好的相对偏差），淘汰在各层之前就发生的行
    # （比如人数被硬约束筛掉的）**不在 nearest 里** —— 它们连打分都没进过，
    # 硬凑进来反而误导。
    nearest: list[MatchRow] = []
    if not hits and str(action.on_empty) == "nearest":
        nearest = sorted(scored, key=lambda r: r.score)[: action.top_k]

    # 每一行的人数 / 天数 / 预算三元组（只留三列都有效的行）。
    #
    # 供空结果建议按钮算出**能命中**的成套取值（`channels._rerun_patch`）。
    #
    # 为什么要整行、而不是各列分别给一份候选值：单列候选只保证「这个值在表里
    # 存在」，不保证**组合**能命中。真实案例：3 人 / 4 天 空结果，people 列里
    # 有 4、days 列里有 5，但「4 人 4 天」这个组合在表里根本不存在 —— 只改
    # 人数等于没改，用户点完还是空。
    #
    # 为什么不在 `channels.py` 里自己扫表：能在某一层之后还活着的行，只有
    # matcher 知道（它逐层过滤）。在别处重算等于把过滤逻辑实现第二遍，两边
    # 一旦漂移，按钮就会给出「改成 6 天」但 6 天其实也没结果 —— 那比不给
    # 建议更坏，用户会以为系统在骗他。
    #
    # 口径是 `normalized`（全部行）而不是逐层过滤后的：用户点按钮的语义是
    # 「换个条件重新筛」，候选必须来自全表，不能被当前条件先筛一遍。
    row_combos: list[dict[str, float]] = [
        {"people": r.np.num, "days": r.nd.num, "budget": r.nb.num}
        for r in normalized
        if r.np is not None
        and r.np.ok
        and r.nd is not None
        and r.nd.ok
        and r.nb is not None
        and r.nb.ok
    ]

    return MatchResult(
        steps=steps,
        ranked=ranked,
        all_scored=sorted(scored, key=lambda r: r.score),
        hits=hits,
        total=total,
        normalized_count=len(normalized),
        unconvertible=unconvertible,
        gate_out=gate_out,
        nan_count=nan_count,
        reranked=reranked,
        model_used=model_used,
        invalid_budget=invalid_budget,
        people_widened=len(people_widened_ids),
        nearest=nearest,
        row_combos=row_combos,
    )
