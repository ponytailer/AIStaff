"""反馈自进化 / 员工 FAQ 的企业端 API。

权限口径分两层：

- **写**（新建 / 修改 / 删除 / 忽略候选）：员工创建人或租户管理员
  （``ensure_agent_scope_manager``，``agent_owned_by_user`` 已把
  ``created_by_user_id`` 纳入 owner 判定）。
- **读**（items / unanswered / handoffs / count）：能看见这个员工就能读
  （``ensure_agent_scope_viewer``）。广场里已发布的员工对全租户可见，只给
  「看得见但一个字都读不到」会让档案页的 FAQ 计数直接 403、tab 点进去一片
  空白 —— 那不是「只读」，是坏页。只读用户拿到的是纯展示列表。
"""

from __future__ import annotations

import logging

from datetime import datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlmodel import Session, select

from app.db import get_session
from app.db.models import (
    AgentFaqIgnoredHandoff,
    AgentProfile,
    AgentUnansweredQuery,
    AgentFaqItem,
    ChatSession,
    HumanHandoffRequest,
    Message,
    User,
    utc_now,
)
from app.core.plan.planner_fastpath import (
    is_bot_handoff_script,
    is_handoff_trigger_only,
)
from app.faq.import_jobs import create_job, get_job, run_import_job
from app.faq.import_service import MAX_FILE_BYTES, MAX_KEYWORDS, MIN_KEYWORDS
from app.faq.service import FaqService, normalize_text, suggest_keywords
from app.security.auth import get_current_user
from app.security.permissions import ensure_agent_scope_manager, ensure_agent_scope_viewer
from app.security.tenant import ensure_tenant

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/enterprise", tags=["enterprise:faq"])


class AgentFaqItemRead(BaseModel):
    id: str
    question: str
    answer_markdown: str
    keywords: list[str] = Field(default_factory=list)
    source: str
    source_id: Optional[str] = None
    status: str
    usage_count: int
    adopted_at: Optional[datetime] = None
    updated_at: datetime


class AgentUnansweredRead(BaseModel):
    id: str
    query: str
    hit_count: int
    source: str
    status: str
    last_session_id: Optional[str] = None
    updated_at: datetime
    suggested_keywords: list[str] = Field(default_factory=list)


class AgentHandoffCandidateRead(BaseModel):
    id: str
    query: str
    pending_question: Optional[str] = None
    human_reply: Optional[str] = None
    answered_at: Optional[datetime] = None
    answered_by_user_id: Optional[str] = None
    suggested_keywords: list[str] = Field(default_factory=list)


class FaqUpsertRequest(BaseModel):
    tenant_id: str
    question: str
    answer_markdown: str = ""
    keywords: list[str] = Field(default_factory=list)
    source: Literal["manual", "handoff", "unanswered"] = "manual"
    source_id: Optional[str] = None


class FaqUpdateRequest(BaseModel):
    tenant_id: str
    question: Optional[str] = None
    answer_markdown: Optional[str] = None
    keywords: Optional[list[str]] = None
    status: Optional[Literal["active", "disabled"]] = None


class FaqImportItem(BaseModel):
    """用户在预览弹窗里勾选/改过的一条候选。"""

    question: str = Field(max_length=500)
    answer: str = Field(default="", max_length=20000)
    keywords: list[str] = Field(default_factory=list)


class FaqImportCommitRequest(BaseModel):
    tenant_id: str
    items: list[FaqImportItem] = Field(default_factory=list)


class FaqImportCommitResult(BaseModel):
    created: int
    skipped: int
    items: list[AgentFaqItemRead]
    errors: list[str] = Field(default_factory=list)


def _item_read(row: Any) -> AgentFaqItemRead:
    return AgentFaqItemRead(
        id=row.id,
        question=row.question,
        answer_markdown=row.answer_markdown or "",
        keywords=list(row.keywords_json or []),
        source=row.source,
        source_id=row.source_id,
        status=row.status,
        usage_count=int(row.usage_count or 0),
        adopted_at=row.adopted_at,
        updated_at=row.updated_at,
    )


def _handoff_query(db: Session, row: HumanHandoffRequest) -> str:
    """转人工候选的用户问法：该会话的**主题提问**（第一条真实用户提问）。

    为什么不用「最后一条用户消息」——线上踩坑（三连错）：
    - 答案尾部的「转人工」按钮发出去就是一条内容为「转人工」的 user 消息，
      取最后一条 → 问法变成「转人工」，关键词变成「转人 / 人工」；
    - 跳过触发词后取到的是「我用了foliday的wifi」这类上下文追问，单独看
      完全不成立，采成 FAQ 以后没人能搜到。

    FAQ 要沉淀的是「这段对话到底在问什么」，也就是进线的第一句真实提问
    （和会话标题同源）；owner 的人工回复正是对它的答复。

    跳过：`metadata.human_reply`（owner 补的答案，落库也是 user 角色）与
    纯转人工触发词。都没有时回退 pending_question，它若也是触发词则返回空
    （前端会跳过这条候选，比拿一个错问法去生成关键词好）。
    """

    if row.session_id:
        # 取最早一批再逐条过滤，避免 JSON 字段没法直接进 SQL 谓词。
        rows = db.exec(
            select(Message)
            .where(
                Message.tenant_id == row.tenant_id,
                Message.session_id == row.session_id,
                Message.role == "user",
            )
            .order_by(Message.created_at.asc())
            .limit(20)
        ).all()
        for msg in rows:
            metadata = msg.metadata_json if isinstance(msg.metadata_json, dict) else {}
            if metadata.get("human_reply"):
                continue
            content = str(msg.content or "").strip()
            if not content:
                continue
            if is_handoff_trigger_only(content):
                continue
            return content[:500]
    # 消息被清理（会话删除 / 测试数据清理）时的兜底：会话标题就是首轮提问。
    if row.session_id:
        session = db.get(ChatSession, row.session_id)
        title = str(getattr(session, "title", "") or "").strip()
        if title and not is_handoff_trigger_only(title) and not is_bot_handoff_script(title):
            return title[:500]
    fallback = str(row.pending_question or "").strip()
    if is_handoff_trigger_only(fallback) or is_bot_handoff_script(fallback):
        return ""
    return fallback[:500]


@router.get("/agents/{agent_id}/faq/items", response_model=list[AgentFaqItemRead])
def list_faq_items(
    agent_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[AgentFaqItemRead]:
    ensure_tenant(db, tenant_id)
    ensure_agent_scope_viewer(db, tenant_id, agent_id, current_user)
    return [_item_read(row) for row in FaqService(db).list_items(tenant_id, agent_id)]


@router.get(
    "/agents/{agent_id}/faq/unanswered", response_model=list[AgentUnansweredRead]
)
def list_unanswered_queries(
    agent_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[AgentUnansweredRead]:
    ensure_tenant(db, tenant_id)
    ensure_agent_scope_viewer(db, tenant_id, agent_id, current_user)
    service = FaqService(db)
    return [
        AgentUnansweredRead(
            id=row.id,
            query=row.query,
            hit_count=int(row.hit_count or 1),
            source=row.source,
            status=row.status,
            last_session_id=row.last_session_id,
            updated_at=row.updated_at,
            suggested_keywords=suggest_keywords(row.query),
        )
        for row in service.list_unanswered(tenant_id, agent_id)
    ]


@router.get(
    "/agents/{agent_id}/faq/handoffs", response_model=list[AgentHandoffCandidateRead]
)
def list_handoff_candidates(
    agent_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[AgentHandoffCandidateRead]:
    ensure_tenant(db, tenant_id)
    ensure_agent_scope_viewer(db, tenant_id, agent_id, current_user)
    ignored_ids = set(
        db.exec(
            select(AgentFaqIgnoredHandoff.handoff_id).where(
                AgentFaqIgnoredHandoff.tenant_id == tenant_id,
                AgentFaqIgnoredHandoff.agent_id == agent_id,
            )
        ).all()
    )
    rows = db.exec(
        select(HumanHandoffRequest)
        .where(
            HumanHandoffRequest.tenant_id == tenant_id,
            HumanHandoffRequest.agent_id == agent_id,
            HumanHandoffRequest.status == "answered",
        )
        .order_by(HumanHandoffRequest.answered_at.desc())
        .limit(50)
    ).all()
    result: list[AgentHandoffCandidateRead] = []
    resume_payload: dict[str, Any]
    for row in rows:
        if row.id in ignored_ids:
            continue
        # 只发了图片/附件、没有文字的人工回复采不成 FAQ：答案列是空的，
        # 采过去只会得到一条「命中就回空话」的条目。
        if not str(row.human_reply or "").strip():
            continue
        resume_payload = row.resume_payload_json if isinstance(row.resume_payload_json, dict) else {}
        query = _handoff_query(db, row)
        if not query:
            continue
        result.append(
            AgentHandoffCandidateRead(
                id=row.id,
                query=query,
                pending_question=row.pending_question,
                human_reply=row.human_reply,
                answered_at=row.answered_at,
                answered_by_user_id=str(
                    resume_payload.get("answered_by_user_id") or ""
                )
                or None,
                suggested_keywords=suggest_keywords(query),
            )
        )
    return result


@router.post("/agents/{agent_id}/faq/items", response_model=AgentFaqItemRead)
def create_faq_item(
    agent_id: str,
    request: FaqUpsertRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> AgentFaqItemRead:
    ensure_tenant(db, request.tenant_id)
    ensure_agent_scope_manager(db, request.tenant_id, agent_id, current_user)
    if not str(request.question or "").strip():
        raise HTTPException(status_code=422, detail="FAQ 问题不能为空")
    if not str(request.answer_markdown or "").strip():
        raise HTTPException(status_code=422, detail="FAQ 答案不能为空")
    row = FaqService(db).create_item(
        request.tenant_id,
        agent_id,
        question=request.question,
        answer_markdown=request.answer_markdown,
        keywords=request.keywords,
        created_by_user_id=current_user.id,
        source=request.source,
        source_id=request.source_id,
    )
    return _item_read(row)


@router.put("/agents/{agent_id}/faq/items/{item_id}", response_model=AgentFaqItemRead)
def update_faq_item(
    agent_id: str,
    item_id: str,
    request: FaqUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> AgentFaqItemRead:
    ensure_tenant(db, request.tenant_id)
    ensure_agent_scope_manager(db, request.tenant_id, agent_id, current_user)
    row = FaqService(db).get_item(request.tenant_id, agent_id, item_id)
    if row is None:
        raise HTTPException(status_code=404, detail="FAQ not found")
    row = FaqService(db).update_item(
        row,
        question=request.question,
        answer_markdown=request.answer_markdown,
        keywords=request.keywords,
        status=request.status,
    )
    return _item_read(row)


@router.delete("/agents/{agent_id}/faq/items/{item_id}")
def delete_faq_item(
    agent_id: str,
    item_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, str]:
    ensure_tenant(db, tenant_id)
    ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
    row = FaqService(db).get_item(tenant_id, agent_id, item_id)
    if row is None:
        raise HTTPException(status_code=404, detail="FAQ not found")
    FaqService(db).delete_item(row)
    return {"status": "deleted"}


@router.post("/agents/{agent_id}/faq/handoffs/{handoff_id}:dismiss")
def dismiss_handoff_candidate(
    agent_id: str,
    handoff_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, str]:
    """从待沉淀列表删掉一条转人工记录（不动 handoff 业务状态）。"""

    ensure_tenant(db, tenant_id)
    ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
    row = db.get(HumanHandoffRequest, handoff_id)
    if row is None or row.tenant_id != tenant_id or row.agent_id != agent_id:
        raise HTTPException(status_code=404, detail="Handoff not found")
    exists = db.exec(
        select(AgentFaqIgnoredHandoff).where(
            AgentFaqIgnoredHandoff.tenant_id == tenant_id,
            AgentFaqIgnoredHandoff.agent_id == agent_id,
            AgentFaqIgnoredHandoff.handoff_id == handoff_id,
        )
    ).first()
    if exists is None:
        db.add(
            AgentFaqIgnoredHandoff(
                tenant_id=tenant_id,
                agent_id=agent_id,
                handoff_id=handoff_id,
                created_by_user_id=current_user.id,
            )
        )
        db.commit()
    return {"status": "dismissed"}


@router.post("/agents/{agent_id}/unanswered/{query_id}:dismiss")
def dismiss_unanswered_query(
    agent_id: str,
    query_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, str]:
    ensure_tenant(db, tenant_id)
    ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
    row = db.get(AgentUnansweredQuery, query_id)
    if row is None or row.tenant_id != tenant_id or row.agent_id != agent_id:
        raise HTTPException(status_code=404, detail="Query not found")
    row.status = "dismissed"
    row.updated_at = utc_now()
    db.add(row)
    db.commit()
    return {"status": "dismissed"}


@router.get("/agents/{agent_id}/faq/count")
def faq_overview_count(
    agent_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, int]:
    """员工 FAQ 概览计数：员工档案头部指标 + 对话右栏「员工能力」用。"""

    ensure_tenant(db, tenant_id)
    ensure_agent_scope_viewer(db, tenant_id, agent_id, current_user)
    profile = db.get(AgentProfile, agent_id)
    if profile is None or profile.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Agent not found")
    total = db.exec(
        select(func.count()).select_from(AgentFaqItem).where(
            AgentFaqItem.tenant_id == tenant_id,
            AgentFaqItem.agent_id == agent_id,
        )
    ).one()
    active = db.exec(
        select(func.count()).select_from(AgentFaqItem).where(
            AgentFaqItem.tenant_id == tenant_id,
            AgentFaqItem.agent_id == agent_id,
            AgentFaqItem.status == "active",
        )
    ).one()
    unanswered = db.exec(
        select(func.count()).select_from(AgentUnansweredQuery).where(
            AgentUnansweredQuery.tenant_id == tenant_id,
            AgentUnansweredQuery.agent_id == agent_id,
            AgentUnansweredQuery.status == "pending",
        )
    ).one()
    return {
        "faq_items": int(total or 0),
        "faq_active": int(active or 0),
        "unanswered": int(unanswered or 0),
    }


# --------------------------------------------------------------------------
# 批量导入（Excel）
#
# 两步：`import:parse` 上传表格 → 后台跑「模型归并 QA + 生成关键词」→ 前端轮询
# 拿预览；用户勾选/改完后再调 `import:items` 落库。
#
# 为什么解析要异步：160 行分成 4 批发给模型，慢模型单批十几秒；同步跑会让
# 反代先超时，用户看到「上传失败」而任务其实成功了。轮询能显示真实阶段。
# --------------------------------------------------------------------------


_IMPORT_EXTENSIONS = (".xlsx", ".xlsm")
_IMPORT_STAGE_TEXT = {
    "queued": "排队中",
    "reading": "读取表格",
    "matching": "模型匹配问答对",
    "done": "解析完成",
    "failed": "解析失败",
}


@router.post("/agents/{agent_id}/faq/import:parse")
def parse_faq_import(
    agent_id: str,
    tenant_id: str = Query(...),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """上传 Excel 并启动解析任务，立即返回 job_id（前端轮询 import:jobs/{id}）。

    ``tenant_id`` 走 query 而不是表单字段：前端统一用 ``uploadWithProgress``
    （XHR + FormData 只塞文件）上传，其余 FAQ 接口也都是 query 传租户。
    写成 Form 会稳定 422。
    """

    ensure_tenant(db, tenant_id)
    ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)

    filename = file.filename or "faq.xlsx"
    lower = filename.lower()
    if not lower.endswith(_IMPORT_EXTENSIONS):
        raise HTTPException(
            status_code=400,
            detail="目前只支持 .xlsx / .xlsm 表格（老的 .xls 请先用 Excel 另存为 .xlsx）",
        )
    raw = file.file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="上传的文件为空")
    if len(raw) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"文件超过 {MAX_FILE_BYTES // (1024 * 1024)}MB，请拆分后再导入",
        )

    job = create_job(
        tenant_id=tenant_id,
        user_id=current_user.id,
        agent_id=agent_id,
        filename=filename,
        file_bytes=raw,
    )
    try:
        from app.async_jobs import enqueue_async_job

        enqueue_async_job(
            "faq.import_parse",
            run_import_job,
            job.id,
            metadata={"tenant_id": tenant_id, "agent_id": agent_id},
        )
    except Exception as exc:  # noqa: BLE001 - 队列不可用时同步跑完，别让功能直接挂
        logger.warning("FAQ 导入任务入队失败，改为同步执行 job=%s", job.id, exc_info=True)
        try:
            run_import_job(job.id)
        except Exception:  # noqa: BLE001
            logger.exception("FAQ 导入同步执行失败 job=%s", job.id)
            raise HTTPException(status_code=500, detail="解析任务启动失败，请稍后重试") from exc

    return {"job_id": job.id, "filename": filename, "status": job.status}


@router.get("/agents/{agent_id}/faq/import:jobs/{job_id}")
def read_faq_import_job(
    agent_id: str,
    job_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    ensure_tenant(db, tenant_id)
    ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
    job = get_job(job_id, tenant_id=tenant_id, user_id=current_user.id)
    if job is None or job.agent_id != agent_id:
        raise HTTPException(status_code=404, detail="解析任务不存在或已过期，请重新上传")
    payload = job.as_dict()
    payload["stage_text"] = _IMPORT_STAGE_TEXT.get(job.stage, job.stage)
    return payload


@router.post(
    "/agents/{agent_id}/faq/import:items", response_model=FaqImportCommitResult
)
def commit_faq_import(
    agent_id: str,
    request: FaqImportCommitRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> FaqImportCommitResult:
    """把预览里勾选的条目落库。

    逐条校验（问题/答案非空、关键词 ≥1）；任何一条不合法就整批 422 —— 部分
    成功最难排查：用户以为全存进去了，列表里却少几条。
    """

    ensure_tenant(db, request.tenant_id)
    ensure_agent_scope_manager(db, request.tenant_id, agent_id, current_user)

    if not request.items:
        raise HTTPException(status_code=422, detail="没有选中任何条目")
    if len(request.items) > 200:
        raise HTTPException(status_code=422, detail="单次最多导入 200 条")

    normalized: list[tuple[str, str, list[str]]] = []
    for index, item in enumerate(request.items, start=1):
        question = str(item.question or "").strip()
        answer = str(item.answer or "").strip()
        if not question:
            raise HTTPException(status_code=422, detail=f"第 {index} 条缺少问题")
        if not answer:
            raise HTTPException(status_code=422, detail=f"第 {index} 条「{question[:20]}」缺少答案")
        keywords = [str(k).strip() for k in item.keywords if str(k or "").strip()]
        if len(keywords) < MIN_KEYWORDS:
            raise HTTPException(
                status_code=422,
                detail=f"第 {index} 条「{question[:20]}」至少需要 {MIN_KEYWORDS} 个触发关键词",
            )
        normalized.append((question, answer, keywords[:MAX_KEYWORDS]))

    service = FaqService(db)
    existing = {
        normalize_text(row.question)
        for row in service.list_items(request.tenant_id, agent_id)
    }
    to_create: list[tuple[str, str, list[str]]] = []
    skipped = 0
    for question, answer, keywords in normalized:
        digest = normalize_text(question)
        if not digest or digest in existing:
            skipped += 1
            continue
        existing.add(digest)
        to_create.append((question, answer, keywords))

    if not to_create and skipped:
        raise HTTPException(
            status_code=409,
            detail="选中的条目都已存在（问题完全相同），没有新增任何 FAQ",
        )

    rows = service.create_items(
        request.tenant_id,
        agent_id,
        items=to_create,
        created_by_user_id=current_user.id,
    )
    created = [_item_read(row) for row in rows]
    return FaqImportCommitResult(created=len(created), skipped=skipped, items=created)
