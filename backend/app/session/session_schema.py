from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.tools.tool_schema import ToolCall, ToolResult


RouterDecisionValue = Literal[
    "continue_active",
    "switch_to_pending",
    "create_pending",
    "update_pending",
    "complete_task",
    "start_new_task",
    "answer_only",
    "handoff_human",
    "clarify",
]
TaskFrameKind = Literal["sop", "conversation"]
TaskFrameExecutionTarget = Literal["self"]
TaskFrameRunStatus = Literal[
    "queued",
    "running",
    "awaiting_user",
    "blocked",
    "completed",
    "handoff",
    "failed",
    "cancelled",
]
MessageFeedbackValue = Literal["up", "down"]


class TaskFrame(BaseModel):
    task_id: Optional[str] = None
    status: str = "pending"
    skill_id: Optional[str] = None
    step_id: Optional[str] = None
    slots: dict[str, Any] = Field(default_factory=dict)
    intent_summary: Optional[str] = None
    source_turn_id: Optional[str] = None
    source_message: Optional[str] = None
    parent_task_id: Optional[str] = None
    resume_policy: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class PlannedTaskFrame(BaseModel):
    task_id: Optional[str] = None
    kind: TaskFrameKind = "conversation"
    status: TaskFrameRunStatus = "queued"
    decision: RouterDecisionValue = "answer_only"
    # conversation 帧分级执行模式（仅 kind=conversation 时有意义）：
    # - standard：完整 Harness 决策循环（缺省，行为与历史一致）
    # - direct_reply：问候/寒暄等简单对话，用问答模型直出回复，跳过 Harness
    # - capability_intro：能力咨询（你能做什么/介绍下自己），注入能力清单摘要
    #   + 人设后单次模型调用直出回复，跳过 Harness
    # - faq_hit：反馈自进化的 FAQ 词法命中，零 LLM 直接返回标准答案
    # - handoff_intent：用户明确要转人工（点按钮/手打「转人工」），固定话术
    #   + 直接建单，零 LLM、不检索知识库
    # - scene_module：命中管理员配置的场景实例（``scene_id`` 指定是哪一条）。
    #   执行走 ``scene_modules.run_scene_instance``，零 LLM、不检索知识库。
    #   注意：**这个值必须同时出现在 4 处白名单里**（本文件、planner._normalize、
    #   turn_run 的 light_execution_mode_by_frame_id、turn_run 的帧循环分支）。
    #   少一处不会有任何报错，只会表现为「点了按钮，等了很久，得到一段泛泛的回答」
    #   —— 因为帧被归一化回 ``standard`` 后跑完整 Harness 循环（12-60s）。
    # 缺省/非法值一律回退 standard，不劣于现状。
    execution_mode: Literal[
        "standard",
        "direct_reply",
        "capability_intro",
        "faq_hit",
        "handoff_intent",
        "scene_module",
    ] = "standard"
    target_skill_id: Optional[str] = None
    target_step_id: Optional[str] = None
    # 场景实例 id（仅 execution_mode="scene_module" 时有意义）。
    # 与 target_step_id 并列而不是复用：一个场景实例不是 SOP 节点，
    # 复用它会让 ``_run_scene_frame`` 去 SOP 引擎里查一个查不到的东西。
    scene_id: Optional[str] = None
    user_intent: Optional[str] = None
    requirements: list[str] = Field(default_factory=list)
    slot_hints: dict[str, Any] = Field(default_factory=dict)
    depends_on_task_ids: list[str] = Field(default_factory=list)
    execution_target: TaskFrameExecutionTarget = "self"
    assignee_agent_id: Optional[str] = None
    activation_condition: dict[str, Any] = Field(default_factory=dict)
    source_message: Optional[str] = None

    @field_validator("slot_hints", mode="before")
    @classmethod
    def _default_null_slot_hints(cls, value: Any) -> Any:
        return {} if value is None else value

    @field_validator("activation_condition", mode="before")
    @classmethod
    def _default_null_activation_condition(cls, value: Any) -> Any:
        return {} if value is None else value

    @field_validator("requirements", "depends_on_task_ids", mode="before")
    @classmethod
    def _default_null_lists(cls, value: Any) -> Any:
        return [] if value is None else value


class PendingTask(BaseModel):
    task_id: Optional[str] = None
    status: str = "pending"
    decision: RouterDecisionValue = "start_new_task"
    target_skill_id: Optional[str] = None
    target_step_id: Optional[str] = None
    confidence: float = 0.0
    user_intent: Optional[str] = None
    reason: Optional[str] = None
    source_message: Optional[str] = None
    slot_hints: dict[str, Any] = Field(default_factory=dict)


class TaskUpdate(BaseModel):
    task_id: str
    status: Optional[str] = None
    target_skill_id: Optional[str] = None
    target_step_id: Optional[str] = None
    user_intent: Optional[str] = None
    reason: Optional[str] = None
    source_message: Optional[str] = None
    slot_hints: dict[str, Any] = Field(default_factory=dict)
    remove: bool = False

    @field_validator("slot_hints", mode="before")
    @classmethod
    def _default_null_slot_hints(cls, value: Any) -> Any:
        return {} if value is None else value


class TurnPlan(BaseModel):
    """The only scene/SOP intent decision produced for a user turn.

    Capability selection deliberately does not belong in this contract. Each
    planned frame is compiled into a Harness task after the plan is persisted.
    """

    decision: RouterDecisionValue = "answer_only"
    selected_task_id: Optional[str] = None
    confidence: float = 0.0
    user_intent: Optional[str] = None
    reason: Optional[str] = None
    clarification_question: Optional[str] = None
    task_frames: list[PlannedTaskFrame] = Field(default_factory=list)
    task_updates: list[TaskUpdate] = Field(default_factory=list)

    @field_validator("task_frames", "task_updates", mode="before")
    @classmethod
    def _default_null_lists(cls, value: Any) -> Any:
        return [] if value is None else value


class AwaitingInput(BaseModel):
    task_id: Optional[str] = None
    skill_id: Optional[str] = None
    step_id: Optional[str] = None
    expected_fields: list[str] = Field(default_factory=list)
    question_summary: Optional[str] = None
    turn_id: Optional[str] = None


class RouterDecision(BaseModel):
    decision: RouterDecisionValue
    selected_task_id: Optional[str] = None
    target_skill_id: Optional[str] = None
    target_step_id: Optional[str] = None
    confidence: float = 0.0
    user_intent: Optional[str] = None
    general_intent: Optional[str] = None
    reason: Optional[str] = None
    source_message: Optional[str] = None
    clarification_question: Optional[str] = None
    slot_hints: dict[str, Any] = Field(default_factory=dict)
    task_frames: list[PendingTask] = Field(default_factory=list)
    pending_tasks: list[PendingTask] = Field(default_factory=list)
    task_updates: list[TaskUpdate] = Field(default_factory=list)
    created_tasks: list[PendingTask] = Field(default_factory=list)
    awaiting_input: Optional[AwaitingInput] = None


class KnowledgeQuery(BaseModel):
    query: str
    reason: Optional[str] = None
    scope: dict[str, Any] = Field(default_factory=dict)
    max_chunks: int = 6
    query_type: Literal["answer", "policy_check", "tool_discovery", "skill_discovery"] = "answer"
    desired_evidence: Optional[str] = None
    max_depth: int = 2


class StepAgentResult(BaseModel):
    action: Optional[
        Literal[
            "ask_user",
            "clarify",
            "reply",
            "advance",
            "call_tool",
            "query_knowledge",
            "handoff",
        ]
    ] = None
    reply: Optional[str] = None
    slot_updates: dict[str, Any] = Field(default_factory=dict)
    tool_call: Optional[ToolCall] = None
    knowledge_query: Optional[KnowledgeQuery] = None
    knowledge_results: list[dict[str, Any]] = Field(default_factory=list)
    next_step_id: Optional[str] = None
    is_step_completed: bool = False
    handoff: bool = False
    structured_result: Any | None = None


class SessionPublic(BaseModel):
    session_id: str
    tenant_id: str
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    title: Optional[str] = None
    active_skill_id: Optional[str] = None
    active_step_id: Optional[str] = None
    slots: dict[str, Any] = Field(default_factory=dict)
    pending_tasks: list[dict[str, Any]] = Field(default_factory=list)
    awaiting_input: Optional[dict[str, Any]] = None
    knowledge_context: list[dict[str, Any]] = Field(default_factory=list)
    summary: Optional[str] = None
    last_agent_question: Optional[str] = None
    status: str = "active"


class ChatTurnRequest(BaseModel):
    tenant_id: str
    session_id: Optional[str] = None
    agent_id: Optional[str] = None
    model_config_id: Optional[str] = None
    client_turn_id: Optional[str] = None
    user_id: Optional[str] = None
    message: str
    attachments: list["ChatAttachmentRead"] = Field(default_factory=list)
    channel: str = "web"
    interaction_mode: Literal["normal", "scheduled_task"] = "normal"
    # Server-only prompt prefix. It is consumed by the runtime but never persisted as
    # the user's visible message or serialized into background-job payloads.
    context_injection: Optional[str] = Field(default=None, exclude=True)
    # Internal retry turns remain auditable in storage while staying out of the
    # user-facing conversation and subsequent conversational context.
    message_visibility: Literal["visible", "internal"] = Field(default="visible", exclude=True)
    # Internal callers such as scheduled tasks may pin one published SOP.  This
    # is deliberately separate from the visible message so execution does not
    # depend on the planner rediscovering the same SOP on every wake-up.
    forced_sop_id: Optional[str] = Field(default=None, exclude=True)
    # Scheduled tasks may freeze the selected SOP at save time. The snapshot is
    # server-only and is applied only after the current employee binding has
    # been verified, so pinning a version never bypasses capability access.
    forced_sop_snapshot: Optional[dict[str, Any]] = Field(default=None, exclude=True)
    # 内部调用方（场景胶囊点击、「选这个」按钮、表单提交轮）可以指定进入某个
    # 场景实例。**与 ``forced_sop_id`` 同层**：两者都是「跳过意图识别、
    # 直接进某个已确认的能力」，位置也必须在 handoff 短路之前——
    # 用户点「选这个」发出的是「就选经典雪山五日」，一个关键词都没有，
    # 放到 FAQ 之后会被 FAQ 先截走。
    #
    # 铁律：**必须校验它在该员工当前生效的绑定集内**（``resolve_scene_hit``
    # 的第一条规则）。不校验的话，解绑后的旧请求、或伪造的 scene_id 仍能触发场景。
    forced_scene_id: Optional[str] = Field(default=None, exclude=True)
    # 场景胶囊点开表单后提交的那一轮：文本是「人数：4；天数：5；预算：3000」，
    # **一个关键词都没有**，靠关键词匹配必然失败。所以表单提交轮必须由前端
    # 带上 ``forced_scene_id``，后端再把它当 forced 处理。
    client_timezone: Optional[str] = None
    # A2UI：用户在**表单卡片**里提交的结构化槽位取值（``{字段名: 取值}``）。
    # 只作为「本轮用户消息的结构化伴随信息」参与槽位写入：确定性执行器优先
    # 用它、跳过那一轮槽位抽取 LLM。非表单渠道（企微/微信）不带这个字段，
    # 行为与改造前完全一致。
    slot_submission: Optional[dict[str, Any]] = None
    # 本轮是否启用「互联网检索」（聊天输入框开关 / 公开 API web_search 参数）。
    # 默认 False：web_search 能力不进入冻结清单，模型无从调用。
    # 打开后也不是无脑联网 —— 知识工作流先查本地知识库，证据不够才补联网。
    web_search: bool = False
    debug: bool = False


class ChatAttachmentRead(BaseModel):
    id: str
    filename: str
    content_type: str
    size: int
    kind: Literal["text", "pdf", "image", "binary"] = "binary"
    text: Optional[str] = None
    preview: Optional[str] = None
    data_url: Optional[str] = None
    sandbox_path: Optional[str] = None
    sha256: Optional[str] = None
    python_summary: Optional[str] = None
    error: Optional[str] = None
    # PDF 云端解析（MinerU）：上传接口为 PDF 附件创建任务后回填给前端轮询。
    # 这两个字段**不参与** turn 回程信任——turn 侧只按 attachment_id 查库校验。
    parse_job_id: Optional[str] = None
    parse_status: Optional[str] = None


class ChatTurnResponse(BaseModel):
    reply: str
    session_id: str
    runtime_error_code: Optional[str] = None
    router_decision: Optional[RouterDecision] = None
    step_result: Optional[StepAgentResult] = None
    tool_result: Optional[ToolResult] = None
    session_state: SessionPublic


class ChatSessionCreateRequest(BaseModel):
    tenant_id: str
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    title: Optional[str] = None


class ChatSessionUpdateRequest(BaseModel):
    tenant_id: str
    user_id: Optional[str] = None
    title: str


class ChatSessionRead(BaseModel):
    id: str
    tenant_id: str
    user_id: Optional[str]
    user_display_name: Optional[str] = None
    agent_id: Optional[str] = None
    title: Optional[str]
    active_skill_id: Optional[str]
    active_step_id: Optional[str]
    status: str
    summary: Optional[str]
    last_agent_question: Optional[str]
    is_scheduled: bool = False
    team_id: Optional[str] = None
    team_name: Optional[str] = None
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class MessageRead(BaseModel):
    id: str
    tenant_id: str
    session_id: str
    role: str
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    turn_id: Optional[str] = None
    created_at: str
    feedback_rating: Optional[MessageFeedbackValue] = None

    model_config = ConfigDict(from_attributes=True)


class MessageFeedbackRequest(BaseModel):
    tenant_id: str
    rating: MessageFeedbackValue
