"""场景（Scene）的请求/响应模型。

v3 后场景是「module 实例」：``scene_type``（四选一）+ ``module_key``（前端渲染目录）
+ 配置 + **0..N 张私有数据表**（``tables`` / ``table_ids``）。
字段命名与 ``docs/scenes/scene-v2-arch.md`` §4.1 一一对应，
前端 ``src/api/scenes.ts`` 里有同构的类型定义。

⚠️ ``table_id``（单值）已被删除，改成 ``tables``（建/改，写）与 ``table_ids``（读）。
这两个名字**不再是同一个字段的两种写法**：``tables`` 是请求侧的表 id 有序列表
（顺序即 ``order_index``），``table_ids`` 是响应侧的只读回填。删掉单值是因为
v3 允许多表合并（PRD §12），而单值表达不了「表顺序」这件事。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SceneStatus = Literal["draft", "published", "archived"]

#: 场景类型（与 ``scene_modules.types.SceneType`` 同构）。
#: 刻意在这里再写一遍而不是 import：schema 层是纯 pydantic 契约，
#: 不依赖运行期包，这样前端从 OpenAPI 生成的类型不会牵出内部模块。
SceneTypeLiteral = Literal["table_match", "sop_flow", "handoff", "script"]


# ============================================================
# 数据表
# ============================================================


class SceneColumn(BaseModel):
    """一列的定义。type 决定前端用什么控件编辑、匹配时怎么比较。"""

    key: str
    label: str = ""
    type: Literal["number", "text", "url", "date"] = "text"
    # 该列在表里通常带什么单位（人/天/元），导入时用来校验列映射是否正确
    unit: str = ""
    aliases: list[str] = Field(default_factory=list)
    required: bool = False
    filterable: bool = False
    order: int = 0


class SceneQualityIssue(BaseModel):
    """导入时检出的质量问题。必须在界面上明确告知，不能静默修掉。"""

    level: Literal["error", "warning", "info"] = "warning"
    code: str = ""
    message: str = ""
    column: str = ""
    row_count: int = 0


class SceneTableRead(BaseModel):
    id: str
    tenant_id: str
    #: 归属场景。空串 = v2 及以前没有归属的孤儿表（前端可据此提示「未挂到场景」）
    scene_id: str = ""
    #: 合并池内的次序（多表时按它拼行，保证结果可复现）
    order_index: int = 0
    name: str
    source_filename: str = ""
    columns: list[SceneColumn] = Field(default_factory=list)
    quality: list[SceneQualityIssue] = Field(default_factory=list)
    row_count: int = 0
    status: str = "ready"
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class SceneTablePreviewRow(BaseModel):
    row_index: int
    values: dict[str, Any]


class SceneTablePreview(BaseModel):
    table: SceneTableRead
    rows: list[SceneTablePreviewRow] = Field(default_factory=list)


# ============================================================
# 场景本体
# ============================================================

DEFAULT_TRIGGER: dict[str, Any] = {
    "shortcut": True,
    "shortcut_label": "",
    "examples": [],
    "keywords": [],
    "require_slots": True,
    "bypass_llm_router": True,
}

DEFAULT_MATCH_ACTION: dict[str, Any] = {
    "days_weight": 1.5,
    "budget_weight": 1.0,
    "days_tolerance": 1,
    # 人数容差。0 = 严格相等（默认，4 人团不给 6 人方案）；
    # >0 时放宽，且命中的行会在正文里声明「人数是按容差放宽的」。
    "people_tolerance": 0,
    "max_score": 2.0,
    "top_k": 3,
    "rule_weight": 0.5,
    "use_decision_model": False,
    # 空结果策略：nearest = 给最接近的一批参考（标注为「不是符合的」）；
    # none = 只报空。这个字段以前是死配置，现在 channels 真的读了。
    "on_empty": "nearest",
}


class SceneCreateRequest(BaseModel):
    """新建场景。

    ``tables`` 是**有序**表 id 列表——顺序即合并池的 ``order_index``，
    所以不能换成 set。允许为空：``table_match`` 是 ``optional`` 档，
    「先建场景、绑员工、后补表」是管理员最自然的操作顺序（PRD §10.3 第 11 条）。
    """

    tenant_id: str
    name: str = Field(min_length=1, max_length=80)
    description: str = ""
    icon: str = ""
    #: 四选一，决定走 channels 的哪个处理通道
    scene_type: SceneTypeLiteral = "table_match"
    #: 前端渲染目录名。留空则按 ``scene_type`` 预填 ``generic.*``
    module_key: str = ""
    #: 0..N 张私有数据表（有序）
    tables: list[str] = Field(default_factory=list)
    status: SceneStatus = "draft"
    # 绑定到哪个员工；空表示只建场景不绑定（之后可在员工档案里挂）
    agent_id: str | None = None
    trigger: dict[str, Any] = Field(default_factory=lambda: dict(DEFAULT_TRIGGER))
    slots: list[dict[str, Any]] = Field(default_factory=list)
    match_action: dict[str, Any] = Field(default_factory=lambda: dict(DEFAULT_MATCH_ACTION))
    respond_action: dict[str, Any] = Field(default_factory=dict)
    shortcut: dict[str, Any] = Field(default_factory=dict)
    #: ``{schema_version, params, fallback_text}``。**不放 module_key 冗余**（决策 2）
    ui_config: dict[str, Any] = Field(default_factory=dict)
    #: 模块私有参数，框架只透传不解释
    module_config: dict[str, Any] = Field(default_factory=dict)
    #: 类型专属配置：sop_flow 的步骤 / handoff 的参数 / script 的话术表。
    #: 各占一个字段而不是塞进一个万能 config：类型切换时旧类型的配置必须保留，
    #: 合并容器会让它们互相覆盖。
    flow: dict[str, Any] = Field(default_factory=dict)
    handoff: dict[str, Any] = Field(default_factory=dict)
    scripts: list[dict[str, Any]] = Field(default_factory=list)


class SceneUpdateRequest(BaseModel):
    """改场景。所有字段 ``None`` = 不改；**显式传 ``tables`` 才会覆盖表归属**。

    ``tables`` 用「传了才动」而不是「空列表即清空」会让人踩坑——
    这里选择「传空列表 = 清空全部表」，因为清空是有意义的操作（切类型到
    ``script`` 后不再用表），而 ``None`` 已经足够表达「这次不改」。
    """

    tenant_id: str
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = None
    icon: str | None = None
    scene_type: SceneTypeLiteral | None = None
    module_key: str | None = None
    #: 传了才动（整体覆盖语义，顺序即 order_index）
    tables: list[str] | None = None
    status: SceneStatus | None = None
    trigger: dict[str, Any] | None = None
    slots: list[dict[str, Any]] | None = None
    match_action: dict[str, Any] | None = None
    respond_action: dict[str, Any] | None = None
    shortcut: dict[str, Any] | None = None
    ui_config: dict[str, Any] | None = None
    module_config: dict[str, Any] | None = None
    flow: dict[str, Any] | None = None
    handoff: dict[str, Any] | None = None
    scripts: list[dict[str, Any]] | None = None


class SceneRead(BaseModel):
    id: str
    tenant_id: str
    name: str
    description: str = ""
    icon: str = ""
    status: str = "draft"
    # ---- v3 模块实例身份 ----
    scene_type: str = "table_match"
    module_key: str = ""
    module_version: int = 1
    ui_config: dict[str, Any] = Field(default_factory=dict)
    module_config: dict[str, Any] = Field(default_factory=dict)
    # ---- 数据表 ----
    #: 归属于本场景的表 id，按 ``order_index`` 升序。空列表是合法状态。
    table_ids: list[str] = Field(default_factory=list)
    # ---- 既有配置 ----
    trigger: dict[str, Any] = Field(default_factory=dict)
    slots: list[dict[str, Any]] = Field(default_factory=list)
    match_action: dict[str, Any] = Field(default_factory=dict)
    respond_action: dict[str, Any] = Field(default_factory=dict)
    shortcut: dict[str, Any] = Field(default_factory=dict)
    flow: dict[str, Any] = Field(default_factory=dict)
    handoff: dict[str, Any] = Field(default_factory=dict)
    scripts: list[dict[str, Any]] = Field(default_factory=list)
    # 「这个场景挂在哪些员工上」——由 AgentResourceBinding 反查得出
    agent_ids: list[str] = Field(default_factory=list)
    #: 定义器侧的提示（表数量档位不满足等）。**只提示不放行**，
    #: 真正的阻断在 create/update 里已经 raise，这里给前端做角标文案。
    warnings: list[str] = Field(default_factory=list)
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


# ============================================================
# 试跑
# ============================================================


class SceneRunRequest(BaseModel):
    tenant_id: str
    # 试跑用表单值，不落库
    slots: dict[str, Any] = Field(default_factory=dict)
    use_decision_model: bool | None = None
    persist: bool = False
    #: 试跑时也允许带一句话（script 通道要靠它命中话术）
    message: str = ""


class SceneHitRead(BaseModel):
    row_id: str
    values: dict[str, Any]
    score: float = 0.0
    days_dev: float = 0.0
    budget_dev: float = 0.0
    fused: float | None = None
    #: 多表合并后「这一行来自哪张表」。单表时就是该表名，前端不需要判定。
    source_table: str = ""


class SceneRunRead(BaseModel):
    """试跑结果。

    ⚠️ **结构只能加字段，不能替换**：``hits`` / ``steps`` / ``empty_reason``
    被前端试跑面板（``SceneEditor.tsx`` 读 ``days_dev`` / ``budget_dev``）与
    11 个后端用例同时读。v3 的新块走**新增字段** ``ui_blocks``，
    不改任何既有字段的语义。
    """

    scene_id: str
    hits: list[SceneHitRead] = Field(default_factory=list)
    ranked: list[SceneHitRead] = Field(default_factory=list)
    steps: list[dict[str, Any]] = Field(default_factory=list)
    total: int = 0
    normalized_count: int = 0
    unconvertible: int = 0
    gate_out: int = 0
    reranked: bool = False
    model_used: bool = False
    invalid_budget: bool = False
    # 空结果时给前端的一句话解释（已量化差距，不是「没找到」）
    empty_reason: str = ""
    run_id: str = ""
    # ---- v3 新增（纯加法）----
    #: 「发生了什么」的块序列。前端按 ``module_key`` 选渲染器。
    #: 非 ``table_match`` 场景也可以有块（step / handoff / text），
    #: 但那时 ``hits`` / ``steps`` 是空的 —— 不要以为「没块 = 失败」。
    ui_blocks: list[dict[str, Any]] = Field(default_factory=list)
    #: ok | no_match | error。非 UI 渠道靠它判断该不该改文案。
    status: str = "ok"
    #: 渲染不出来时的纯文本兜底（非 UI 渠道只吃文本）
    text: str = ""
    #: 解析出的列映射（``people`` → ``人数``）。调策略时最常问的就是这个，
    #: 不给就只能让他自己数表头。仅 ``table_match`` 有值。
    column_map: dict[str, str] = Field(default_factory=dict)


# ============================================================
# 聊天端：这个员工能用哪些场景
# ============================================================


class AgentSceneShortcut(BaseModel):
    """聊天输入框上方的快捷按钮。"""

    scene_id: str
    label: str
    icon: str = ""
    scene_name: str = ""


class SceneModuleRead(BaseModel):
    """``GET /api/chat/scenes`` 的载荷：聊天端需要的字段**全部**，一个不多。

    刻意不带 ``trigger`` / ``slots`` / ``match_action`` / ``table_ids``：
    聊天端不需要，多给反而让人以为可以在聊天侧改配置。

    ``slots`` 是个例外——它不是配置，是「入口点开后立刻要画的表单字段定义」。
    由后端合并（module 的 ``required_slots`` + 实例 ``slots_json`` 覆盖），
    前端不该实现第二事实来源。
    """

    scene_id: str
    module_key: str = ""
    module_version: int = 1
    label: str = ""
    icon: str = ""
    #: ``send_text`` 型入口点击后要发的文本（实例可覆盖）
    send_text: str = ""
    #: ``open_form`` 型入口点击后立刻画的字段定义
    slots: list[dict[str, Any]] = Field(default_factory=list)
    scene_name: str = ""
    scene_type: str = "table_match"