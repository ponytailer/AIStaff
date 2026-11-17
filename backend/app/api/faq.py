"""反馈自进化 / 员工 FAQ 的企业端 API。

权限口径：员工创建人 + 租户管理员可见可操作（ensure_agent_scope_manager，
permissions.agent_owned_by_user 已把 created_by_user_id 纳入 owner 判定）。
其余成员对该模块完全不可见。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlmodel import Session, select

from app.db import get_session
from app.db.models import (
    AgentFaqIgnoredHandoff,
    AgentProfile,
    AgentUnansweredQuery,
    AgentFaqItem,
    HumanHandoffRequest,
    Message,
    User,
    utc_now,
)
from app.faq.service import FaqService, suggest_keywords
from app.security.auth import get_current_user
from app.security.permissions import ensure_agent_scope_manager
from app.security.tenant import ensure_tenant

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
    """转人工候选的用户问法：取该会话最后一条用户消息（人工回复的对象）。

    跳过 `metadata.human_reply` 的消息——owner 从「待回答」补的答案落库也是
    user 角色，不能当成问法；问法缺失时回退到创建 handoff 时记录的
    pending_question。"""

    if row.session_id:
        # 取最近一批再逐条过滤，避免 JSON 字段没法直接进 SQL 谓词。
        rows = db.exec(
            select(Message)
            .where(
                Message.tenant_id == row.tenant_id,
                Message.session_id == row.session_id,
                Message.role == "user",
            )
            .order_by(Message.created_at.desc())
            .limit(20)
        ).all()
        for msg in rows:
            metadata = msg.metadata_json if isinstance(msg.metadata_json, dict) else {}
            if metadata.get("human_reply"):
                continue
            if str(msg.content or "").strip():
                return str(msg.content).strip()[:500]
    return str(row.pending_question or "").strip()[:500]


@router.get("/agents/{agent_id}/faq/items", response_model=list[AgentFaqItemRead])
def list_faq_items(
    agent_id: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[AgentFaqItemRead]:
    ensure_tenant(db, tenant_id)
    ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
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
    ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
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
    ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
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
    ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
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
