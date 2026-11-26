from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Optional
from uuid import uuid4

from sqlalchemy import JSON, Boolean, Column, Index, Integer, String, UniqueConstraint, text
from sqlmodel import Field, SQLModel


def utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:16]}"


class Tenant(SQLModel, table=True):
    __tablename__ = "tenants"

    id: str = Field(primary_key=True)
    name: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class User(SQLModel, table=True):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("tenant_id", "username", name="uq_user_tenant_username"),
        Index("ix_users_tenant_id_display_name", "tenant_id", "display_name"),
    )

    id: str = Field(default_factory=lambda: new_id("user"), primary_key=True)
    tenant_id: str = Field(index=True)
    username: str = Field(index=True)
    display_name: Optional[str] = None
    # 所属部门:注册/账号管理维护,用于组织维度的用户识别
    department: Optional[str] = None
    # 部门保护标记:在产品里被手动改过(本人或管理员)后,域登录不再覆盖部门
    department_manual: bool = Field(default=False)
    role: str = Field(default="member", index=True)
    # 账号来源:web=网页端创建;share=分享链接免登录访客;其余(如 wechat)=渠道懒建
    # 访客与渠道懒建账号不是租户成员,用户管理列表默认隐藏
    source: str = Field(default="web", index=True)
    # 邮箱:本地注册可为空;域账号登录时由 AD 的 mail 属性同步
    email: Optional[str] = Field(default=None, index=True)
    # 认证方式:local=本地口令;ldap=域账号(由 AD 同步落库)
    auth_source: Optional[str] = None
    password_hash: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class UserAvatar(SQLModel, table=True):
    """用户头像:小图以 data_url 直接存库(与聊天附件内联方式一致),

    独立小表避免 users 热表膨胀;create_all 建表,无需 ALTER。
    """

    __tablename__ = "user_avatars"

    user_id: str = Field(primary_key=True)
    data_url: str
    updated_at: datetime = Field(default_factory=utc_now)


class APIClient(SQLModel, table=True):
    """Server-to-server identity for the versioned public API."""

    __tablename__ = "api_clients"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_api_client_tenant_name"),
    )

    id: str = Field(default_factory=lambda: new_id("apiclient"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str
    description: Optional[str] = None
    scopes_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    status: str = Field(default="active", index=True)
    created_by_user_id: Optional[str] = Field(default=None, index=True)
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class APICredential(SQLModel, table=True):
    """Hashed tenant or agent credential. Plaintext is returned exactly once."""

    __tablename__ = "api_credentials"
    __table_args__ = (
        UniqueConstraint("key_prefix", name="uq_api_credential_prefix"),
    )

    id: str = Field(default_factory=lambda: new_id("apicred"), primary_key=True)
    tenant_id: str = Field(index=True)
    client_id: str = Field(index=True)
    agent_id: Optional[str] = Field(default=None, index=True)
    name: str
    key_prefix: str = Field(index=True)
    key_digest: str
    scopes_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    status: str = Field(default="active", index=True)
    expires_at: Optional[datetime] = Field(default=None, index=True)
    last_used_at: Optional[datetime] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    revoked_at: Optional[datetime] = None


class APIIdempotencyRecord(SQLModel, table=True):
    __tablename__ = "api_idempotency_records"
    __table_args__ = (
        UniqueConstraint(
            "credential_id", "method", "path", "idempotency_key",
            name="uq_api_idempotency_request",
        ),
    )

    id: str = Field(default_factory=lambda: new_id("apiidem"), primary_key=True)
    tenant_id: str = Field(index=True)
    credential_id: str = Field(index=True)
    method: str
    path: str
    idempotency_key: str = Field(index=True)
    request_hash: str
    status_code: int = 200
    response_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    resource_id: Optional[str] = Field(default=None, index=True)
    expires_at: datetime = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class APIJob(SQLModel, table=True):
    __tablename__ = "api_jobs"

    id: str = Field(default_factory=lambda: new_id("apijob"), primary_key=True)
    tenant_id: str = Field(index=True)
    credential_id: str = Field(index=True)
    agent_id: Optional[str] = Field(default=None, index=True)
    kind: str = Field(index=True)
    status: str = Field(default="queued", index=True)
    stage: str = Field(default="queued", index=True)
    progress: float = 0.0
    request_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    result_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    error_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    cancel_requested: bool = False
    retryable: bool = False
    execution_owner: Optional[str] = Field(default=None, index=True)
    execution_generation: int = 0
    lease_expires_at: Optional[datetime] = Field(default=None, index=True)
    session_id: Optional[str] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    updated_at: datetime = Field(default_factory=utc_now)


class APIJobEvent(SQLModel, table=True):
    __tablename__ = "api_job_events"
    __table_args__ = (
        UniqueConstraint("job_id", "sequence", name="uq_api_job_event_sequence"),
    )

    id: str = Field(default_factory=lambda: new_id("apievent"), primary_key=True)
    tenant_id: str = Field(index=True)
    job_id: str = Field(index=True)
    sequence: int = Field(index=True)
    event_type: str = Field(index=True)
    data_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    public: bool = True
    created_at: datetime = Field(default_factory=utc_now)


class A2ATaskRun(SQLModel, table=True):
    """Durable state for outbound A2A calls and locally served A2A tasks."""

    __tablename__ = "a2a_task_runs"

    id: str = Field(default_factory=lambda: new_id("a2arun"), primary_key=True)
    direction: str = Field(default="client", index=True)
    tenant_id: str = Field(index=True)
    tool_id: Optional[str] = Field(default=None, index=True)
    agent_id: Optional[str] = Field(default=None, index=True)
    session_id: Optional[str] = Field(default=None, index=True)
    invocation_id: Optional[str] = Field(default=None, index=True)
    endpoint_url: str
    agent_card_url: Optional[str] = None
    protocol_binding: str = "JSONRPC"
    protocol_version: str = "1.0"
    remote_task_id: Optional[str] = Field(default=None, index=True)
    context_id: Optional[str] = Field(default=None, index=True)
    status: str = Field(default="submitted", index=True)
    request_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    result_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    error_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    artifacts_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    agent_card_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    last_event_id: Optional[str] = Field(default=None, index=True)
    cancel_requested: bool = False
    recovery_attempts: int = 0
    created_at: datetime = Field(default_factory=utc_now)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    updated_at: datetime = Field(default_factory=utc_now)


class A2ATaskEvent(SQLModel, table=True):
    __tablename__ = "a2a_task_events"
    __table_args__ = (
        UniqueConstraint("run_id", "sequence", name="uq_a2a_task_event_sequence"),
    )

    id: str = Field(default_factory=lambda: new_id("a2aevt"), primary_key=True)
    tenant_id: str = Field(index=True)
    run_id: str = Field(index=True)
    sequence: int = Field(index=True)
    external_event_id: Optional[str] = Field(default=None, index=True)
    event_type: str = Field(index=True)
    data_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)


class WebhookEndpoint(SQLModel, table=True):
    __tablename__ = "webhook_endpoints"

    id: str = Field(default_factory=lambda: new_id("webhook"), primary_key=True)
    tenant_id: str = Field(index=True)
    client_id: str = Field(index=True)
    name: str
    url: str
    secret_encrypted: str
    events_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    status: str = Field(default="active", index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class WebhookDelivery(SQLModel, table=True):
    __tablename__ = "webhook_deliveries"
    __table_args__ = (
        UniqueConstraint("endpoint_id", "event_id", name="uq_webhook_delivery_event"),
    )

    id: str = Field(default_factory=lambda: new_id("whdelivery"), primary_key=True)
    tenant_id: str = Field(index=True)
    endpoint_id: str = Field(index=True)
    event_id: str = Field(index=True)
    event_type: str = Field(index=True)
    payload_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = Field(default="queued", index=True)
    delivery_owner: Optional[str] = Field(default=None, index=True)
    lease_expires_at: Optional[datetime] = Field(default=None, index=True)
    attempt_count: int = 0
    next_attempt_at: Optional[datetime] = Field(default=None, index=True)
    last_status_code: Optional[int] = None
    last_error: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    delivered_at: Optional[datetime] = None
    updated_at: datetime = Field(default_factory=utc_now)


class ExternalSessionBinding(SQLModel, table=True):
    __tablename__ = "external_session_bindings"
    __table_args__ = (
        UniqueConstraint(
            "credential_id", "external_session_id",
            name="uq_external_session_credential_id",
        ),
    )

    id: str = Field(default_factory=lambda: new_id("extsession"), primary_key=True)
    tenant_id: str = Field(index=True)
    credential_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    external_session_id: str = Field(index=True)
    external_user_id: Optional[str] = Field(default=None, index=True)
    session_id: str = Field(index=True)
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class APISOPDraft(SQLModel, table=True):
    __tablename__ = "api_sop_drafts"

    id: str = Field(default_factory=lambda: new_id("sopdraft"), primary_key=True)
    tenant_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    skill_id: str = Field(index=True)
    base_version: Optional[str] = Field(default=None, index=True)
    draft_version: str = Field(index=True)
    content_json: dict[str, Any] = Field(sa_column=Column(JSON, nullable=False))
    status: str = Field(default="draft", index=True)
    source: str = Field(default="structured", index=True)
    warnings_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    validation_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    etag: str = Field(index=True)
    created_by_credential_id: Optional[str] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now)
    published_at: Optional[datetime] = None
    updated_at: datetime = Field(default_factory=utc_now)


class APIAuditLog(SQLModel, table=True):
    __tablename__ = "api_audit_logs"

    id: str = Field(default_factory=lambda: new_id("apiaudit"), primary_key=True)
    tenant_id: Optional[str] = Field(default=None, index=True)
    credential_id: Optional[str] = Field(default=None, index=True)
    request_id: str = Field(index=True)
    method: str
    path: str
    resource_type: Optional[str] = Field(default=None, index=True)
    resource_id: Optional[str] = Field(default=None, index=True)
    status_code: int = Field(index=True)
    duration_ms: float
    created_at: datetime = Field(default_factory=utc_now)


class Skill(SQLModel, table=True):
    __tablename__ = "skills"
    __table_args__ = (UniqueConstraint("tenant_id", "skill_id", name="uq_skill_tenant_skill_id"),)

    id: str = Field(default_factory=lambda: new_id("skill"), primary_key=True)
    tenant_id: str = Field(index=True)
    skill_id: str = Field(index=True)
    version: str = "1.0.0"
    name: str
    business_domain: Optional[str] = None
    description: Optional[str] = None
    content_json: dict[str, Any] = Field(sa_column=Column(JSON, nullable=False))
    status: str = Field(default="draft", index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class SkillVersion(SQLModel, table=True):
    __tablename__ = "skill_versions"
    __table_args__ = (UniqueConstraint("tenant_id", "skill_id", "version", name="uq_skill_version"),)

    id: str = Field(default_factory=lambda: new_id("skillver"), primary_key=True)
    tenant_id: str = Field(index=True)
    skill_id: str = Field(index=True)
    version: str = Field(index=True)
    name: str
    business_domain: Optional[str] = None
    description: Optional[str] = None
    content_json: dict[str, Any] = Field(sa_column=Column(JSON, nullable=False))
    status: str = Field(default="draft", index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class SkillEdgeCondition(SQLModel, table=True):
    """SOP 边条件的**结构化编译结果**（离线编译产物，见 app/skills/edge_condition_spec.py）。

    为什么不写回 ``skills.content_json``：SkillCard 的 JSON 会被前端 SkillCard
    类型、SkillEditor 的局部改写来回搬运，边缘字段没有对应的 TS 类型就会被
    静默丢掉。改成按**条件指纹**独立存表：

    - 唯一键 ``(tenant_id, skill_id, condition_fingerprint)``——同一条边条件
      （端点 + 条件原文 + 源节点必填字段）在任何版本下复用同一份编译结果；
    - 条件原文一变指纹就变 → 旧行自然失效，不需要显式清理；
    - ``status`` 三态：``compiled`` 已结构化 / ``llm_judge`` 仍需模型语义判断
      / ``failed`` 编译失败（保留 ``condition`` 自由文本，运行时照旧回落 LLM）。
    """

    __tablename__ = "skill_edge_conditions"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "skill_id",
            "condition_fingerprint",
            name="uq_skill_edge_condition_fingerprint",
        ),
    )

    id: str = Field(default_factory=lambda: new_id("edgecond"), primary_key=True)
    tenant_id: str = Field(index=True)
    skill_id: str = Field(index=True)
    # 最近一次编译时技能所处的版本，仅作参考（复用不受版本约束）
    version: str = "1.0.0"
    source_node_id: str = Field(index=True)
    next_node_id: str
    condition_text: str = ""
    condition_fingerprint: str = Field(index=True)
    # compiled / llm_judge / failed
    status: str = Field(default="compiled", index=True)
    kind: str = ""
    spec_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # preset / llm / manual
    source: str = "llm"
    confidence: float = 1.0
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentSkillBranch(SQLModel, table=True):
    __tablename__ = "agent_skill_branches"
    __table_args__ = (
        UniqueConstraint("tenant_id", "agent_id", "skill_id", name="uq_agent_skill_branch"),
    )

    id: str = Field(default_factory=lambda: new_id("agentbranch"), primary_key=True)
    tenant_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    skill_id: str = Field(index=True)
    source_skill_id: str = Field(index=True)
    base_version: str = "1.0.0"
    head_version: str = "1.0.0"
    content_json: dict[str, Any] = Field(sa_column=Column(JSON, nullable=False))
    status: str = Field(default="active", index=True)
    sync_state: str = Field(default="synced", index=True)
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentSkillBranchVersion(SQLModel, table=True):
    __tablename__ = "agent_skill_branch_versions"
    __table_args__ = (
        UniqueConstraint("tenant_id", "agent_id", "skill_id", "version", name="uq_agent_skill_branch_version"),
    )

    id: str = Field(default_factory=lambda: new_id("agentbranchver"), primary_key=True)
    tenant_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    skill_id: str = Field(index=True)
    source_skill_id: str = Field(index=True)
    version: str = Field(index=True)
    base_version: str = "1.0.0"
    content_json: dict[str, Any] = Field(sa_column=Column(JSON, nullable=False))
    status: str = Field(default="active", index=True)
    sync_state: str = Field(default="diverged", index=True)
    change_summary: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class GeneralSkill(SQLModel, table=True):
    __tablename__ = "general_skills"
    __table_args__ = (UniqueConstraint("tenant_id", "slug", name="uq_general_skill_tenant_slug"),)

    id: str = Field(default_factory=lambda: new_id("genskill"), primary_key=True)
    tenant_id: str = Field(index=True)
    slug: str = Field(index=True)
    name: str
    description: Optional[str] = None
    #: 标签分类（办公类 / 财务类 / 人力资源类 / 编程类），技能广场按此下拉过滤。
    category: Optional[str] = None
    homepage: Optional[str] = None
    skill_markdown: str
    skill_files_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = Field(default="draft", index=True)
    capability_scope: str = Field(default="general", index=True)
    #: 技能包累计下载次数（广场下载 + 免登录分享下载都 +1）。
    download_count: int = Field(default=0)
    permissions_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    runtime_config_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class KnowledgeBase(SQLModel, table=True):
    __tablename__ = "knowledge_bases"
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_knowledge_base_tenant_name"),)

    id: str = Field(default_factory=lambda: new_id("kb"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str
    description: Optional[str] = None
    status: str = Field(default="active", index=True)
    capability_scope: str = Field(default="general", index=True)
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class KnowledgeBaseVersion(SQLModel, table=True):
    __tablename__ = "knowledge_base_versions"
    __table_args__ = (
        UniqueConstraint("tenant_id", "knowledge_base_id", "version", name="uq_knowledge_base_version"),
    )

    id: str = Field(default_factory=lambda: new_id("kbver"), primary_key=True)
    tenant_id: str = Field(index=True)
    knowledge_base_id: str = Field(index=True)
    version: str = Field(default="1.0.0", index=True)
    name: str
    description: Optional[str] = None
    status: str = Field(default="active", index=True)
    capability_scope: str = Field(default="general", index=True)
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentKnowledgeBranch(SQLModel, table=True):
    __tablename__ = "agent_knowledge_branches"
    __table_args__ = (
        UniqueConstraint("tenant_id", "agent_id", "knowledge_base_id", name="uq_agent_knowledge_branch"),
    )

    id: str = Field(default_factory=lambda: new_id("agentkb"), primary_key=True)
    tenant_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    knowledge_base_id: str = Field(index=True)
    base_version: str = "1.0.0"
    head_version: str = "1.0.0"
    status: str = Field(default="active", index=True)
    sync_state: str = Field(default="synced", index=True)
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class KnowledgeDocument(SQLModel, table=True):
    __tablename__ = "knowledge_documents"

    id: str = Field(default_factory=lambda: new_id("kdoc"), primary_key=True)
    tenant_id: str = Field(index=True)
    knowledge_base_id: str = Field(index=True)
    knowledge_base_version_id: Optional[str] = Field(default=None, index=True)
    filename: str
    file_type: str = Field(index=True)
    title: Optional[str] = None
    status: str = Field(default="processing", index=True)
    bucket_count: int = 0
    chunk_count: int = 0
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    error: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class KnowledgeBucket(SQLModel, table=True):
    __tablename__ = "knowledge_buckets"

    id: str = Field(default_factory=lambda: new_id("kbucket"), primary_key=True)
    tenant_id: str = Field(index=True)
    knowledge_base_id: str = Field(index=True)
    knowledge_base_version_id: Optional[str] = Field(default=None, index=True)
    document_id: str = Field(index=True)
    bucket_key: str = Field(index=True)
    title: str
    summary: str
    token_estimate: int = 0
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class KnowledgeChunk(SQLModel, table=True):
    __tablename__ = "knowledge_chunks"

    id: str = Field(default_factory=lambda: new_id("kchunk"), primary_key=True)
    tenant_id: str = Field(index=True)
    knowledge_base_id: str = Field(index=True)
    knowledge_base_version_id: Optional[str] = Field(default=None, index=True)
    document_id: str = Field(index=True)
    bucket_id: str = Field(index=True)
    chunk_index: int = Field(index=True)
    content: str
    summary: Optional[str] = None
    source_ref: Optional[str] = None
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class KnowledgeAsset(SQLModel, table=True):
    """知识库二进制资产（目前只有原文档里的图片）。

    图片不入 chunk 正文以外的任何结构：chunk 里以 markdown ``![alt](url)``
    引用它，检索仍走文字，回答时把图片 markdown 原样带回。
    """

    __tablename__ = "knowledge_assets"

    id: str = Field(default_factory=lambda: new_id("kasset"), primary_key=True)
    tenant_id: str = Field(index=True)
    knowledge_base_id: str = Field(index=True)
    document_id: Optional[str] = Field(default=None, index=True)
    chunk_id: Optional[str] = Field(default=None, index=True)
    kind: str = Field(default="image", index=True)
    mime: str = Field(default="image/png")
    size_bytes: int = 0
    # 同一张图在多个文档/多处出现时按内容去重，只落一份文件
    sha256: str = Field(index=True)
    storage_key: str
    width: Optional[int] = None
    height: Optional[int] = None
    page: Optional[int] = None
    section_path: Optional[str] = None
    order_index: int = 0
    alt: Optional[str] = None
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class KnowledgeConcept(SQLModel, table=True):
    __tablename__ = "knowledge_concepts"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "knowledge_base_version_id",
            "concept_id",
            name="uq_knowledge_concept_version_path",
        ),
    )

    id: str = Field(default_factory=lambda: new_id("kconcept"), primary_key=True)
    tenant_id: str = Field(index=True)
    knowledge_base_id: str = Field(index=True)
    knowledge_base_version_id: Optional[str] = Field(default=None, index=True)
    document_id: Optional[str] = Field(default=None, index=True)
    concept_id: str = Field(index=True)
    concept_type: str = Field(index=True)
    title: str
    description: Optional[str] = None
    content_md: str
    frontmatter_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    links_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    citations_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    source_refs_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    status: str = Field(default="active", index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class KnowledgeDiscoverySuggestion(SQLModel, table=True):
    __tablename__ = "knowledge_discovery_suggestions"

    id: str = Field(default_factory=lambda: new_id("kdisc"), primary_key=True)
    tenant_id: str = Field(index=True)
    knowledge_base_id: str = Field(index=True)
    knowledge_base_version_id: Optional[str] = Field(default=None, index=True)
    document_id: str = Field(index=True)
    bucket_id: Optional[str] = Field(default=None, index=True)
    suggestion_type: str = Field(index=True)
    title: str
    status: str = Field(default="pending", index=True)
    payload_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    source_refs_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    reason: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class KnowledgeIngestJob(SQLModel, table=True):
    __tablename__ = "knowledge_ingest_jobs"

    id: str = Field(default_factory=lambda: new_id("kjob"), primary_key=True)
    tenant_id: str = Field(index=True)
    knowledge_base_id: str = Field(index=True)
    knowledge_base_version_id: Optional[str] = Field(default=None, index=True)
    document_id: Optional[str] = Field(default=None, index=True)
    filename: str
    status: str = Field(default="queued", index=True)
    stage: str = "queued"
    progress: float = 0.0
    error: Optional[str] = None
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    updated_at: datetime = Field(default_factory=utc_now)


class AttachmentParseJob(SQLModel, table=True):
    """聊天附件云端解析任务（MinerU）。

    PDF 扫描件无文字层，pypdf/extract_document_text 抽不出文本；上传接口对
    PDF 附件自动创建本任务并异步调度（rq 优先、进程内兜底），前端轮询进度。
    解析出的 markdown 写入附件暂存目录（``parsed.md``），turn 物化时直接
    作为 extracted_text_path 提供给模型，避免模型在沙箱里再做一次必然失败的
    文字层抽取。``metadata_json`` 保存重建暂存读取所需的附件指纹
    （filename/content_type/size/sha256）。
    """

    __tablename__ = "attachment_parse_jobs"

    id: str = Field(default_factory=lambda: new_id("pjob"), primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    attachment_id: str = Field(index=True)
    filename: str
    status: str = Field(default="queued", index=True)
    stage: str = "queued"
    progress: float = 0.0
    error: Optional[str] = None
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    updated_at: datetime = Field(default_factory=utc_now)


class ModelConfig(SQLModel, table=True):
    __tablename__ = "model_configs"

    id: str = Field(default_factory=lambda: new_id("model"), primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: Optional[str] = Field(default=None, index=True)
    name: str
    provider: str = "openai_compatible"
    api_protocol: str = Field(default="openai_chat_completions", index=True)
    base_url: Optional[str] = None
    api_key_encrypted: str
    model: str
    temperature: float = 0.2
    max_output_tokens: int = 131072
    extra_body_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # 自定义请求头：{"Header-Name": "value"}，逐请求 merge 进最终出站请求头
    custom_headers_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    protocol_options_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    legacy_unmapped_options_json: dict[str, Any] = Field(
        default_factory=dict, sa_column=Column(JSON)
    )
    trust_status: str = Field(default="unverified", index=True)
    verified_at: Optional[datetime] = None
    verified_fingerprint: Optional[str] = None
    verification_attempt_id: Optional[str] = None
    verification_started_at: Optional[datetime] = None
    verification_attempt_status: str = Field(default="idle", index=True)
    verification_attempt_error_code: Optional[str] = None
    config_revision: int = 1
    security_revision: int = 1
    key_revision: int = 1
    is_default: bool = False
    is_intent_recognition: bool = Field(default=False)
    # 全局免费模型:租户内单选(管理员把自己的一条模型标记为全局,成员在免费员工上无自己模型时自动使用,
    # 按「用户×员工×天」计 10 问配额)。置位/清理由 service 层保证租户内唯一。
    is_global_free: bool = False
    enabled: bool = True
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class GlobalFreeModelUsage(SQLModel, table=True):
    """免费模型每日配额:每用户对每个免费员工每天 FREE_MODEL_DAILY_LIMIT 问。

    count 走 SQL 侧原子自增(对话链路并发安全);(tenant, user, agent, date) 唯一。
    usage_date 用 UTC 日期字符串('YYYY-MM-DD'),避免时区列类型在 PG/SQLite 间的差异。
    """

    __tablename__ = "global_free_model_usage"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "user_id", "agent_id", "usage_date", name="uq_free_model_usage_day"
        ),
    )

    id: str = Field(default_factory=lambda: new_id("freemodel"), primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    usage_date: str = Field(index=True)
    count: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    updated_at: datetime = Field(default_factory=utc_now)


class ApiKeyApplication(SQLModel, table=True):
    """用户申请 API Key 的审批单:pending -> approved / rejected (管理员操作)。

    api_key 以加密形式存储(api_key_encrypted),仅在申请人自己的视图中明文返回一次;
    api_url 为网关地址(当前为本地 mock,后续对接阿里云 DashScope 时由云侧下发)。
    """

    __tablename__ = "api_key_applications"

    id: str = Field(default_factory=lambda: new_id("apk"), primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    username: Optional[str] = None
    purpose: Optional[str] = None
    status: str = Field(default="pending", index=True)
    api_key_encrypted: Optional[str] = None
    api_url: Optional[str] = None
    reviewer_user_id: Optional[str] = Field(default=None, index=True)
    reviewer_note: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    # 对接阿里云 AI Gateway 后回填的字段
    gateway_name: Optional[str] = None
    gateway_id: Optional[str] = None
    gateway_url: Optional[str] = None
    quota_limit: Optional[int] = None
    quota_period: Optional[str] = None  # day / week / month
    quota_rule_id: Optional[str] = None
    consumer_id: Optional[str] = None
    consumer_name: Optional[str] = None
    # 审批分配时选定的消费组与配额规则（逻辑关联，便于列表展示与批量改配额）
    consumer_group_id: Optional[str] = None
    consumer_group_name: Optional[str] = None
    quota_rule_name: Optional[str] = None

    # 用量分析缓存（按自然月汇总，降低重复查询阿里云频次）
    used_amount: Optional[int] = None
    usage_month: Optional[str] = None  # YYYY-MM


class ApiKeyConsumerGroup(SQLModel, table=True):
    """消费者组(阿里云 AI Gateway ConsumerGroup)管理。

    对应阿里云 ListConsumerGroups 返回的 ConsumerGroup（csg- 前缀），
    消费者组不可增删改，只能看成员列表。
    """

    __tablename__ = "api_key_consumer_groups"

    id: str = Field(default_factory=lambda: new_id("cg"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str
    description: Optional[str] = None
    owner: Optional[str] = None
    gateway_id: str
    gateway_name: str
    external_consumer_group_id: Optional[str] = None  # 阿里云消费组 ID,如 csg-dab9hgem1hknuvjcvc0g
    external_consumer_id: Optional[str] = None  # [废弃] 旧字段,保留兼容
    consumer_type: str = "AI"
    consumer_count: Optional[int] = None  # 组内消费者数量（云端字段）
    status: str = Field(default="enabled", index=True)
    created_by_user_id: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ApiKeyConsumer(SQLModel, table=True):
    """消费者(阿里云 AI Gateway Consumer)管理。

    对应阿里云消费者（cs- 前缀），可启用/停用、修改配额规则。
    创建消费者的流程：CreateConsumer → 分配 API Key → 加入消费组 → 绑定配额规则。
    """

    __tablename__ = "api_key_consumers"

    id: str = Field(default_factory=lambda: new_id("co"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str
    description: Optional[str] = None
    gateway_id: str
    gateway_name: str
    external_consumer_id: Optional[str] = None  # 阿里云消费者 ID,如 cs-dabnih6m1hkqvi3fvg70
    external_consumer_group_id: Optional[str] = None  # 所属消费组 ID,如 csg-dab9hgem1hknuvjcvc0g
    consumer_group_name: Optional[str] = None  # 所属消费组名称
    consumer_type: str = "AI"
    deploy_status: Optional[str] = None  # 部署状态
    enable: bool = True  # 是否启用
    status: str = Field(default="enabled", index=True)
    created_by_user_id: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ApiKeyQuotaRule(SQLModel, table=True):
    """配额规则(阿里云 AI Gateway QuotaRule)管理。

    创建配额规则即在阿里云对应网关下创建一个 QuotaRule(external_rule_id);
    可绑定到一个或多个消费者(消费组),审批时选定规则即把该消费组纳入规则限流。
    """

    __tablename__ = "api_key_quota_rules"

    id: str = Field(default_factory=lambda: new_id("qr"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str
    gateway_id: str
    gateway_name: str
    quota_dimension: str = "token"  # token / credit
    quota_limit: int
    period_type: str = "day"  # day / week / month
    external_rule_id: Optional[str] = None  # 阿里云配额规则 ID,如 qr-mock-001
    subject_type: Optional[str] = "consumer"  # consumer / consumer_group（组粒度 2.1.21+）
    status: str = Field(default="enabled", index=True)
    created_by_user_id: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ApiKeyUsageSnapshot(SQLModel, table=True):
    """配额用量快照（按 消费者 × 配额规则 × 自然月 落库）。

    当月每次查询用量时把实时值 upsert 进快照；历史月份直接读快照，
    不再回源阿里云。中途更换配额规则时按规则维度叠加，换规则不丢当月已用量。

    月内累计语义（2026-09-10 定案）：配额窗口可能在自然月内被重置（云端手动
    重置/窗口对齐变更）。检测到云端值 < 本地当前窗口值时，旧窗口累计归档进
    archived_used_amount（冻结不再变动，=「快照1」），云端新值作为当前窗口
    used_amount（=「快照2」，之后持续更新）。展示值 = 两者之和 = 本自然月
    累计使用量；未发生过重置时 archived 恒为 0，行为与单快照一致。
    """

    __tablename__ = "api_key_usage_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "consumer_id",
            "month",
            "quota_rule_id",
            name="uq_api_key_usage_snapshot_consumer_rule_month",
        ),
        Index("ix_api_key_usage_snapshot_tenant_month", "tenant_id", "month"),
    )

    id: str = Field(default_factory=lambda: new_id("usnap"), primary_key=True)
    tenant_id: str = Field(index=True)
    month: str = Field(index=True)  # YYYY-MM
    consumer_id: str = Field(index=True)  # 阿里云消费者 ID（cs-）
    consumer_name: Optional[str] = None
    gateway_id: Optional[str] = None
    gateway_name: Optional[str] = None
    quota_rule_id: str = Field(index=True)  # 阿里云配额规则 ID（qr-）
    quota_rule_name: Optional[str] = None
    quota_limit: int = 0
    quota_period: Optional[str] = None  # day / week / month
    used_amount: int = 0  # 当前配额窗口用量（「快照2」，重置后从云端新值起算）
    archived_used_amount: int = 0  # 月内窗口重置前的累计用量（「快照1」，冻结）
    reset_count: int = 0  # 月内窗口重置次数；本行有效总配额 = quota_limit × (1 + reset_count)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class PersonaConfig(SQLModel, table=True):
    __tablename__ = "persona_configs"

    tenant_id: str = Field(primary_key=True)
    system_prompt: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class UIConfig(SQLModel, table=True):
    __tablename__ = "ui_configs"

    tenant_id: str = Field(primary_key=True)
    show_thinking_trace: bool = True
    show_skill_trace: bool = True
    show_tool_trace: bool = True
    # 对话里是否展示「知识来源」引用卡片（超管开关，租户级）。
    # 默认 True = 保持既有行为；置 False 后所有会话（含团队协作面板）都不渲染来源卡片。
    show_knowledge_citations: bool = True
    reflection_max_rounds: int = 1
    agent_loop_max_actions: int = 32
    context_token_budget: int = 32_000
    context_compaction_trigger_ratio: float = 0.70
    context_recent_round_limit: int = 6
    context_long_summary_token_budget: int = 4_000
    context_medium_summary_token_budget: int = 4_000
    context_allowed_roles: list[str] = Field(
        default_factory=lambda: ["user", "assistant"],
        sa_column=Column(JSON),
    )
    context_long_summary_prefix: str = "历史的信息可以被总结为："
    context_medium_summary_prefix: str = "近期的历史信息总结为："
    sandbox_enabled: bool = False
    sandbox_network_mode: str = Field(default="all")
    sandbox_allowed_domains: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    harness_storage_path: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ScenePreset(SQLModel, table=True):
    """场景预设（**开发者 / 超管层**，不是用户层的场景实例）。

    ## 为什么要有这张表

    场景能力分三层，职责严格分开：

    | 层 | 谁定 | 存在哪 |
    |---|---|---|
    | L1 module 实现 | 开发者写代码 | ``frontend-enterprise/src/scenes/modules/<module_key>/`` |
    | L2 预设（本表） | 超管在页面上改 | ``scene_presets`` |
    | L3 场景实例 | 用户建场景时填 | ``scenes`` |

    没有 L2 时，「把按钮文案从『选这个』改成『立即预订』」只能改前端代码再发版；
    有了 L2，改一行 JSON 就全租户生效。这就是「配置驱动只保留一个好处——改文案
    不用发版」落到实处的地方。

    ## 主键是 ``module_key``，不是 id

    一个 module 在全局只能有一份预设（``travel.itinerary`` 对整个租户只有一套
    按钮文案）。用自增 id 会让「同一 module 存了两份预设」变成可表达的状态，
    而那时读哪一份都没有正确答案。主键压住它，比写约束更直接。

    ## ``preset_json`` 里放什么

    ``ui_config`` / ``trigger`` / ``icons`` / ``slots`` / ``match_action`` 五块，
    形状与 ``SceneCreateRequest`` 的同名字段**逐字一致**（不是自创 schema）——
    这样「用预设初始化一个场景」就是把 JSON 原样塞进 scenes 行，不需要写转换层。

    ``slots`` / ``match_action`` 是**初始值**：用户建场景后自己改，之后不再回读预设。
    ``ui_config`` / ``trigger`` 是**实时值**：用户不能改，渲染时每次回读预设，
    所以超管改完全局立即生效（见 ``app/scenes/presets.py::effective_ui_config``）。
    """

    __tablename__ = "scene_presets"

    #: ``<域>.<场景>``，与前端目录名、``Scene.module_key`` 三处一致
    module_key: str = Field(primary_key=True)
    #: 类型下拉里显示的名字（「行程规划」）。空则回落 module 目录名。
    display_name: str = "行程规划"
    #: 决定走 channels 的哪个处理通道；也决定定义器收放哪些区块
    scene_type: str = "table_match"
    #: 新建场景时的默认图标
    icon: str = "🎿"
    #: 关掉后该预设不出现在用户的「场景类型」下拉里（存量场景不受影响）
    enabled: bool = True
    #: 全部参数，见类文档
    preset_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    #: 排序权重，小的在前（下拉顺序稳定，不随 id 变）
    order_index: int = 0
    updated_by: str = ""
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentProfile(SQLModel, table=True):
    __tablename__ = "agent_profiles"
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_agent_profile_tenant_name"),)

    id: str = Field(default_factory=lambda: new_id("agent"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str
    description: Optional[str] = None
    persona_prompt: Optional[str] = None
    is_overall: bool = Field(default=False, index=True)
    status: str = Field(default="active", index=True)
    # Agent 类型:standard = 普通数字员工;dispatcher = 调度入口(纯路由,不配知识库/技能/工具)。
    # 有 server_default,老行自动补齐为 standard,不需要数据回填。
    kind: str = Field(
        default="standard",
        sa_column=Column(String, nullable=False, server_default="standard", index=True),
    )
    harness_max_actions: int = Field(default=32)
    # 被使用次数:每新建一个会话 +1(站内与分享链接访客都计入),员工广场卡片展示。
    # 冗余计数列而非实时 count(sessions) —— 广场列表逐行 count 在远程 PG 上会退化成 N+1。
    usage_count: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    # 免费模型:管理员在员工广场标记后,成员无自己模型时自动使用租户的全局免费模型
    # (每用户每员工每天 FREE_MODEL_DAILY_LIMIT 问);广场卡片显示「免费」徽标。
    free_model_enabled: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, server_default="false"),
    )
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentUsage(SQLModel, table=True):
    __tablename__ = "agent_usages"
    __table_args__ = (
        UniqueConstraint("tenant_id", "user_id", "agent_id", name="uq_agent_usage_user_agent"),
    )

    id: str = Field(default_factory=lambda: new_id("agentuse"), primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentModelBinding(SQLModel, table=True):
    __tablename__ = "agent_model_bindings"
    __table_args__ = (
        UniqueConstraint("tenant_id", "agent_id", "role", name="uq_agent_model_binding"),
    )

    id: str = Field(default_factory=lambda: new_id("agentmodel"), primary_key=True)
    tenant_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    role: str = Field(default="default", index=True)
    model_config_id: str = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class DispatcherMember(SQLModel, table=True):
    """调度入口 → 下属数字员工 的绑定关系。

    一个调度入口(AgentProfile.kind="dispatcher")最多挂 3 个成员;一个员工可以被多个入口引用
    (所以是独立表 + 只锁 (dispatcher_agent_id, member_agent_id) 这一对)。
    **禁止成员本身是 dispatcher** —— 天然封死嵌套与成环,见 dispatch/service.py 的校验。

    routing_rule 是路由准确率的全部来源:什么情况转给他、什么情况「不要转给他」,
    创建/编辑时由用户填,不在对话时让用户选。
    """

    __tablename__ = "dispatcher_members"
    __table_args__ = (
        UniqueConstraint("dispatcher_agent_id", "member_agent_id", name="uq_dispatcher_member"),
    )

    id: str = Field(default_factory=lambda: new_id("dmember"), primary_key=True)
    tenant_id: str = Field(index=True)
    # 调度入口自身(AgentProfile.kind == "dispatcher")
    dispatcher_agent_id: str = Field(index=True)
    # 被路由到的数字员工(AgentProfile.kind == "standard")
    member_agent_id: str = Field(index=True)
    # 什么情况转给他;支持多行,支持「不要转给他」这类负向约束
    routing_rule: str = Field(default="", sa_column=Column(String, nullable=False, server_default=""))
    # 示例问法,帮路由模型对齐口径
    example_queries_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    sort_order: int = Field(default=0)
    status: str = Field(default="active", index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentResourceBinding(SQLModel, table=True):
    __tablename__ = "agent_resource_bindings"
    __table_args__ = (
        UniqueConstraint("tenant_id", "agent_id", "resource_type", "resource_id", name="uq_agent_resource"),
    )

    id: str = Field(default_factory=lambda: new_id("agentres"), primary_key=True)
    tenant_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    resource_type: str = Field(index=True)
    resource_id: str = Field(index=True)
    status: str = Field(default="active", index=True)
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentShareLink(SQLModel, table=True):
    """数字员工分享链接:站内生成,访客凭 token 免登录打开对话窗。

    `model_config_id` 是分享时锁定的模型,访客端不提供模型选择,
    对话链路会强制覆盖请求体里的 model_config_id。
    """

    __tablename__ = "agent_share_links"
    __table_args__ = (UniqueConstraint("token", name="uq_agent_share_link_token"),)

    id: str = Field(default_factory=lambda: new_id("agentshare"), primary_key=True)
    token: str = Field(index=True)
    tenant_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    model_config_id: str = Field(index=True)
    created_by: str = Field(index=True)
    # 空 = 永久有效
    expires_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None
    access_count: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    last_access_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utc_now)


class GeneralSkillShareLink(SQLModel, table=True):
    """通用技能分享链接:站内生成,访客凭 token 免登录查看描述并下载技能包。

    复用数字员工分享链接的口径：token 全局唯一、可撤销、可过期、有访问计数。
    指向的技能必须仍是 published 状态，否则公开端点一律 404。
    """

    __tablename__ = "general_skill_share_links"
    __table_args__ = (UniqueConstraint("token", name="uq_general_skill_share_token"),)

    id: str = Field(default_factory=lambda: new_id("gsshare"), primary_key=True)
    token: str = Field(index=True)
    tenant_id: str = Field(index=True)
    skill_id: str = Field(index=True)
    skill_slug: str = Field(index=True)
    created_by: str = Field(index=True)
    # 空 = 永久有效
    expires_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None
    # 创建时缓存的文件清单（path/size）与总大小：公开信息页只读本行，
    # 不再拉 MB 级的 general_skills.skill_files_json 大字段
    files_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    total_bytes: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    access_count: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    last_access_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utc_now)


class AgentShareVisitor(SQLModel, table=True):
    """分享链接访客:一个浏览器 = 一个虚拟用户,承载独立的多轮上下文。

    `visitor_key` 是服务端签发的不可猜测随机串,前端存 localStorage 后回传,
    据此复用同一条会话线;换浏览器/清存储即得到新上下文。
    """

    __tablename__ = "agent_share_visitors"
    __table_args__ = (UniqueConstraint("visitor_key", name="uq_agent_share_visitor_key"),)

    id: str = Field(default_factory=lambda: new_id("sharevisitor"), primary_key=True)
    share_id: str = Field(index=True)
    tenant_id: str = Field(index=True)
    # users 表里的虚拟访客账号 id:作为 sessions.user_id,保证访客之间上下文互不可见
    user_id: str = Field(index=True)
    visitor_key: str = Field(index=True)
    message_count: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False, server_default="0"),
    )
    created_at: datetime = Field(default_factory=utc_now)
    last_seen_at: datetime = Field(default_factory=utc_now)


class Tool(SQLModel, table=True):
    __tablename__ = "tools"
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_tool_tenant_name"),)

    id: str = Field(default_factory=lambda: new_id("tool"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str = Field(index=True)
    display_name: Optional[str] = None
    description: Optional[str] = None
    bucket: str = Field(default="未分桶", index=True)
    tool_type: str = Field(default="http", index=True)
    method: str
    url: str
    headers_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    auth_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    config_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    input_schema: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    output_schema: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    allowed_skills_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    mcp_server_id: Optional[str] = Field(default=None, index=True)
    capability_scope: str = Field(default="general", index=True)
    capability_scope_inherited: bool = True
    enabled: bool = True
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class MCPServer(SQLModel, table=True):
    __tablename__ = "mcp_servers"
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_mcp_server_tenant_name"),)

    id: str = Field(default_factory=lambda: new_id("mcpsrv"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str = Field(index=True)
    display_name: Optional[str] = None
    description: Optional[str] = None
    bucket: str = Field(default="MCP 工具", index=True)
    # 连接方式：stdio / streamable_http / sse / builtin
    transport: str = Field(default="streamable_http", index=True)
    # streamable_http / sse 使用
    url: Optional[str] = None
    headers_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # stdio 使用
    command: Optional[str] = None
    args_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    env_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    cwd: Optional[str] = None
    # 该 server 派生工具（Tool.tool_type == "mcp"）的默认调用超时（秒）。
    # None = 沿用全局 settings.tool_timeout_seconds。MCP 子工具在界面上不可单独编辑，
    # 所以这是唯一的入口：远程 MCP 里的慢操作（渲染、转 PDF、图片生成、联网搜索）
    # 远超全局默认的 8 秒，必须能在这里按 server 调大。
    timeout_seconds: Optional[float] = None
    # MCP Apps is opt-in so legacy standard MCP servers retain identical behavior.
    apps_mode: str = Field(default="disabled", index=True)
    negotiated_capabilities_json: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSON),
    )
    # 最近一次发现的原始工具定义（预览/审计用）
    discovered_tools_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    last_synced_at: Optional[datetime] = None
    capability_scope: str = Field(default="general", index=True)
    enabled: bool = True
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class MockOrder(SQLModel, table=True):
    __tablename__ = "mock_orders"

    order_id: str = Field(primary_key=True)
    user_id: Optional[str] = Field(default=None, index=True)
    product_id: Optional[str] = Field(default=None, index=True)
    sku_id: Optional[str] = None
    quantity: int = 1
    status: str = Field(default="created", index=True)
    payment_status: Optional[str] = None
    order_status: Optional[str] = None
    signed_days: int = 0
    refundable: bool = True
    total_amount: float = 0.0
    currency: str = "CNY"
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ChatSession(SQLModel, table=True):
    __tablename__ = "sessions"

    id: str = Field(primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: Optional[str] = Field(default=None, index=True)
    agent_id: Optional[str] = Field(default=None, index=True)
    title: Optional[str] = None
    active_skill_id: Optional[str] = None
    active_step_id: Optional[str] = None
    slots_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    skill_stack_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    pending_tasks_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    resume_after_answer_json: Optional[dict[str, Any]] = Field(default=None, sa_column=Column(JSON))
    awaiting_input_json: Optional[dict[str, Any]] = Field(default=None, sa_column=Column(JSON))
    knowledge_context_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    context_state_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    summary: Optional[str] = None
    last_agent_question: Optional[str] = None
    status: str = "active"
    channel: Optional[str] = None
    # 渠道会话锚点：微信等外部渠道按 (agent_id, channel, external_conv_id) 独立建会话，
    # 同一微信好友与不同员工各自保留上下文。站内会话三者均为空。
    channel_binding_id: Optional[str] = Field(default=None, index=True)
    external_conv_id: Optional[str] = Field(default=None, index=True)
    # 历史兼容列:早期团队会话可能带非空 team_id,保留以便历史对话可读
    team_id: Optional[str] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class HumanHandoffRequest(SQLModel, table=True):
    __tablename__ = "human_handoff_requests"

    id: str = Field(default_factory=lambda: new_id("handoff"), primary_key=True)
    tenant_id: str = Field(index=True)
    session_id: str = Field(index=True)
    agent_id: Optional[str] = Field(default=None, index=True)
    requester_user_id: Optional[str] = Field(default=None, index=True)
    assignee_user_id: Optional[str] = Field(default=None, index=True)
    trigger_skill_id: Optional[str] = Field(default=None, index=True)
    trigger_step_id: Optional[str] = Field(default=None, index=True)
    context_summary: Optional[str] = None
    pending_question: Optional[str] = None
    status: str = Field(default="pending", index=True)
    human_reply: Optional[str] = None
    resume_payload_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    answered_at: Optional[datetime] = None
    # 飞书 handoff_notice 投递成功后回写的飞书 message_id;阶段 4 据此关联处理人回复。
    # 网页触发的 handoff 无此字段(为空),不影响现有网页回复链路。
    notify_message_id: Optional[str] = Field(default=None, index=True)


class ScheduledTask(SQLModel, table=True):
    __tablename__ = "scheduled_tasks"

    id: str = Field(default_factory=lambda: new_id("sched"), primary_key=True)
    tenant_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    created_by_user_id: str = Field(index=True)
    title: str
    prompt: str
    description: Optional[str] = None
    schedule_type: str = Field(default="daily", index=True)
    schedule_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    timezone: str = Field(default="Asia/Shanghai", index=True)
    rrule: Optional[str] = None
    status: str = Field(default="active", index=True)
    concurrency_policy: str = Field(default="forbid", index=True)
    misfire_policy: str = Field(default="coalesce", index=True)
    max_runs: Optional[int] = None
    end_at: Optional[datetime] = Field(default=None, index=True)
    next_run_at: Optional[datetime] = Field(default=None, index=True)
    last_run_at: Optional[datetime] = Field(default=None, index=True)
    last_status: Optional[str] = Field(default=None, index=True)
    run_count: int = 0
    lease_owner: Optional[str] = Field(default=None, index=True)
    lease_until: Optional[datetime] = Field(default=None, index=True)
    source_session_id: Optional[str] = Field(default=None, index=True)
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ScheduledTaskRun(SQLModel, table=True):
    __tablename__ = "scheduled_task_runs"
    __table_args__ = (
        UniqueConstraint("scheduled_task_id", "scheduled_for", name="uq_scheduled_task_run_due_time"),
    )

    id: str = Field(default_factory=lambda: new_id("schedrun"), primary_key=True)
    tenant_id: str = Field(index=True)
    scheduled_task_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    user_id: str = Field(index=True)
    session_id: Optional[str] = Field(default=None, index=True)
    scheduled_for: datetime = Field(index=True)
    status: str = Field(default="queued", index=True)
    started_at: Optional[datetime] = Field(default=None, index=True)
    finished_at: Optional[datetime] = Field(default=None, index=True)
    result_summary: Optional[str] = None
    error: Optional[str] = None
    trace_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class HarnessAgentLoopRecord(SQLModel, table=True):
    """Durable logical AgentLoop shared across Harness activations."""

    __tablename__ = "harness_agent_loops"
    __table_args__ = (
        UniqueConstraint(
            "session_id", "loop_key", name="uq_harness_agent_loop_session_key"
        ),
    )

    id: str = Field(default_factory=lambda: new_id("hloop"), primary_key=True)
    tenant_id: str = Field(index=True)
    session_id: str = Field(index=True)
    loop_key: str = Field(index=True)
    kind: str = Field(default="general", index=True)
    status: str = Field(default="active", index=True)
    owner_task_frame_record_id: Optional[str] = Field(default=None, index=True)
    skill_id: Optional[str] = Field(default=None, index=True)
    workspace_scope_id: Optional[str] = Field(default=None, index=True)
    checkpoint_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    last_run_id: Optional[str] = Field(default=None, index=True)
    state_version: int = 1
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    finished_at: Optional[datetime] = None


class HarnessTaskFrameRecord(SQLModel, table=True):
    """Durable TaskFrame state for the isolated Harness v2 execution path."""

    __tablename__ = "harness_task_frames"
    __table_args__ = (
        UniqueConstraint(
            "session_id", "task_id", name="uq_harness_task_frame_session_task"
        ),
    )

    id: str = Field(default_factory=lambda: new_id("htask"), primary_key=True)
    tenant_id: str = Field(index=True)
    session_id: str = Field(index=True)
    source_turn_id: str = Field(index=True)
    task_id: str = Field(index=True)
    agent_loop_id: Optional[str] = Field(default=None, index=True)
    kind: str = Field(default="conversation", index=True)
    decision: str = Field(default="answer_only", index=True)
    status: str = Field(default="queued", index=True)
    sequence: int = 0
    skill_id: Optional[str] = Field(default=None, index=True)
    step_id: Optional[str] = Field(default=None, index=True)
    # 场景帧专用（execution_mode="scene_module"）。与 skill_id 语义平行：
    # 一个帧要么跑 SOP，要么跑场景实例，要么是普通对话。
    # 独立列而不是塞进 slots_json —— 后者会被 persist_plan 合并进会话槽位、
    # 进而污染 LLM 上下文（见 arch §5.2）。
    scene_id: Optional[str] = Field(default=None, index=True)
    user_intent: Optional[str] = None
    requirements_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    slots_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    depends_on_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    task_requirement_json: dict[str, Any] = Field(
        default_factory=dict, sa_column=Column(JSON)
    )
    result_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    error_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    state_version: int = 1
    attempt_no: int = 0
    lease_owner: Optional[str] = Field(default=None, index=True)
    lease_expires_at: Optional[datetime] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class HarnessRunRecord(SQLModel, table=True):
    __tablename__ = "harness_runs"

    id: str = Field(default_factory=lambda: new_id("hrun"), primary_key=True)
    tenant_id: str = Field(index=True)
    session_id: str = Field(index=True)
    task_frame_record_id: str = Field(index=True)
    agent_loop_id: Optional[str] = Field(default=None, index=True)
    task_id: str = Field(index=True)
    source_turn_id: str = Field(index=True)
    status: str = Field(default="running", index=True)
    attempt_no: int = 1
    lease_owner: Optional[str] = Field(default=None, index=True)
    lease_expires_at: Optional[datetime] = Field(default=None, index=True)
    action_count: int = 0
    task_requirement_json: dict[str, Any] = Field(
        default_factory=dict, sa_column=Column(JSON)
    )
    capability_snapshot_json: dict[str, Any] = Field(
        default_factory=dict, sa_column=Column(JSON)
    )
    result_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    started_at: datetime = Field(default_factory=utc_now)
    finished_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class HarnessTurnRecord(SQLModel, table=True):
    """Exactly-once receipt for one client-addressable Harness turn."""

    __tablename__ = "harness_turns"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "session_id",
            "client_turn_id",
            name="uq_harness_turn_client_receipt",
        ),
    )

    id: str = Field(default_factory=lambda: new_id("hturn"), primary_key=True)
    tenant_id: str = Field(index=True)
    session_id: str = Field(index=True)
    client_turn_id: str = Field(index=True)
    request_digest: str = Field(index=True)
    status: str = Field(default="started", index=True)
    lease_owner: str = Field(index=True)
    lease_expires_at: datetime = Field(index=True)
    user_message_id: Optional[str] = Field(default=None, index=True)
    response_json: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSON),
    )
    error_json: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSON),
    )
    started_at: datetime = Field(default_factory=utc_now)
    finished_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class HarnessSessionLeaseRecord(SQLModel, table=True):
    """Cross-process execution fence for one Harness chat session."""

    __tablename__ = "harness_session_leases"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "session_id",
            name="uq_harness_session_execution_lease",
        ),
    )

    id: str = Field(default_factory=lambda: new_id("hslease"), primary_key=True)
    tenant_id: str = Field(index=True)
    session_id: str = Field(index=True)
    lease_owner: str = Field(index=True)
    lease_expires_at: datetime = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class HarnessInvocationRecord(SQLModel, table=True):
    __tablename__ = "harness_invocations"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "call_id", name="uq_harness_invocation_run_call"
        ),
    )

    id: str = Field(default_factory=lambda: new_id("hinvoke"), primary_key=True)
    tenant_id: str = Field(index=True)
    session_id: str = Field(index=True)
    task_id: str = Field(index=True)
    run_id: str = Field(index=True)
    call_id: str = Field(index=True)
    tool_name: str = Field(index=True)
    request_digest: str = Field(index=True)
    logical_action_key: Optional[str] = Field(
        default=None,
        unique=True,
        index=True,
    )
    replayed_from_invocation_id: Optional[str] = Field(default=None, index=True)
    status: str = Field(default="started", index=True)
    arguments_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    result_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    response_cache_json: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSON),
    )
    approval_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    started_at: datetime = Field(default_factory=utc_now)
    finished_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class Message(SQLModel, table=True):
    __tablename__ = "messages"

    id: str = Field(default_factory=lambda: new_id("msg"), primary_key=True)
    tenant_id: str = Field(index=True)
    session_id: str = Field(index=True)
    role: str
    content: str
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)


class MessageFeedback(SQLModel, table=True):
    __tablename__ = "message_feedback"
    __table_args__ = (UniqueConstraint("tenant_id", "message_id", "user_id", name="uq_feedback_message_user"),)

    id: str = Field(default_factory=lambda: new_id("fb"), primary_key=True)
    tenant_id: str = Field(index=True)
    session_id: str = Field(index=True)
    message_id: str = Field(index=True)
    user_id: str = Field(index=True)
    rating: str = Field(index=True)
    analysis_status: str = Field(default="pending", index=True)
    analysis_bucket: Optional[str] = Field(default=None, index=True)
    analysis_reason: Optional[str] = None
    analysis_summary: Optional[str] = None
    analysis_confidence: Optional[float] = None
    analysis_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    analyzed_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class SkillFeedback(SQLModel, table=True):
    __tablename__ = "skill_feedback"
    __table_args__ = (UniqueConstraint("tenant_id", "message_id", "user_id", name="uq_skill_feedback_message_user"),)

    id: str = Field(default_factory=lambda: new_id("skillfb"), primary_key=True)
    tenant_id: str = Field(index=True)
    skill_id: str = Field(index=True)
    skill_version: Optional[str] = Field(default=None, index=True)
    step_id: Optional[str] = Field(default=None, index=True)
    session_id: str = Field(index=True)
    message_id: str = Field(index=True)
    user_id: str = Field(index=True)
    rating: str = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentEvent(SQLModel, table=True):
    __tablename__ = "agent_events"

    id: str = Field(default_factory=lambda: new_id("evt"), primary_key=True)
    tenant_id: str = Field(index=True)
    session_id: str = Field(index=True)
    event_type: str = Field(index=True)
    payload_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)


class AgentUnansweredQuery(SQLModel, table=True):
    """反馈自进化 · 无法回答的 query（自动收集）。

    来源：知识直答路径检索不足 / 模型拒答。同员工同问哈希去重合并计数，
    采纳进 FAQ 或被忽略后状态流转，不再出现在待处理列表。
    """

    __tablename__ = "agent_unanswered_queries"
    __table_args__ = (
        UniqueConstraint("tenant_id", "agent_id", "query_hash", name="uq_unanswered_agent_query"),
    )

    id: str = Field(default_factory=lambda: new_id("unq"), primary_key=True)
    tenant_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    # 归一化（去空白/全角转半角/lower）后的 md5，去重键
    query_hash: str = Field(index=True)
    query: str
    hit_count: int = Field(
        default=1, sa_column=Column(Integer, nullable=False, server_default="1")
    )
    source: str = Field(default="knowledge_refusal", index=True)
    status: str = Field(default="pending", index=True)
    last_session_id: Optional[str] = None
    last_message_id: Optional[str] = None
    faq_item_id: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentFaqItem(SQLModel, table=True):
    """员工 FAQ：owner/管理员确认后的标准问答，对话命中即短路直答。

    命中判定用 keywords 词法匹配（≥2 个关键词同时命中），不依赖 embedding。
    """

    __tablename__ = "agent_faq_items"

    id: str = Field(default_factory=lambda: new_id("faq"), primary_key=True)
    tenant_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    question: str
    answer_markdown: str = ""
    keywords_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    source: str = Field(default="manual", index=True)
    source_id: Optional[str] = None
    status: str = Field(default="active", index=True)
    usage_count: int = Field(
        default=0, sa_column=Column(Integer, nullable=False, server_default="0")
    )
    created_by_user_id: str = Field(index=True)
    adopted_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentFaqIgnoredHandoff(SQLModel, table=True):
    """被 owner 从「待沉淀」里删掉的转人工记录。

    HumanHandoffRequest 的 answered 是业务状态不能改（会话恢复/审计要用），
    所以忽略动作单独落表，列表查询时排除。同一 handoff 忽略一次即可。
    """

    __tablename__ = "agent_faq_ignored_handoffs"
    __table_args__ = (
        UniqueConstraint("tenant_id", "agent_id", "handoff_id", name="uq_ignored_handoff"),
    )

    id: str = Field(default_factory=lambda: new_id("fign"), primary_key=True)
    tenant_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    handoff_id: str = Field(index=True)
    created_by_user_id: str = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)


class MemoryRecord(SQLModel, table=True):
    __tablename__ = "memories"

    id: str = Field(default_factory=lambda: new_id("mem"), primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    username: Optional[str] = Field(default=None, index=True)
    session_id: Optional[str] = Field(default=None, index=True)
    kind: str = Field(default="conversation", index=True)
    content: str
    importance: float = 0.5
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


# ---------------------------------------------------------------------------
# AI Reviewer（代码评审）：平台凭证 / 工作区 / 全局 review 要求 / 异步评审任务
# 整体是「提交任务 → rq 后台跑 ocr CLI → 回写结果 → 用户在任务列表看结果」的
# 异步模型；PR/MR 快照在建任务时落库，ocr 不在请求路径上。
# ---------------------------------------------------------------------------


class AiReviewCredential(SQLModel, table=True):
    """平台访问凭证（**租户级全局**）：拉取 PR/MR 列表与详情用。

    一个租户每个平台最多一条（GitHub / GitLab 各一）。token 以明文落库，
    API 层只对外回 ``token_last4``；GitLab 支持自托管，所以保留 ``base_url``。
    """

    __tablename__ = "ai_review_credentials"
    __table_args__ = (
        UniqueConstraint("tenant_id", "platform", name="uq_ai_review_credential_platform"),
    )

    id: str = Field(default_factory=lambda: new_id("airevcred"), primary_key=True)
    tenant_id: str = Field(index=True)
    # github / gitlab
    platform: str = Field(index=True)
    # GitLab 自托管时填实例根地址（https://gitlab.example.com）；github 侧忽略
    base_url: str = ""
    token: str = ""
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AiReviewWorkspace(SQLModel, table=True):
    """一个 workspace = 一个待评审仓库（按 repo 区分），挂平台与克隆地址。"""

    __tablename__ = "ai_review_workspaces"

    id: str = Field(default_factory=lambda: new_id("airevws"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str
    # github / gitlab（决定用哪张全局凭证与哪套 REST 调用）
    platform: str = Field(index=True)
    # https 克隆地址，如 https://gitlab.example.com/group/repo.git
    repo_url: str
    # 平台展示路径，如 group/repo（列表接口要用）
    repo_path: str = ""
    default_branch: str = "main"
    created_by: str = ""
    created_at: datetime = Field(default_factory=utc_now)


class AiReviewPreset(SQLModel, table=True):
    """全局「review 要求」预设：提交任务时可附加，作为公共评审口径。"""

    __tablename__ = "ai_review_presets"

    id: str = Field(default_factory=lambda: new_id("airevpreset"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str
    content: str
    # 每个租户至多一条 default：新建任务时用它预填
    is_default: bool = Field(default=False, index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AiReviewRuleFile(SQLModel, table=True):
    """租户级全局自定义评审规则（对应 ocr 的 ``rule.json``）。

    执行时以 ``ocr review --rule <file>`` 注入，属于四层规则链里**最高优先级**
    （高于项目/全局配置文件与系统内置规则）。结构：
    ``{"include": [...], "exclude": [...], "rules": [{"path", "rule", "merge_system_rule"}]}``。
    一个租户至多一份（唯一约束）。
    """

    __tablename__ = "ai_review_rule_files"
    __table_args__ = (
        UniqueConstraint("tenant_id", name="uq_ai_review_rule_file_tenant"),
    )

    id: str = Field(default_factory=lambda: new_id("airevrule"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str = ""
    content: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AiReviewTask(SQLModel, table=True):
    """一次异步评审任务：建任务时冻结 PR/MR 快照，ocr 结果回写 ``result_json``。

    ``status`` 四态：queued（已入队）→ running（ocr 执行中）→ succeeded / failed。
    全部字段在**建任务时**固化（标题、描述、分支、作者），后续 MR 更新不影响
    本次评审的口径； ``result_json`` 存 ocr 的 comments 数组。
    """

    __tablename__ = "ai_review_tasks"
    # 同一 PR/MR 同时只允许一条进行中任务（部分唯一索引，PG 与 SQLite 都支持
    # WHERE 子句）。应用层在创建 / 重试时已拦一道，这里是并发写入的兜底。
    # 新库由 create_all 直接建；存量库的这条索引 2026-11-08 已确认在位
    # （原来的补建迁移已随 init_db 的迁移层一起删除）。
    __table_args__ = (
        Index(
            "uq_ai_review_task_in_flight",
            "tenant_id",
            "workspace_id",
            "mr_number",
            unique=True,
            postgresql_where=text("status IN ('queued', 'running')"),
            sqlite_where=text("status IN ('queued', 'running')"),
        ),
    )

    id: str = Field(default_factory=lambda: new_id("airevtask"), primary_key=True)
    tenant_id: str = Field(index=True)
    workspace_id: str = Field(index=True)
    # queued / running / succeeded / failed
    status: str = Field(default="queued", index=True)
    # ---- PR/MR 快照（建任务时冻结）----
    mr_number: int = 0
    mr_title: str = ""
    mr_description: str = ""
    source_branch: str = ""
    target_branch: str = ""
    author: str = ""
    web_url: str = ""
    # ---- 用户附加的评审要求（快照，预设后续改动不影响已建任务）----
    requirements: str = ""
    # ---- 执行结果 ----
    result_json: list[Any] = Field(default_factory=list, sa_column=Column(JSON))
    summary_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    error: str = ""
    # ---- 结果回写平台评论区（查看报告时可把意见同步到 PR/MR）----
    platform_synced_at: Optional[datetime] = None
    platform_sync_url: str = ""
    created_by: str = ""
    created_at: datetime = Field(default_factory=utc_now, index=True)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None


class PlazaNewsCache(SQLModel, table=True):
    """开放广场首页新闻的每日缓存。

    同一租户同一天只抓取一次 RSS 源（tenant_id + cache_date 唯一）；
    抓取失败时回退读最近一天缓存，再退到 API 内置种子新闻。
    """

    __tablename__ = "plaza_news_cache"
    __table_args__ = (
        UniqueConstraint("tenant_id", "cache_date", name="uq_plaza_news_tenant_date"),
    )

    id: str = Field(default_factory=lambda: new_id("pnews"), primary_key=True)
    tenant_id: str = Field(index=True)
    # 缓存归属日期（YYYY-MM-DD，租户本地时区语义上按「天」粒度即可）
    cache_date: str = Field(index=True)
    # {"ai": [item...], "travel": [item...]}，item: {title, summary, source, url, published_at, category}
    items_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # provenance: rss / fallback（种子兜底）
    provenance: str = Field(default="rss")
    updated_at: datetime = Field(default_factory=utc_now)


class AppUsageCounter(SQLModel, table=True):
    """「本地清单类」应用的使用计数（如 OA 单据助手 / AI 单据助手）。

    Agent 广场里的定制 Agent（agent-catalog.json）是**前端本地清单、不落库**，
    没有 agent_profiles 行，也就没有 usage_count；但首页热门排行榜要统计它们。
    这里给这类应用一个全局计数器：浏览器书签面板每次代填成功 +1。

    app_key 全局唯一（不按租户分）：面板注入在用户的 OA 页面里、不带租户身份，
    而这个应用对所有租户都是同一个。
    """

    __tablename__ = "app_usage_counters"

    id: str = Field(default_factory=lambda: new_id("appuse"), primary_key=True)
    app_key: str = Field(sa_column=Column(String, nullable=False, unique=True))
    usage_count: int = Field(default=0, sa_column=Column(Integer, nullable=False, server_default="0"))
    updated_at: datetime = Field(default_factory=utc_now)


class ToolAccessRequest(SQLModel, table=True):
    """员工申请使用工具广场中的工具。审批通过后绑定到申请员工。"""

    __tablename__ = "tool_access_requests"
    __table_args__ = (
        Index("ix_tool_access_requests_tenant_status", "tenant_id", "status"),
    )

    id: str = Field(default_factory=lambda: new_id("toolreq"), primary_key=True)
    tenant_id: str = Field(index=True)
    tool_id: str = Field(index=True)
    tool_name: str = Field(default="")
    agent_id: str = Field(index=True)
    agent_name: str = Field(default="")
    requested_by_user_id: str = Field(index=True)
    requested_by_username: str = Field(default="")
    status: str = Field(default="pending", index=True)
    reviewed_by_user_id: Optional[str] = Field(default=None, index=True)
    reviewed_by_username: Optional[str] = None
    review_note: Optional[str] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    reviewed_at: Optional[datetime] = None


class UserNotification(SQLModel, table=True):
    """站内消息：右上角「我的消息」。"""

    __tablename__ = "user_notifications"
    __table_args__ = (
        Index("ix_user_notifications_tenant_user", "tenant_id", "user_id"),
    )

    id: str = Field(default_factory=lambda: new_id("notif"), primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    kind: str = Field(default="system", index=True)
    title: str
    message: str = Field(default="")
    link: Optional[str] = None
    read_at: Optional[datetime] = None
    metadata_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)


class StaticAsset(SQLModel, table=True):
    """个人静态资源：上传后得到一个稳定的公开下载地址。

    与知识库的区别：知识库把文件拆成段落喂给模型读；这里是把原文件原样给用户下载。
    因此正文不进检索，只提供地址。

    token 是对外的唯一定位符（不可枚举、12 字符），``status=deleted`` 后下载端点
    返回 410 而不是 404 —— 便于区分「被删了」与「从来没存在过」。
    """

    __tablename__ = "static_assets"
    __table_args__ = (
        Index("ix_static_assets_tenant_owner", "tenant_id", "owner_user_id"),
        Index("ix_static_assets_tenant_sha", "tenant_id", "sha256"),
    )

    id: str = Field(default_factory=lambda: new_id("sasset"), primary_key=True)
    tenant_id: str = Field(index=True)
    owner_user_id: str = Field(index=True)
    token: str = Field(sa_column=Column(String, nullable=False, unique=True))
    filename: str
    content_type: str = Field(default="application/octet-stream")
    size: int = Field(default=0, sa_column=Column(Integer, nullable=False, server_default="0"))
    sha256: str = Field(index=True)
    status: str = Field(default="active", index=True)
    download_count: int = Field(
        default=0, sa_column=Column(Integer, nullable=False, server_default="0")
    )
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    deleted_at: Optional[datetime] = None


# --------------------------------------------------------------------------
# 微信渠道（个人微信 iLink 协议）
#
# 一个租户可建多个绑定（每个绑定 = 一个扫码登录的微信 bot，账号唯一锚点是
# ilink_bot_id）。一个绑定下可挂载多个数字员工，会话按
# (agent_id, channel, external_conv_id) 各自独立，所以切换员工天然隔离上下文。
# --------------------------------------------------------------------------


class WechatBinding(SQLModel, table=True):
    """微信 bot 接入绑定：一次扫码登录一行。

    ``bot_token`` 是 iLink 业务请求的唯一凭证，与 ``ilink_bot_id`` 一起标识
    一个 bot 账号；两者都加密/独立存储，明文不落库、不进日志。
    ``status`` 三态：pending（二维码已出但未确认）/ active / disconnected。
    """

    __tablename__ = "wechat_bindings"
    __table_args__ = (
        Index("ix_wechat_bindings_tenant_status", "tenant_id", "status"),
        Index("ix_wechat_bindings_tenant_owner", "tenant_id", "owner_user_id"),
        # 同一个微信 bot（ilink_bot_id）在整个租户内只能有一条绑定：
        # 并发扫码确认会同时走到「新建」分支，没有这条约束就会生成两条重复绑定
        # （表现为前端弹多次成功提醒）。空 ilink_bot_id 是 pending 态占位，不参与唯一性。
        #
        # 注意它约束的是「一个 bot 只能绑一次」，不是「一个租户只能有一个 bot」：
        # 每个人扫自己的微信各自成一个 bot，多个 bot 并存是正常的（按 owner 区分）。
        Index(
            "uq_wechat_bindings_tenant_bot",
            "tenant_id",
            "ilink_bot_id",
            unique=True,
            postgresql_where=text("ilink_bot_id <> ''"),
            sqlite_where=text("ilink_bot_id <> ''"),
        ),
        # 一个用户对自己的微信只留一条活跃绑定：重复扫码应恢复而不是再建一条。
        Index(
            "uq_wechat_bindings_owner_active",
            "tenant_id",
            "owner_user_id",
            unique=True,
            postgresql_where=text("status = 'active' AND owner_user_id IS NOT NULL"),
            sqlite_where=text("status = 'active' AND owner_user_id IS NOT NULL"),
        ),
    )

    id: str = Field(default_factory=lambda: new_id("wxbind"), primary_key=True)
    tenant_id: str = Field(index=True)
    # 建绑定的操作人（站内用户），用于权限与展示归属
    owner_user_id: Optional[str] = Field(default=None, index=True)
    # 微信侧 bot 账号标识（扫码 confirmed 后下发），同一 bot 重复扫码时据此恢复而非新建
    ilink_bot_id: str = Field(default="", index=True)
    # 扫码人（bot 所有者）的微信 ID，如 xxx@im.wechat
    ilink_user_id: str = Field(default="")
    # bot_token 密文（Fernet），业务请求 Bearer
    bot_token_enc: str = Field(default="")
    # iLink 基址，默认官方域；入库前白名单校验
    base_url: str = Field(default="https://ilinkai.weixin.qq.com")
    status: str = Field(default="pending", index=True)
    # getupdates 增量游标，长轮询线程持久化续传，重启不丢消息
    updates_cursor: str = Field(default="")
    # 展示名，默认取 bot 昵称；解绑后保留便于历史识别
    display_name: str = Field(default="")
    # typing_ticket 缓存（"正在输入"需要），按外部用户维度存 config_json
    config_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    last_error: str = Field(default="")
    last_seen_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class WechatBindingAgent(SQLModel, table=True):
    """绑定下挂载的可调度员工。

    挂载集是「用户在微信里能 /切换 到的员工」的唯一来源。没有挂载行的存量
    绑定回退为该租户的默认员工（见 routing.mounted_agents），不依赖回填。
    """

    __tablename__ = "wechat_binding_agents"
    __table_args__ = (
        UniqueConstraint("binding_id", "agent_id", name="uq_wechat_binding_agent"),
        Index("ix_wechat_binding_agents_binding_sort", "binding_id", "sort_order"),
    )

    id: str = Field(default_factory=lambda: new_id("wxmnt"), primary_key=True)
    tenant_id: str = Field(index=True)
    binding_id: str = Field(index=True)
    agent_id: str = Field(index=True)
    # 新会话的初始员工；一个绑定只应有一个 True（应用层保证唯一）
    is_default: bool = Field(default=False)
    sort_order: int = Field(default=0, sa_column=Column(Integer, nullable=False, server_default="0"))
    created_at: datetime = Field(default_factory=utc_now)


class WechatConvState(SQLModel, table=True):
    """每个微信会话的当前员工指针 + 数字菜单窗口。

    这是「切换员工」的状态核心：外部会话（一个微信好友）→ 当前 agent。
    ``menu_agents_json`` 记录最近一次 /员工 输出的编号顺序，``menu_expires_at``
    到期后裸数字不再当菜单选择，避免用户正常提问「3 个问题」被误判成切换。
    """

    __tablename__ = "wechat_conv_states"
    __table_args__ = (
        UniqueConstraint("binding_id", "external_conv_id", name="uq_wechat_conv_state"),
    )

    id: str = Field(default_factory=lambda: new_id("wxconv"), primary_key=True)
    tenant_id: str = Field(index=True)
    binding_id: str = Field(index=True)
    # 外部会话标识，p2p 为 wechat_p2p_<外部用户 id>
    external_conv_id: str = Field(index=True)
    current_agent_id: str = Field(default="", index=True)
    # 菜单窗口：编号列表（agent_id 有序）与过期时间
    menu_agents_json: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    menu_expires_at: Optional[datetime] = None
    # 每次指针变动 +1，用于并发 compare-and-set（迟到的旧轮不覆盖新指针）
    routing_revision: int = Field(
        default=0, sa_column=Column(Integer, nullable=False, server_default="0")
    )
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class WechatInboundEvent(SQLModel, table=True):
    """入站事件幂等登记：同一 (binding_id, event_id) 只处理一次。

    iLink 的 getupdates 在异常重连/游标回退时可能重放同一批消息，
    没有这张表就会重复调 LLM、重复发消息。
    """

    __tablename__ = "wechat_inbound_events"
    __table_args__ = (
        UniqueConstraint("binding_id", "event_id", name="uq_wechat_inbound_event"),
    )

    id: str = Field(default_factory=lambda: new_id("wxevent"), primary_key=True)
    tenant_id: str = Field(index=True)
    binding_id: str = Field(index=True)
    event_id: str = Field(index=True)
    external_conv_id: str = Field(default="", index=True)
    # processing / done / failed
    status: str = Field(default="processing", index=True)
    error: str = Field(default="")
    payload_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class WechatIdentityLink(SQLModel, table=True):
    """微信身份 ↔ 站内账号绑定。

    未绑定时微信用户按外部 id 懒建独立账号（source='wechat'），不占用租户成员
    名额；``/绑定 <码>`` 后把会话与记忆归属迁到实名 User，``/解绑`` 反向迁回。
    """

    __tablename__ = "wechat_identity_links"
    __table_args__ = (
        UniqueConstraint("binding_id", "external_user_id", name="uq_wechat_identity_external"),
        UniqueConstraint("binding_id", "user_id", name="uq_wechat_identity_user"),
    )

    id: str = Field(default_factory=lambda: new_id("wxlink"), primary_key=True)
    tenant_id: str = Field(index=True)
    binding_id: str = Field(index=True)
    # 微信侧用户 id，如 xxx@im.wechat
    external_user_id: str = Field(index=True)
    # 绑定前的懒建账号（解绑时迁回的目标）
    channel_user_id: str = Field(index=True)
    # 绑定的站内账号
    user_id: str = Field(index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


# ============================================================
# 场景（Scene）：数据表驱动的结构化业务应答
#
# 与知识库是两条完全独立的链路：Excel/CSV 的解析结果**不进 chunk 池**，
# 单独落列定义与行数据，用结构化条件匹配，而不是词法/向量检索。
# 设计依据见 docs/scenes/scene-design.md。
# ============================================================


class SceneTable(SQLModel, table=True):
    """场景数据表：一张 Excel/CSV 的结构化形态。

    一个 SceneTable 由一个上传文件而来（复用知识库的附件/权限体系），
    但解析结果不进 chunk 池，单独落 columns_json + SceneTableRow。

    归属关系（v3）：``scene_id`` 表达「这张表属于哪个场景」——一张表只属于
    一个场景，不是「被引用」（多对多 join 表会引入共享表的引用计数问题）。
    ``tenant_id`` 保留：多租户隔离与既有查询仍走它。

    ``scene_id`` 默认空串是为了让**存量孤儿表**（v2 及以前没有归属的表）
    能被安全忽略而不是让查询报错；孤儿表永远不会进 ``load_scene_tables``。
    """

    __tablename__ = "scene_tables"

    id: str = Field(default_factory=lambda: new_id("sctable"), primary_key=True)
    tenant_id: str = Field(index=True)
    # 归属场景。空串 = 存量孤儿表 / 尚未挂到任何场景（v3 清空重建后不会出现）
    scene_id: str = Field(default="", index=True)
    # 合并池内的表次序（多表时按它拼行，保证结果可复现）
    order_index: int = 0
    # 列结构指纹（列 key + type + unit 的有序哈希）。第二张表上传时秒判同构；
    # 生成逻辑与同构校验必须共用 scene_modules.channels.columns_signature 一处
    columns_signature: str = Field(default="")
    name: str = ""
    source_filename: str = ""
    source_document_id: Optional[str] = Field(default=None, index=True)
    # 列定义：[{key,label,type,unit,aliases,required,filterable,order}]
    columns_json: list[Any] = Field(default_factory=list, sa_column=Column(JSON))
    # 导入时检出的质量问题：[{level,code,message,column,row_count}]
    quality_json: list[Any] = Field(default_factory=list, sa_column=Column(JSON))
    row_count: int = Field(default=0)
    status: str = Field(default="ready", index=True)  # ready | parsing | failed
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class SceneTableRow(SQLModel, table=True):
    """数据表的一行。row_json 存原始值（字符串原样），norm_json 存归一化结果。

    刻意存两份：原值用来展示「表里到底写了什么」（用户会来对账），
    归一化值用来匹配。只存归一化值会导致排查时无法回答「为什么这行没命中」。
    """

    __tablename__ = "scene_table_rows"
    __table_args__ = (Index("ix_scene_table_rows_table_order", "table_id", "row_index"),)

    id: str = Field(default_factory=lambda: new_id("scrow"), primary_key=True)
    tenant_id: str = Field(index=True)
    table_id: str = Field(index=True)
    row_index: int = Field(default=0)
    row_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # {列key: {num, unit, raw, ok}}；ok=False 表示该值无法归一化（TBD/面议等）
    norm_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)


class Scene(SQLModel, table=True):
    """场景实例（v3）：一个 ``module_key`` + 一份配置 + 0..N 张私有数据表。

    定位变化（v2 → v3）：从「定义 + 表引用」降为「模块实例」。
    处理逻辑由 ``scene_type`` 四选一（复用后端已有引擎），UI 由前端
    ``scenes/modules/<module_key>/`` 的代码渲染，后端只产出纯数据块。

    归属关系走 AgentResourceBinding(resource_type="scene")，而不是在
    本表上加 agent_id 单列 —— 这样员工详情页的资源计数、删除员工时的级联清理、
    「从其他员工复制资源」这些能力全部免费复用，不需要另写一套。
    """

    __tablename__ = "scenes"
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_scene_tenant_name"),)

    id: str = Field(default_factory=lambda: new_id("scene"), primary_key=True)
    tenant_id: str = Field(index=True)
    name: str
    description: str = ""
    icon: str = ""
    status: str = Field(default="draft", index=True)  # draft | published | archived
    # ---- v3 新增：模块实例身份 ----
    # 四选一，决定走 channels 的哪个处理通道。事实来源就是这一列
    # （不从 module_key 反推，否则「同一 module 换类型」会静默错）。
    scene_type: str = Field(default="table_match", index=True)
    # 前端渲染目录名，值必须 === 目录名（arch §2.5.1）。
    # 空串 = 未装配 —— 新建时按 scene_type 预填，所以正常永远非空；
    # 空串只出现在手工清空，发布校验会拦它。
    module_key: str = Field(default="", index=True)
    module_version: int = Field(default=1)
    # {schema_version, params, fallback_text}。**不放 module_key 冗余**：
    # Scene.module_key 是唯一事实来源（决策 2）。
    # params 由 module 的 params_schema 定义，框架从不读取其内容，只透传。
    ui_config_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # 模块私有参数（框架从不读内容，只透传给前端 module）。
    # 与 ui_config_json.params 的分工：前者是「模块自己的状态」，
    # 后者是「管理员在定义器里配的展示参数」。
    module_config_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # ---- 既有配置列（各占独立列，语义各自明确，**不合并成万能 config_json**）----
    # 意图：keywords / examples / entry chip 文案的实例覆盖值
    trigger_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # 槽位实例配置（label / required / target / unit），table_match 主要消费方
    slots_json: list[Any] = Field(default_factory=list, sa_column=Column(JSON))
    # table_match 专属匹配参数（权重 / 容差 / 闸门 / top_k）
    match_action_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # 回答模板 / 语气（也被 script / sop_flow 通道当作兜底文案来源）
    respond_action_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # 入口胶囊的实例覆盖（label / icon）。on_click 已移出——
    # 入口行为由 module 的 meta.entry_behavior 声明（PRD §19 第 6 条）
    shortcut_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # ---- 类型专属配置列（impl-map §4 第 7 条：字段设计现在就要对，不可砍）----
    # sop_flow 的流程定义 / handoff 的转人工参数 / script 的话术表。
    # 各占一列而不是塞进一个 config_json：类型切换时旧类型的配置必须保留，
    # 切回来能恢复；合并容器会让它们互相覆盖。
    flow_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    handoff_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    scripts_json: list[Any] = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class SceneRun(SQLModel, table=True):
    """一次场景执行，用于排障与效果分析。

    「为什么这次没推荐出东西」是这类功能最高频的运维问题，
    不落 trace 就只能靠复现。
    """

    __tablename__ = "scene_runs"

    id: str = Field(default_factory=lambda: new_id("scrun"), primary_key=True)
    tenant_id: str = Field(index=True)
    scene_id: str = Field(index=True)
    # 冗余一份 module_key，便于按模块筛排障记录（scene 可能已被删/改名）
    module_key: str = Field(default="", index=True)
    session_id: str = Field(default="", index=True)
    user_id: str = Field(default="", index=True)
    input_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    result_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    trace_json: list[Any] = Field(default_factory=list, sa_column=Column(JSON))
    status: str = Field(default="ok", index=True)  # ok | no_match | error
    feedback: str = Field(default="")
    created_at: datetime = Field(default_factory=utc_now)
