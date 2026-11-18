"""「待回答」上下文包（brief）的实时计算。

为什么是实时计算而不是落库快照：
`session.status='handoff'` 期间用户仍然可以继续发消息，任何在 handoff 创建
时刻存下来的快照都会在 15 秒轮询内立刻过期。brief 每次读取时按需重算，
只依赖已经落库的 session / message / handoff 三张表。

这个模块只负责「把已有数据整理成人能一眼看懂的形状」，不做业务决策：
- 结论（findings）只从 handoff 自己保存的 `metadata.step_reply` 里抽，
  不重新调模型 —— 那是 P1 的事，P0 保持零模型成本、结果可预测。
- slots 的 key 是 SOP 内部命名（employee_id / access_level），
  这里补一层中文 label 映射，避免 owner 看到 `employee_id: 3019`。
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable

from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.core.plan.planner_fastpath import is_handoff_trigger_only
from app.db.models import ChatSession, HumanHandoffRequest, Message, utc_now

# 单条 transcript 消息的字符上限。旧实现是 context_summary 里 240 字硬切，
# 那个值太小（Outlook 那单直接断在「需」字），但也不能整段塞进响应体。
TRANSCRIPT_MESSAGE_CHARS = 600
# 默认取最近多少条消息。6 条的会话全给，长会话只给尾部。
TRANSCRIPT_LIMIT = 12
# findings 条数上限，超过的部分前端折叠。
FINDINGS_LIMIT = 8
SLOTS_LIMIT = 12

# SOP slot key → 中文 label。查不到的 key 原样展示（总比丢掉好）。
_SLOT_LABELS: dict[str, str] = {
    "employee_id": "员工工号",
    "employee_no": "员工工号",
    "staff_id": "员工工号",
    "employee_name": "员工姓名",
    "user_name": "员工姓名",
    "name": "姓名",
    "system": "目标系统",
    "system_name": "目标系统",
    "target_system": "目标系统",
    "permission": "权限级别",
    "permission_level": "权限级别",
    "access_level": "访问范围",
    "environment": "访问范围",
    "env": "访问范围",
    "routing": "流转方式",
    "handoff_target": "流转目标",
    "ticket_id": "工单号",
    "ticket_no": "工单号",
    "order_id": "订单号",
    "order_no": "订单号",
    "amount": "金额",
    "reason": "申请事由",
    "department": "所属部门",
    "email": "邮箱",
    "phone": "联系电话",
}

# 这些 key 是 SOP 内部的记账/路由信息，不是「用户填的事实」。
# 展示出来会让 owner 以为用户说过这句话（permission_preference 实际是模型
# 推断的倾向），或者暴露内部节点 id（approval_path = n6_handoff）。
_INTERNAL_SLOT_KEYS: frozenset[str] = frozenset(
    {
        "permission_preference",
        "approval_path",
        "routing_path",
        "handoff_status",
        "current_node",
        "node_id",
        "step_id",
    }
)

# 系统名的大小写归一。SOP 里常被写成 crm / oa，直接展示不专业。
_SYSTEM_NAME_LABELS: dict[str, str] = {
    "crm": "CRM",
    "oa": "OA 系统",
    "sap": "SAP",
    "erp": "ERP",
    "hrm": "HRM",
    "vpn": "VPN",
    "wiki": "Wiki",
}

# 判断某个 slot key 是否承载「系统名」
_SYSTEM_KEYS: frozenset[str] = frozenset({"system", "system_name", "target_system"})

# slot 值映射。SOP 里这类枚举常写成英文（admin / production / manual_approval），
# 直接展示会变成「权限级别 admin · 访问范围 production」这种中英混排。
_SLOT_VALUE_LABELS: dict[str, str] = {
    "admin": "管理员",
    "administrator": "管理员",
    "normal": "普通",
    "readonly": "只读",
    "read": "只读",
    "write": "读写",
    "read_write": "读写",
    "rw": "读写",
    "production": "生产环境",
    "prod": "生产环境",
    "staging": "预发布环境",
    "test": "测试环境",
    "testing": "测试环境",
    "dev": "开发环境",
    "development": "开发环境",
    "manual_approval": "人工审批",
    "auto_approval": "自动审批",
}

# slot 展示顺序：先业务主键，再其余。不在表里的排最后。
_SLOT_ORDER: tuple[str, ...] = (
    "employee_id",
    "employee_no",
    "staff_id",
    "employee_name",
    "system",
    "system_name",
    "target_system",
    "permission",
    "permission_level",
    "access_level",
    "environment",
    "env",
    "ticket_id",
    "handoff_target",
    "routing",
)

# 纯转接话术，不构成「AI 已经排查过什么」。
_BOILERPLATE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^(已|正在)?为?您?(发起|转接|转交|转达)"),
    re.compile(r"^已经?收到您的转人工请求"),
    re.compile(r"^已收到您的(转人工)?请求"),
    re.compile(r"^后续由人工(客服|同事)"),
    re.compile(r"^人工客服可直接沿用"),
    re.compile(r"^无需您重复描述"),
    re.compile(r"^请(您)?稍候"),
)

# 「还缺哪些信息」这类清单不是排查结论，而是待办事项——列在「AI 已经排查过」
# 里会让人误以为已经查清了。命中这些前缀的 bullet 整段丢弃。
_PENDING_INFO_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^(您的)?(工号|姓名|所属部门|部门)(或|、|/)"),
    re.compile(r"^涉及的"),
    re.compile(r"^具体(疑问|故障现象|问题现象|需求)"),
    re.compile(r"^(打印机|设备|系统)(所在|品牌|型号)"),
    re.compile(r"^(请|麻烦)?(您)?(补充|提供|确认|填写|告知|说明)"),
    re.compile(r"^(需要|还需|仍需要?)(您)?(补充|提供|确认)"),
    re.compile(r"^(以下|如下)" ),
)

# 出现这些词的段落是在「向用户要信息」，其后的 bullet 都属于待办清单。
# 注意必须排掉「已根据您提供的信息…」这类**引用过去**的句式：它讲的是 AI
# 已经拿到了什么，不是还缺什么。之前漏排导致这类结论被整段丢弃。
_PENDING_HEADING_HINT = re.compile(
    r"(需要您|还需|仍需要|尚未|缺少|请(您)?(补充|提供|告知|说明)|麻烦(您)?(补充|提供))"
    r".{0,20}(信息|资料|内容|如下|以下)"
)
_PAST_REFERENCE_HINT = re.compile(r"^(已|已经|根据|依据|按照|基于|收到)")

_BULLET_PREFIX = re.compile(r"^\s*(?:[-*•·]|\d+[.、)]|[（(]\d+[)）])\s*")
_HEADING_PREFIX = re.compile(r"^\s*#{1,6}\s*")


class HandoffBriefFinding(BaseModel):
    text: str


class HandoffBriefSlot(BaseModel):
    key: str
    label: str
    value: str


class HandoffBriefCitation(BaseModel):
    title: str
    count: int = 1


class HandoffBriefTurn(BaseModel):
    role: str  # user / assistant / human_reply
    text: str
    created_at: str
    citations: list[str] = Field(default_factory=list)


class HandoffBrief(BaseModel):
    """一张卡片需要的全部信息。缺数据时对应字段为空，前端据此走兜底态。"""

    # 一眼知道是什么问题：优先会话标题（它本身就是首条真实提问）
    topic: str | None = None
    # user_requested / sop_step / bot_escalated，决定 ask 的话术
    reason: str = "bot_escalated"
    # 「需要你处理」这一句话
    ask: str | None = None
    # 结论来源（便于排查为什么是兜底态）
    ask_source: str = "fallback"
    findings: list[HandoffBriefFinding] = Field(default_factory=list)
    slots: list[HandoffBriefSlot] = Field(default_factory=list)
    transcript: list[HandoffBriefTurn] = Field(default_factory=list)
    citations: list[HandoffBriefCitation] = Field(default_factory=list)
    waiting_seconds: int = 0
    rounds: int = 0
    # 同一会话的第几次转人工（1 起）。>1 说明用户反复转人工，值得优先看。
    attempt_index: int = 1
    total_messages: int = 0
    # transcript 是否被截断（前端据此显示「展开全部 N 条」）
    transcript_truncated: bool = False


def _clean(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _is_boilerplate(text: str) -> bool:
    return any(pattern.match(text) for pattern in _BOILERPLATE_PATTERNS)


def _is_pending_info(text: str) -> bool:
    return any(pattern.match(text) for pattern in _PENDING_INFO_PATTERNS)


def extract_findings(step_reply: str | None) -> list[HandoffBriefFinding]:
    """从 handoff 保存的 `metadata.step_reply` 里抽 AI 已完成排查的结论。

    只做规则抽取，不调模型：
    1. 优先取 markdown 列表项（`- xxx` / `1. xxx`），这是 SOP 与 bot 生成
       结论时最稳定的形态；
    2. 没有任何列表项时，退化为按句号切分正常段落；
    3. 丢掉两类噪声：纯转接话术（「已为您转接人工」），以及「还需要您补充
       以下信息」这类待办清单——后者属于「缺什么」，不属于「查到了什么」。
    """
    raw = str(step_reply or "")
    if not raw.strip():
        return []

    bullets: list[str] = []
    paragraphs: list[str] = []
    # 当前是否处于「要用户补信息」的小标题之下；是则跳过其后的 bullet。
    in_pending_block = False

    for line in raw.splitlines():
        stripped = _HEADING_PREFIX.sub("", line).strip()
        if not stripped or stripped.startswith("|"):  # 跳过空行与表格
            continue

        is_bullet = bool(_BULLET_PREFIX.match(stripped))
        text = _clean(_BULLET_PREFIX.sub("", stripped)) if is_bullet else _clean(stripped)
        if not text:
            continue

        if is_bullet:
            if in_pending_block or _is_pending_info(text) or _is_boilerplate(text):
                continue
            bullets.append(text[:300])
            continue

        # 非 bullet 行：判断它是不是「要信息」的引导句。
        if _PENDING_HEADING_HINT.search(text) and not _PAST_REFERENCE_HINT.match(text):
            in_pending_block = True
            continue
        if _is_boilerplate(text):
            continue
        # 正常小标题/说明句，结束待办区块
        in_pending_block = False
        paragraphs.append(text)

    if bullets:
        return [HandoffBriefFinding(text=item) for item in bullets[:FINDINGS_LIMIT]]

    # 无列表项：按句切分，丢掉转接话术句。
    sentences: list[str] = []
    for paragraph in paragraphs:
        for piece in re.split(r"[。！？!?]\s*", paragraph):
            text = _clean(piece)
            if not text or len(text) < 6 or _is_boilerplate(text) or _is_pending_info(text):
                continue
            sentences.append(text[:300])
            if len(sentences) >= FINDINGS_LIMIT:
                break
        if len(sentences) >= FINDINGS_LIMIT:
            break
    return [HandoffBriefFinding(text=item) for item in sentences]


def _slot_label(key: str) -> str:
    return _SLOT_LABELS.get(key, key)


def _slot_value(key: str, value: Any) -> str:
    text = _clean(value)
    mapped = _SLOT_VALUE_LABELS.get(text.lower())
    if mapped:
        return mapped
    if key in _SYSTEM_KEYS:
        return _SYSTEM_NAME_LABELS.get(text.lower(), text)
    return text


def _slot_sort_key(key: str) -> tuple[int, str]:
    try:
        return (_SLOT_ORDER.index(key), "")
    except ValueError:
        return (len(_SLOT_ORDER), key)


def build_slots(
    resume_payload: dict[str, Any] | None,
    session_slots: dict[str, Any] | None,
) -> list[HandoffBriefSlot]:
    """合并 handoff 快照与 session 现值里的结构化槽位。

    handoff 的 `resume_payload_json.slots` 是转人工那一刻的快照，优先用；
    session 现值只补快照里没有的 key（正常情况下两者一致，补位是为了兜住
    早期没写入 slots 的历史单）。
    """
    merged: dict[str, Any] = {}
    # 顺序很重要：先放 session 现值，再用 handoff 快照**覆盖**同 key。
    # 快照是转人工那一刻的事实，session 现值可能已被后续轮次改写；
    # 反过来写会让快照失效。
    for source in (session_slots or {}, (resume_payload or {}).get("slots") or {}):
        if not isinstance(source, dict):
            continue
        for key, value in source.items():
            if not isinstance(key, str) or key.startswith("_"):
                continue
            if key in _INTERNAL_SLOT_KEYS:
                continue
            merged[key] = value

    # SOP 里同一个语义常有多个别名（system / system_name / target_system 都写了
    # 「OA系统」），按中文 label 去重，只保留排序最靠前的那个 key。
    slots: list[HandoffBriefSlot] = []
    seen_labels: set[str] = set()
    for key in sorted(merged, key=_slot_sort_key):
        value = merged[key]
        if value is None or isinstance(value, (dict, list)):
            continue
        label = _slot_label(key)
        if label in seen_labels:
            continue
        text = _slot_value(key, value)
        if not text:
            continue
        seen_labels.add(label)
        slots.append(HandoffBriefSlot(key=key, label=label, value=text[:200]))
        if len(slots) >= SLOTS_LIMIT:
            break
    return slots


def _has_handoff_trigger(messages: list[Message]) -> bool:
    """会话里是否存在一条纯转人工触发消息。

    不能只看「最后一条真实提问」：用户点「转人工」之前往往还有一轮真实对话
    （Outlook 那单是「我用了 foliday 的 wifi」→ AI 回答 → 用户点转人工），
    只看最后一条真实提问会把它误判成 bot 主动升级。
    """
    for message in messages:
        if message.role != "user":
            continue
        metadata = message.metadata_json if isinstance(message.metadata_json, dict) else {}
        if metadata.get("human_reply"):
            continue
        if is_handoff_trigger_only(_clean(message.content)):
            return True
    return False


def classify_reason(
    handoff: HumanHandoffRequest,
    messages: list[Message],
) -> str:
    """三种转人工来源。决定了 ask 该说「用户主动要人工」还是「SOP 卡住了」。"""
    if handoff.trigger_skill_id or handoff.trigger_step_id:
        return "sop_step"
    if _has_handoff_trigger(messages):
        return "user_requested"
    return "bot_escalated"


def _step_label(handoff: HumanHandoffRequest) -> str:
    """SOP 卡在哪一步。metadata.step 线上常常是 {}，所以要有 id 兜底。"""
    metadata = handoff.metadata_json if isinstance(handoff.metadata_json, dict) else {}
    step = metadata.get("step")
    if isinstance(step, dict):
        name = _clean(step.get("name"))
        if name:
            return name
    return _clean(handoff.trigger_step_id) or "SOP 当前节点"


def build_ask(
    handoff: HumanHandoffRequest,
    *,
    reason: str,
    topic: str | None,
    findings: list[HandoffBriefFinding],
    slots: list[HandoffBriefSlot],
) -> tuple[str, str]:
    """拼出「需要你处理」这一句。返回 (文案, 来源标记)。

    P0 用模板拼装：零模型成本、结果稳定、可测试。句式会比模型总结生硬
    一些，但每个字的来源都能追到某个字段。
    """
    by_key = {slot.key: slot.value for slot in slots}

    if reason == "sop_step":
        head_parts: list[str] = []
        system_name = by_key.get("system") or by_key.get("system_name") or by_key.get("target_system")
        permission = by_key.get("permission") or by_key.get("permission_level")
        if system_name and permission:
            head_parts.append(f"{system_name} {permission}")
        elif system_name:
            head_parts.append(system_name)
        elif permission:
            head_parts.append(permission)
        access_level = by_key.get("access_level") or by_key.get("environment") or by_key.get("env")
        if access_level:
            head_parts.append(access_level)

        head = " · ".join(head_parts)
        # 工号是审批时最先要核对的，单独提出来放括注里。
        employee = by_key.get("employee_id") or by_key.get("employee_no") or by_key.get("staff_id")
        who = f"（工号 {employee}）" if employee else ""
        step_label = _step_label(handoff)

        if head:
            ask = f"审批 {head}{who}。SOP 卡在「{step_label}」这一步，需要人工推进。"
        else:
            ask = f"SOP 卡在「{step_label}」这一步，需要人工推进。"
        if slots:
            ask += "信息已收集齐，不必再向用户确认。"
        return ask, "sop_step"

    subject = topic or "这个会话"
    if reason == "user_requested":
        ask = f"用户主动就「{subject}」要求转人工，需要你接手。"
    else:
        ask = f"AI 就「{subject}」判定需要人工介入。"

    if findings:
        ask += f"AI 已排查出 {len(findings)} 条结论，可直接沿用，不必重新查知识库。"
    elif topic:
        ask += "AI 没有给出明确结论，请以「对话经过」为准，必要时先向用户追问一句。"
    else:
        # 孤儿 handoff：会话标题与消息都没了，别假装有线索。
        ask = "这条转人工已经没有可用的会话记录（原会话可能已被删除），请尽快人工联系发起人确认诉求。"
    return ask, "template"


def _citations_of(message: Message) -> list[str]:
    metadata = message.metadata_json if isinstance(message.metadata_json, dict) else {}
    raw = metadata.get("knowledge_citations")
    if not isinstance(raw, list):
        return []
    titles: list[str] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        title = _clean(item.get("title"))
        if title:
            titles.append(title)
    return titles


def _turn_role(message: Message) -> str:
    metadata = message.metadata_json if isinstance(message.metadata_json, dict) else {}
    if metadata.get("human_reply"):
        return "human_reply"
    return "assistant" if message.role == "assistant" else "user"


def build_transcript(
    messages: list[Message],
    *,
    limit: int = TRANSCRIPT_LIMIT,
) -> tuple[list[HandoffBriefTurn], bool, int]:
    """取最近 limit 条消息。返回 (轮次, 是否被截断, 总条数)。"""
    total = len(messages)
    picked = messages[-limit:] if total > limit else messages
    turns: list[HandoffBriefTurn] = []
    for message in picked:
        text = _clean(message.content)
        citations = _citations_of(message)
        if not text and not citations:
            continue
        turns.append(
            HandoffBriefTurn(
                role=_turn_role(message),
                text=text[:TRANSCRIPT_MESSAGE_CHARS],
                created_at=message.created_at.isoformat() if message.created_at else "",
                citations=citations,
            )
        )
    return turns, total > limit, total


def aggregate_citations(messages: Iterable[Message]) -> list[HandoffBriefCitation]:
    counts: dict[str, int] = {}
    order: list[str] = []
    for message in messages:
        if message.role != "assistant":
            continue
        for title in _citations_of(message):
            if title not in counts:
                counts[title] = 0
                order.append(title)
            counts[title] += 1
    return [HandoffBriefCitation(title=title, count=counts[title]) for title in order]


def _as_utc(value: datetime) -> datetime:
    """统一成 aware UTC。SQLite 取回的时间是 naive，PG 是 aware，不能直接相减。"""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _waiting_seconds(handoff: HumanHandoffRequest, now: datetime) -> int:
    start = handoff.created_at
    if not start:
        return 0
    end = handoff.answered_at or now
    try:
        delta = (_as_utc(end) - _as_utc(start)).total_seconds()
    except (TypeError, ValueError):
        return 0
    return max(0, int(delta))


def _last_real_user_text(messages: list[Message]) -> str | None:
    """最后一条真实提问：跳过人工回复与纯转人工触发词。"""
    for message in reversed(messages):
        if message.role != "user":
            continue
        metadata = message.metadata_json if isinstance(message.metadata_json, dict) else {}
        if metadata.get("human_reply"):
            continue
        text = _clean(message.content)
        if not text:
            continue
        if is_handoff_trigger_only(text):
            continue
        return text
    return None


def _count_rounds(messages: list[Message]) -> int:
    """对话轮数 = 用户真实发言条数（不含 owner 的人工回复）。"""
    rounds = 0
    for message in messages:
        if message.role != "user":
            continue
        metadata = message.metadata_json if isinstance(message.metadata_json, dict) else {}
        if metadata.get("human_reply"):
            continue
        rounds += 1
    return rounds


def build_handoff_briefs(
    db: Session,
    rows: list[HumanHandoffRequest],
    *,
    tenant_id: str | None = None,
) -> dict[str, HandoffBrief]:
    """批量算 brief。返回 {handoff_id: brief}。

    必须批量取：`/handoffs` 一次最多 200 条，若逐条查 session / message
    就是 200×(1+N) 次查询；而前端每 15 秒轮询一次，这个放大不能接受。
    """
    if not rows:
        return {}

    session_ids = {row.session_id for row in rows if row.session_id}
    tenant_scope = tenant_id or rows[0].tenant_id

    sessions: dict[str, ChatSession] = {}
    if session_ids:
        sessions = {
            session.id: session
            for session in db.exec(
                select(ChatSession).where(ChatSession.id.in_(session_ids))
            ).all()
        }

    # 一次取回所有相关会话的消息，再在内存里按 session 切片。
    # 这些会话都是客服转人工会话，长度有限；用 tenant 过滤走索引。
    messages_by_session: dict[str, list[Message]] = defaultdict(list)
    if session_ids:
        message_rows = db.exec(
            select(Message)
            .where(Message.tenant_id == tenant_scope)
            .where(Message.session_id.in_(session_ids))
            .order_by(Message.created_at)
        ).all()
        for message in message_rows:
            messages_by_session[message.session_id].append(message)

    # 同一会话的第几次转人工：按 created_at 排序后逐会话累计。
    attempt_index: dict[str, int] = {}
    if session_ids:
        attempt_rows = db.exec(
            select(HumanHandoffRequest.id, HumanHandoffRequest.session_id)
            .where(HumanHandoffRequest.tenant_id == tenant_scope)
            .where(HumanHandoffRequest.session_id.in_(session_ids))
            .order_by(HumanHandoffRequest.created_at)
        ).all()
        counter: dict[str, int] = defaultdict(int)
        for handoff_id, session_id in attempt_rows:
            counter[session_id] += 1
            attempt_index[handoff_id] = counter[session_id]

    now = utc_now()
    briefs: dict[str, HandoffBrief] = {}
    for row in rows:
        session = sessions.get(row.session_id)
        messages = messages_by_session.get(row.session_id, [])
        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}

        last_user_text = _last_real_user_text(messages)
        reason = classify_reason(row, messages)

        topic = _clean(session.title) if session and session.title else None
        if not topic:
            # 没有会话标题时的两级兜底：
            # 1. 会话里最后一条真实提问 —— 最可靠，它就是用户原本的问法；
            # 2. pending_question，但它常被写成 bot 的结果播报（SOP 单是
            #    「您的申请已提交审批流程…」，非 SOP 单是「转人工」），
            #    所以只在非 SOP 且不看像话术时才收。
            topic = (last_user_text or "")[:80] or None
        if not topic and reason != "sop_step":
            candidate = _clean(row.pending_question)
            # 两种都必须排除：bot 的转接话术，以及「转人工」这类纯触发词
            # （它不含任何诉求，当标题等于没标题）。
            if (
                candidate
                and len(candidate) <= 60
                and not _is_boilerplate(candidate)
                and not is_handoff_trigger_only(candidate)
            ):
                topic = candidate
        if not topic and session is None:
            # 孤儿 handoff：会话行与消息都不在了，给中性描述让前端有字可显示，
            # 而不是把 bot 的话术顶到标题位上。
            topic = "该会话已无原始记录"

        findings = extract_findings(metadata.get("step_reply"))
        slots = build_slots(
            row.resume_payload_json if isinstance(row.resume_payload_json, dict) else {},
            session.slots_json if session else {},
        )
        ask, ask_source = build_ask(
            row, reason=reason, topic=topic, findings=findings, slots=slots
        )

        transcript, truncated, total_messages = build_transcript(messages)
        citations = aggregate_citations(messages)

        briefs[row.id] = HandoffBrief(
            topic=topic,
            reason=reason,
            ask=ask,
            ask_source=ask_source,
            findings=findings,
            slots=slots,
            transcript=transcript,
            citations=citations,
            waiting_seconds=_waiting_seconds(row, now),
            rounds=_count_rounds(messages),
            attempt_index=attempt_index.get(row.id, 1),
            total_messages=total_messages,
            transcript_truncated=truncated,
        )
    return briefs