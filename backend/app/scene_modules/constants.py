"""场景类型的元信息与默认 module 映射（唯一事实来源，后端侧）。

前端 ``src/scenes/types.ts`` 里有一份同构的 ``SCENE_TYPE_META``。
两份手抄必然漂，所以**必须有一条一致性测试**兜住 key 集合
（impl-map §5.1）。本文件是后端侧的唯一校验点，被建场景 / 发布校验 / 单测三处共用。

⚠️ 本 dict 里**只允许有 ``needs_table`` 一档**，不许出现 ``table_range`` /
``min_tables``。两个字段并存时前端读一个、后端读另一个，读不到的那个拿到
``None``，会被静默当成「这个类型不用表」→ ``table_match`` 的数据表区块整块
不渲染，**且不报错不抛异常**，最终表现为「新建查表场景时根本没有传表的地方」
这种无从排查的故障。``tests/test_scene_constants.py`` 直接断言这一点。
"""

from __future__ import annotations

import re
from typing import Any

from app.scene_modules.types import NeedsTable, SceneType

#: 一个场景最多挂多少张表。
#:
#: 这是**与类型无关的性能护栏**（PRD §12.3），三档通用 —— 所以它不在
#: ``SCENE_TYPE_META`` 里表达，也不要塞进档位语义。``table_match`` 是唯一能
#: 传多表的类型，也就是这条护栏实际只打中它；因此它必须排在
#: ``table_count_issues`` 的第一位，否则会被后面的 ``return []`` 放过。
MAX_TABLES_PER_SCENE = 20

#: 档位的严格程度排序。module 层只能"收紧不能放宽"就靠它比较（arch §4.1.3）。
NEEDS_TABLE_ORDER: dict[str, int] = {"none": 0, "optional": 1, "required": 2}

#: 类型层元信息。
#:
#: 字段语义（每档只对应一处判断，不要写特例分支）：
#:
#: =========== ============ ======== ================ ====
#:  needs_table 渲染表区块    数量下限  缺表时发布        上限
#: =========== ============ ======== ================ ====
#:  none        ❌            0        不校验            20
#:  optional    ✅            0        warning，不阻断    20
#:  required    ✅            ≥1       阻断              20
#: =========== ============ ======== ================ ====
SCENE_TYPE_META: dict[str, dict[str, Any]] = {
    "table_match": {"label": "查表推荐", "icon": "📊", "needs_table": "optional"},
    "sop_flow": {"label": "流程办理", "icon": "🧭", "needs_table": "none"},
    "handoff": {"label": "转人工", "icon": "🙋", "needs_table": "none"},
    "script": {"label": "固定话术", "icon": "💬", "needs_table": "none"},
}

#: 场景类型全集（``SceneType`` 的运行时形态，用于校验与穷尽性断言）
SCENE_TYPES: tuple[SceneType, ...] = ("table_match", "sop_flow", "handoff", "script")

#: 新建场景时按类型预填的 module_key。
#:
#: 为什么必须有这 4 个 generic module（不是可选优化）：没有它们，新建场景
#: 就必须先有一次前端开发，连「跑通一条链路看看效果」都做不到。它们让
#: 「不写代码也能建场景」这条路径继续存在 —— 只是不再是唯一路径。
DEFAULT_MODULE_BY_SCENE_TYPE: dict[str, str] = {
    "table_match": "generic.table_match",
    "sop_flow": "generic.sop_flow",
    "handoff": "generic.handoff",
    "script": "generic.script",
}

#: module_key 的格式约束：``<域>.<场景>``，点号命名，全局唯一。
#:
#: 为什么要求「至少一个点」：``table_match`` 这种裸单段必须被拒——否则
#: 「域」的分组能力消失，20 个 module 平铺在一层。``generic.*`` 与
#: ``travel.*`` 就是这个「域」的实际用法。
MODULE_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")


def validate_module_key(key: str) -> str | None:
    """校验 module_key 格式。返回错误文案；合法则返回 ``None``。"""
    text = str(key or "").strip()
    if not text:
        return "场景界面组件标识（module_key）不能为空"
    if not MODULE_KEY_RE.match(text):
        return (
            f"module_key「{text}」格式不对：应为 <域>.<场景>，"
            "只含小写字母、数字、下划线，且至少一个点"
        )
    return None


def needs_table_of(scene_type: str) -> NeedsTable:
    """取某场景类型的表数量档位。未知类型按最严格的 ``"none"`` 处理。

    为什么未知类型给 ``"none"`` 而不是 ``"required"``：``scene_type`` 有 DB
    默认值 ``"table_match"``，未知值只可能来自手工改库。此时不该因为「猜不出
    要几张表」就阻断保存 —— 真要阻断的是 ``dispatch_scene`` 的 unknown 分支，
    那里会降级成 text block 并明说「类型暂不支持」。
    """
    meta = SCENE_TYPE_META.get(str(scene_type or ""))
    if not meta:
        return "none"
    value = meta.get("needs_table")
    return value if value in NEEDS_TABLE_ORDER else "none"  # type: ignore[return-value]


def effective_needs_table(
    type_meta: dict[str, Any], module_meta: dict[str, Any] | None = None
) -> NeedsTable:
    """类型档位与 module 档位取**更严**的那个。

    module 层只能收紧、不能放宽（arch §4.1.3）：

    - ``optional → required`` 允许 —— 定制 module 没表画不出空态（``travel.itinerary``）
    - ``required → optional`` 不允许 —— 会把阻断降成 warning
    - ``optional → none`` 不允许 —— 会让传表区块静默消失

    实现上直接取 ``max`` 而不是「相信 module」，上面三条就自动成立，
    不需要逐个写特例分支。
    """
    raw_type = (type_meta or {}).get("needs_table")
    base: NeedsTable = (
        raw_type if raw_type in NEEDS_TABLE_ORDER else "none"  # type: ignore[assignment]
    )
    raw_module = (module_meta or {}).get("needs_table")
    if raw_module not in NEEDS_TABLE_ORDER:
        return base
    if NEEDS_TABLE_ORDER[base] >= NEEDS_TABLE_ORDER[raw_module]:
        return base
    return raw_module  # type: ignore[return-value]


def table_count_issues(needs: NeedsTable, n: int) -> list[str]:
    """表数量问题只在这里出。返回空列表 = 可以保存。

    ⚠️ **判断顺序不能倒**：上限必须排在最前。倒了会怎样：``optional`` + 21 张表
    在最后的 ``return []`` 处被放过 → 上限护栏对 ``table_match`` 完全失效。而
    ``table_match`` 是唯一能传多表的类型，也就是这个 bug 只会打中唯一用到它的
    场景，且不报错。``tests/test_scene_constants.py`` 用
    ``len(table_count_issues("optional", 21)) == 1`` 顶住它。

    最后那个 ``return []`` 是 ``optional`` 档的**全部价值**：``optional`` + 0 张表
    必须返回空列表（PRD §10.3 第 11 条「只 warning 不阻断」）。这是
    ``table_match`` 的默认档位，写错了会让「先建场景、绑员工、后补表」这条
    自然路径走不通 —— 而这是管理员最自然的操作顺序。
    """
    count = max(0, int(n or 0))
    if count > MAX_TABLES_PER_SCENE:
        return [f"一个场景最多 {MAX_TABLES_PER_SCENE} 张表，当前 {count} 张"]
    if needs == "required" and count == 0:
        return ["这个场景至少需要 1 张数据表"]
    return []


def table_count_warnings(needs: NeedsTable, n: int) -> list[str]:
    """不阻断、但要在定义器/发布检查里提示的问题。

    与 ``table_count_issues`` 严格互补：``issues`` 非空即阻断，本函数永不阻断。
    两者分开是为了让调用点只需判断「``issues`` 是否为空」就能决定放不放行，
    不必在同一个列表里区分 blocking / non-blocking。

    注意：本函数只判断「档位 + 数量」。「配了槽位却没表」这类要看
    ``slots_json`` 的提示，由**调用点**在拿到本函数返回值后再做一次过滤 ——
    不要把 ``has_slots`` 塞进来当参数：那会让本函数无法脱离调用点测试真实数据流，
    测试得先构造一个假的 ``has_slots``，测的就不是「配了槽位但没表」这个状态了。
    """
    count = max(0, int(n or 0))
    if needs == "optional" and count == 0:
        return ["这个场景还没有数据表，发布后用户触发时只会提示未配表"]
    if needs == "none" and count > 0:
        return [
            f"当前场景类型不使用数据表，{count} 张表已保留但不会生效"
            "（切换回查表推荐可继续使用）"
        ]
    return []


def default_module_key(scene_type: str) -> str:
    """按类型给默认 module_key；未知类型回落到 ``generic.table_match``。

    回落而不是报错：``scene_type`` 有 DB 默认值 ``"table_match"``，
    未知值只可能来自手工改库，给个能跑通的默认比 500 好。
    """
    return DEFAULT_MODULE_BY_SCENE_TYPE.get(
        str(scene_type or ""), DEFAULT_MODULE_BY_SCENE_TYPE["table_match"]
    )


__all__ = [
    "DEFAULT_MODULE_BY_SCENE_TYPE",
    "MAX_TABLES_PER_SCENE",
    "MODULE_KEY_RE",
    "NEEDS_TABLE_ORDER",
    "SCENE_TYPES",
    "SCENE_TYPE_META",
    "default_module_key",
    "effective_needs_table",
    "needs_table_of",
    "table_count_issues",
    "table_count_warnings",
    "validate_module_key",
]