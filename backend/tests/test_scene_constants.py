"""``scene_modules`` 常量护栏。

这块是整块新增代码，既有 145 条测试零覆盖 —— 口径错误不会被任何既有用例顶出来。
``needs_table`` 与 ``table_range`` 并存的症状是「``table_match`` 的表区块静默消失」：
不抛异常、不打日志，只是定义器里没有传表入口。所以必须在这里直接断言。

同时锁住两个「改错了不会有别的测试变红」的点：
- ``table_count_issues`` 的上限判断必须排在 ``optional`` 的 ``return []`` 之前；
- ``optional`` + 0 张表必须返回空列表（否则「先建场景、后补表」这条路走不通）。
"""

from __future__ import annotations

import pytest

from app.scene_modules.constants import (
    NEEDS_TABLE_ORDER,
    SCENE_TYPE_META,
    SCENE_TYPES,
    effective_needs_table,
    needs_table_of,
    table_count_issues,
    table_count_warnings,
)

# ``table_count_issues`` 的实际归属是 ``constants``（它依赖 ``MAX_TABLES_PER_SCENE``
# 与 ``NEEDS_TABLE_ORDER``）。放在这里有唯一实现的好处：调用点只需
# ``from app.scene_modules.constants import table_count_issues``，不会出现
# 「channels 里有一份、constants 里有一份」的双实现漂移。


def test_scene_type_meta_field_uniqueness() -> None:
    """``SCENE_TYPE_META`` 里只允许 ``needs_table``，不许混入旧口径字段。"""
    for key, meta in SCENE_TYPE_META.items():
        assert "needs_table" in meta, f"{key} 缺 needs_table"
        assert "table_range" not in meta, f"{key} 混入了 table_range"
        assert "min_tables" not in meta, f"{key} 混入了 min_tables"
        assert meta["needs_table"] in ("none", "optional", "required")


def test_scene_type_meta_covers_all_scene_types() -> None:
    """``SceneType`` 的运行时全集与 meta 的 key 集合必须一致（穷尽性）。"""
    assert set(SCENE_TYPE_META) == set(SCENE_TYPES)


def test_table_match_is_optional() -> None:
    """锁住「区块要渲染 ∧ 0 张表不阻断」这个组合。

    改成 ``none`` → 区块整块消失；改成 ``required`` → 0 张表不能发布。
    两种改法都不抛异常，只会让「先建场景、绑员工、后补表」这条路走不通。
    """
    assert SCENE_TYPE_META["table_match"]["needs_table"] == "optional"


def test_only_table_match_renders_table_block() -> None:
    """另外三类一律 ``none`` —— 它们本来就不吃数据表。"""
    for key in ("sop_flow", "handoff", "script"):
        assert SCENE_TYPE_META[key]["needs_table"] == "none", key


def test_table_count_issues_optional_zero_is_empty() -> None:
    """``table_match`` 默认档 + 0 张表必须不阻断（PRD §10.3 第 11 条）。

    这条不是凑数：``optional`` 档的 ``return []`` 那一行是它的全部价值所在。
    写错（或日后被谁「顺手清理」掉）会让 ``table_match`` 场景**没表就不能发布**，
    而这正是管理员最自然的操作顺序。没有这条断言，删掉那行不会有任何测试变红。
    """
    assert table_count_issues("optional", 0) == []
    assert table_count_issues("required", 0) != []
    assert table_count_issues("none", 5) == []
    assert len(table_count_issues("optional", 21)) == 1


def test_table_count_issues_cap_applies_to_optional() -> None:
    """上限护栏必须对 ``optional`` 生效（判断顺序写反就会静默失效）。

    ``table_match`` 是唯一能传多表的类型，所以上限判断若被 ``return []`` 抢先，
    这条护栏就只对没有任何调用点的 ``required`` 生效 —— 等于不存在。
    """
    assert table_count_issues("optional", 20) == []
    assert table_count_issues("none", 21) != []

    # ↓ 这一行才是**唯一**顶住「判断顺序倒置」的断言。
    #    若上限判断被 ``return []`` 抢在前面（或被人搬到 ``optional`` 分支之后），
    #    ``optional`` + 21 会返回 ``[]``，上限护栏对 ``table_match`` 静默失效 ——
    #    而 ``table_match`` 是唯一能传多表的类型，等于护栏不存在。
    #    ``required`` + 21 **不能**用来检测顺序倒置，原因见下一条注释。
    assert table_count_issues("optional", 21) != []

    # 下面这行锁的是**文案归属**，不是判断顺序。
    # 数量已超上限时，报的必须是「最多 20 张」而不是「至少需要 1 张」——
    # 两者同时成立的场景里，后者会让用户完全不知道该做什么。
    # 它分辨不出两个 if 的先后：``required`` 分支要求 ``n == 0``，与 ``n == 21``
    # 互斥，那个分支根本不会进入，所以谁在前结果都一样。
    # 用等值断言而非 ``in``，连文案变化也能发现。
    assert table_count_issues("required", 21) == [
        "一个场景最多 20 张表，当前 21 张"
    ]


def test_table_count_warnings_never_block() -> None:
    """warning 与 blocking 严格互补：``optional`` + 0 张表只 warning。"""
    assert table_count_warnings("optional", 0) != []
    assert table_count_warnings("required", 0) == []  # 缺表走 blocking，不重复报
    assert table_count_warnings("none", 3) != []  # 表保留但不生效
    assert table_count_warnings("optional", 3) == []


def test_effective_needs_table_can_tighten_not_loosen() -> None:
    """module 层只能收紧、不能放宽（arch §4.1.3）。

    ``optional → required`` 允许（定制 module 没表画不出空态）；
    ``required → optional``、``optional → none`` 都不允许 —— 放宽会把阻断降成
    warning，或让传表区块静默消失。
    """
    optional_type = {"needs_table": "optional"}
    required_type = {"needs_table": "required"}
    none_type = {"needs_table": "none"}

    # 收紧：允许
    assert effective_needs_table(optional_type, {"needs_table": "required"}) == "required"
    assert effective_needs_table(none_type, {"needs_table": "optional"}) == "optional"
    # 放宽：不允许
    assert effective_needs_table(required_type, {"needs_table": "optional"}) == "required"
    assert effective_needs_table(optional_type, {"needs_table": "none"}) == "optional"
    # module 未声明：用类型档位
    assert effective_needs_table(optional_type, None) == "optional"
    assert effective_needs_table(optional_type, {}) == "optional"
    # module 声明了非法值：当作未声明
    assert effective_needs_table(optional_type, {"needs_table": "sometimes"}) == "optional"


def test_needs_table_order_is_total() -> None:
    """``NEEDS_TABLE_ORDER`` 必须是三条目的全序，否则 ``max`` 比较会出错。"""
    assert [NEEDS_TABLE_ORDER[k] for k in ("none", "optional", "required")] == [0, 1, 2]


@pytest.mark.parametrize("scene_type", list(SCENE_TYPES))
def test_needs_table_of_matches_meta(scene_type: str) -> None:
    """``needs_table_of`` 只是 ``SCENE_TYPE_META`` 的读取器，不能自带第二份口径。"""
    assert needs_table_of(scene_type) == SCENE_TYPE_META[scene_type]["needs_table"]


def test_needs_table_of_unknown_type_defaults_to_none() -> None:
    """未知类型按 ``none``：不因为「猜不出要几张表」就阻断保存。"""
    assert needs_table_of("not_a_type") == "none"
    assert needs_table_of("") == "none"