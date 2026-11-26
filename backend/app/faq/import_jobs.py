"""FAQ 批量导入的解析任务：上传即返回，后台跑模型匹配，前端轮询拿预览。

为什么不在上传请求里同步跑完：160 行要分 4 批发给模型，慢模型上单批十几秒，
整轮 40~90s 会让网关/反代先超时，用户看到的是「上传失败」而任务其实成功了。
改成「先拿 job_id → 轮询」，前端能显示真实进度。

结果只放进程内存（与 doc-review 的 doc 暂存同款）：预览是「一次性的草稿」，
用户确认或取消后即可丢弃，没必要为它建表。TTL 30 分钟，进程重启后 job 丢失，
前端会收到 404 并提示重新上传——这比落库更省事，也不会留下垃圾数据。
"""

from __future__ import annotations

import logging
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from sqlmodel import Session

from app.db import engine
from app.db.models import User, utc_now
from app.faq.import_service import ImportCandidate, build_import_candidates

logger = logging.getLogger(__name__)

JOB_TTL = timedelta(minutes=30)
MAX_JOBS = 40

STATUS_QUEUED = "queued"
STATUS_PARSING = "parsing"
STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"


@dataclass
class FaqImportPreview:
    question: str
    answer: str
    keywords: list[str] = field(default_factory=list)
    rows: list[int] = field(default_factory=list)
    note: str = ""
    warning: str = ""

    @classmethod
    def from_candidate(cls, candidate: ImportCandidate) -> "FaqImportPreview":
        return cls(
            question=candidate.question,
            answer=candidate.answer,
            keywords=list(candidate.keywords),
            rows=list(candidate.rows),
            note=candidate.note,
            warning=candidate.warning,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "question": self.question,
            "answer": self.answer,
            "keywords": self.keywords,
            "rows": self.rows,
            "note": self.note,
            "warning": self.warning,
        }


@dataclass
class FaqImportJob:
    id: str
    tenant_id: str
    user_id: str
    agent_id: str
    filename: str
    status: str = STATUS_QUEUED
    stage: str = "queued"
    progress: float = 0.0
    error: str | None = None
    warnings: list[str] = field(default_factory=list)
    items: list[FaqImportPreview] = field(default_factory=list)
    sheet_name: str = ""
    rows_total: int = 0
    rows_used: int = 0
    truncated: bool = False
    model_name: str | None = None
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)
    finished_at: datetime | None = None
    #: 原始文件字节只留在内存里：不落 Redis（bytes 进 JSON 会被 default=str 打坏），
    #: 也不进 as_dict 的响应，避免把整份表格回吐给前端。
    file_bytes: bytes = field(default=b"", repr=False)

    def as_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.id,
            "filename": self.filename,
            "status": self.status,
            "stage": self.stage,
            "progress": round(self.progress, 1),
            "error": self.error,
            "warnings": self.warnings,
            "items": [item.as_dict() for item in self.items],
            "sheet_name": self.sheet_name,
            "rows_total": self.rows_total,
            "rows_used": self.rows_used,
            "truncated": self.truncated,
            "model_name": self.model_name,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class _JobStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, FaqImportJob] = {}

    def put(self, job: FaqImportJob) -> None:
        with self._lock:
            self._jobs[job.id] = job
            self._trim_locked()

    def get(self, job_id: str) -> FaqImportJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job and utc_now() - job.updated_at > JOB_TTL:
                self._jobs.pop(job_id, None)
                return None
            return job

    def update(self, job_id: str, **changes: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            for key, value in changes.items():
                setattr(job, key, value)
            job.updated_at = utc_now()

    def _trim_locked(self) -> None:
        overflow = len(self._jobs) - MAX_JOBS
        if overflow <= 0:
            return
        finished = sorted(
            (job for job in self._jobs.values() if job.status in {STATUS_SUCCEEDED, STATUS_FAILED}),
            key=lambda item: item.created_at,
        )
        for job in finished[:overflow]:
            self._jobs.pop(job.id, None)


faq_import_jobs = _JobStore()


def create_job(
    *,
    tenant_id: str,
    user_id: str,
    agent_id: str,
    filename: str,
    file_bytes: bytes = b"",
) -> FaqImportJob:
    job = FaqImportJob(
        id=f"faqimp_{uuid.uuid4().hex[:18]}",
        tenant_id=tenant_id,
        user_id=user_id,
        agent_id=agent_id,
        filename=filename,
        file_bytes=file_bytes,
    )
    faq_import_jobs.put(job)
    return job


def get_job(job_id: str, *, tenant_id: str, user_id: str) -> FaqImportJob | None:
    job = faq_import_jobs.get(job_id)
    if job is None or job.tenant_id != tenant_id or job.user_id != user_id:
        return None
    return job


def _resolve_model(db: Session, tenant_id: str, agent_id: str, user: User) -> Any | None:
    """导入用的模型：优先当前用户自己的默认模型，其次租户默认（与 FAQ 编辑同口径）。

    注意不能复用 ``model_for_agent`` 的「免费模型」分支——批量导入是显式动作，
    不该吃员工的免费额度。
    """

    from app.agents.branching import model_for_agent

    try:
        return model_for_agent(db, tenant_id, agent_id, user_id=user.id)
    except Exception:  # noqa: BLE001 - 模型解析失败降级为「按列推断」
        logger.warning("FAQ 导入解析不到模型，降级本地配对 tenant=%s", tenant_id, exc_info=True)
        return None


def run_import_job(job_id: str) -> None:
    """后台执行解析（进程内 AsyncJobQueue 与 rq 共用的入口）。

    只收 ``job_id``：文件字节留在 job 对象里，worker 回读同一份内存即可。
    这也意味着**任务不能跨进程**——故这里只走进程内 AsyncJobQueue，
    不接 rq（rq 的 payload 只认 JSON，10MB xlsx 序列化不现实）。
    """

    job = faq_import_jobs.get(job_id)
    if job is None:
        logger.warning("FAQ 导入任务不存在或已过期 job=%s", job_id)
        return

    faq_import_jobs.update(job_id, status=STATUS_PARSING, stage="reading", progress=5.0)
    with Session(engine) as db:
        user = db.get(User, job.user_id)
        model_config = _resolve_model(db, job.tenant_id, job.agent_id, user) if user else None
        try:
            faq_import_jobs.update(job_id, stage="matching", progress=35.0)
            result = build_import_candidates(
                db,
                job.tenant_id,
                job.agent_id,
                data=job.file_bytes,
                model_config=model_config,
            )
        except ValueError as exc:
            faq_import_jobs.update(
                job_id,
                status=STATUS_FAILED,
                stage="failed",
                error=str(exc),
                finished_at=utc_now(),
            )
            return
        except Exception as exc:  # noqa: BLE001 - 任何异常都要落到任务状态
            logger.exception("FAQ 导入解析失败 job=%s", job_id)
            faq_import_jobs.update(
                job_id,
                status=STATUS_FAILED,
                stage="failed",
                error=f"解析失败：{exc}",
                finished_at=utc_now(),
            )
            return

        faq_import_jobs.update(
            job_id,
            status=STATUS_SUCCEEDED,
            stage="done",
            progress=100.0,
            items=[FaqImportPreview.from_candidate(item) for item in result.candidates],
            warnings=list(result.warnings),
            sheet_name=result.sheet_name,
            rows_total=result.rows_total,
            rows_used=result.rows_used,
            truncated=result.truncated,
            model_name=result.model_name,
            finished_at=utc_now(),
            # 解析完就不用再留整份表格：内存里几十 KB~MB 级，留着只是负担。
            file_bytes=b"",
        )
        logger.info(
            "FAQ 导入解析完成 job=%s items=%s model=%s",
            job_id,
            len(result.candidates),
            result.model_name,
        )