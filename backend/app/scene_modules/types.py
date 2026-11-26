"""场景运行时的纯数据类型（无逻辑、无 IO）。

**这是前后端唯一的契约**。字段形状一旦改动就是 breaking change，
冻结级别见 ``docs/scenes/scene-v2-arch.md`` §2.2。

硬约束（PRD §7.5）：``SceneUiBlock`` **不许有** ``title`` / ``detail_fields`` /
``primary_action`` / ``color`` / ``layout`` 之类的字段。后端只产出
「发生了什么」（``kind`` + ``data``），不产出「怎么画」。一旦后端开始拼 UI
描述，整个方案就退回配置驱动，前端 module 的定制能力也被后端锁死。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

SceneType = Literal["table_match", "sop_flow", "handoff", "script", "tool_submit"]

#: block 的语义类型。注意：**不是 UI 形态**，而是「这块说的是什么事」。
#: 渲染成什么样由前端 module 的代码决定（PRD §7.5）。
BlockKind = Literal["text", "result", "empty", "step", "handoff", "form"]

#: 表数量档位（类型层 + module 层共用同三档）。
#:
#: - ``"none"``     —— 该类型不使用数据表（``sop_flow`` / ``handoff`` / ``script``）；
#:                     定义器**不渲染**数据表区块，数量下限 0，缺表发布不校验
#: - ``"optional"`` —— 有表更好但没有也行（``table_match``）；
#:                     定义器渲染数据表区块，下限 0，缺表发布只 warning **不阻断**
#: - ``"required"`` —— 必须有表；下限 ≥1，缺表**阻断**发布
#:
#: 上限 20 张与档位无关（性能护栏，见 ``MAX_TABLES_PER_SCENE``），
#: 所以这里**不表达上限**——把上限塞进档位会让三档变成六档。
NeedsTable = Literal["none", "optional", "required"]

#: 框架内置块（**后端永不产出**，由前端既有 metadata 通道合成）。
#: 与 ``BlockKind`` 的区别只有一条：**有 ``module_key`` 才查注册表**，
#: 没有 ``module_key`` 的走框架内置渲染器。
BuiltinBlockKind = Literal[
    "scheduled_task_draft",
    "suggested_actions",
    "dispatch",
    "team_progress",
    "harness_artifacts",
    "knowledge_citations",
]


@dataclass
class SceneUiBlock:
    """一条消息里的一块 UI。

    数组而非单值（arch §2.4）：一条消息可能同时有「引言 + 结果卡 + 追问」，
    旧的 ``TaskExecutionResult.ui_form`` 单值表达不了，且多帧同轮时
    「取最后一个」会丢掉前面帧的块。
    """

    #: 只允许 ``BlockKind``。后端**永不**产出 ``BuiltinBlockKind``。
    kind: BlockKind
    #: 该类型的结构化业务数据。形状由 ``kind`` 决定，见 arch §2.2
    data: dict[str, Any] = field(default_factory=dict)
    #: 从 scene 带过来，前端据此选渲染器
    module_key: str = ""
    module_version: int = 0
    #: block 级可选覆盖兜底文本；空则用场景级 ``fallback_text``
    fallback_text: str = ""

    def to_dict(self) -> dict[str, Any]:
        """给消息 metadata 用的 JSON 友好形态（与 dataclasses.asdict 等价，
        但显式列字段，避免将来加了内部字段被意外透出）。"""
        return {
            "kind": self.kind,
            "data": dict(self.data or {}),
            "module_key": self.module_key,
            "module_version": self.module_version,
            "fallback_text": self.fallback_text,
        }


@dataclass
class SceneRunResult:
    """一次场景执行的后端产物。

    ``awaiting_input`` 不在这里：需要收条件时通道直接产 ``form`` block，
    「还在等用户」这件事由 block 的 kind 表达，不需要第四个状态位。
    """

    blocks: list[SceneUiBlock] = field(default_factory=list)
    #: 正文（非 UI 渠道的唯一内容来源之一）
    text: str = ""
    #: 漏斗/仲裁等排障信息，落 ``SceneRun.trace_json``
    trace: list[dict[str, Any]] = field(default_factory=list)
    #: ok | no_match | error
    status: str = "ok"
    #: **兼容层明细，不是 block 契约的一部分**，也永不进消息 metadata。
    #:
    #: 为什么需要它：``SceneRunRead`` 的 ``hits`` / ``ranked`` / ``steps`` /
    #: ``total`` / ``unconvertible`` / ``empty_reason`` 等字段被前端试跑面板
    #: （``SceneEditor.tsx:1073-1113`` 读 ``days_dev`` / ``budget_dev``）与 11 个
    #: 后端用例同时读，**接口结构只能加字段不能替换**（impl-map §4 第 6 条）。
    #: 这些字段有的是 ``MatchRow`` 上的打分中间值，从 ``blocks`` 里反推不出来
    #: （``result`` block 的 ``items`` 只冻了 ``values``/``score``/``source_table``），
    #: 若在 API 层重建就等于把 matcher 再跑一遍、还可能算出第二个答案。
    #: 所以由 ``table_match`` 通道在生产时顺手透出，API 层原样转发。
    #:
    #: 判据：**只有 ``kind == "table_match"`` 会填**，其它通道留空 dict。
    detail: dict[str, Any] = field(default_factory=dict)
    #: ``persist=True`` 时写入的 ``SceneRun`` 主键；未落库为空串。
    #:
    #: 放在结果上而不是让调用方自己查：``run_scene_instance`` 是唯一知道
    #: 「这次到底落库了没有」的地方（空 ``module_key`` 时会跳过落库），
    #: 调用方再去猜就会猜错。
    run_id: str = ""
    #: 渲染参数（`scene.ui_config_json.params` 与预设合并后的最终值）。
    #:
    #: ## 为什么它不在 block 上
    #:
    #: block 契约（arch §2.2）明令不许带 UI 描述字段，`SceneUiBlock.to_dict()`
    #: 只透 5 个字段。但 params 是 module 的**入参**（按钮文案、列映射、价格说明），
    #: 不是 UI 结构描述 —— 它必须被送到前端，否则「改文案不用发版」是空话。
    #:
    #: 放在 result 上、由 `turn_run` 写进消息 metadata 的**顶层** `scene_params`
    #: 键：既不破坏 block 契约，又让一条消息的多个块共用同一份参数
    #: （它们本来就同属一个场景）。
    #:
    #: 消费方：`src/pages/chat/messageBlockSlots.ts::sceneParamsOf()`。
    render_params: dict[str, Any] = field(default_factory=dict)

    def to_blocks_dicts(self) -> list[dict[str, Any]]:
        """产出可直接写进消息 metadata 的 ``ui_blocks``。"""
        return [block.to_dict() for block in self.blocks]


@dataclass
class SceneChip:
    """聊天页入口胶囊（``GET /api/chat/scenes`` 的载荷）。

    刻意**没有** ``on_click``：入口行为由 module 的 ``meta.entry_behavior``
    声明（PRD §19 第 6 条），后端不持有这个事实——后端没有 module 的 meta。
    抄一份进 DB 会让「改了代码线上行为没变」且两处都看不到对方。
    """

    scene_id: str
    module_key: str
    module_version: int
    label: str
    icon: str = ""
    #: ``entry_behavior = 'send_text'`` 时要发的文本（实例可覆盖）
    send_text: str = ""
    #: ``entry_behavior = 'open_form'`` 时前端要立刻画的字段定义。
    #: 由「module 的 required_slots + 实例 slots_json 覆盖」合并而成——
    #: 只有后端能合并（实例配置在库里），前端不该实现第二事实来源。
    slots: list[dict[str, Any]] = field(default_factory=list)
    scene_name: str = ""
    scene_type: str = "table_match"


__all__ = [
    "BlockKind",
    "BuiltinBlockKind",
    "NeedsTable",
    "SceneChip",
    "SceneRunResult",
    "SceneType",
    "SceneUiBlock",
]