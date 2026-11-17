"""员工 FAQ 与反馈自进化：词法匹配、无法回答收集、CRUD。

为什么用关键词而不是 embedding（2026-11-17 决策）：当前租户没有 embedding
模型资源；FAQ 条目是人工编辑的（几十条量级），关键词词表由 owner 在采纳
时确认，命中判定纯内存比对（<5ms），零模型依赖。

命中口径（2026-11-17 调整）：**任意 1 个关键词命中即短路**。
之前要求 2 个同时命中，实测问「怎么报销」时句子里只有「报销」，
「报销流程」这种更长的关键词永远不出现，FAQ 建了也命不中。误命中风险
改由 owner 维护词表来控制：词表放业务核心词（「报销」「发工资」），别放
「怎么」「流程」这类泛词（自动提取时已剔除停用词）。另外：
- 单字关键词不参与匹配（中文单字命中噪音远大于信号）；
- 转人工类关键词由 planner 层守卫（FAST_PATH_HANDOFF_KEYWORDS）先行拦截。
"""

from __future__ import annotations

import hashlib
import re
from datetime import timedelta
from typing import Any

from sqlmodel import Session, select

from app.db.models import (
    AgentFaqIgnoredHandoff,
    AgentFaqItem,
    AgentUnansweredQuery,
    utc_now,
)

#: 匹配前对 query/关键词做归一化：压空白、全角转半角、小写、剥标点
#: （标点不影响语义，留着会让「同问不同标点」去重失败）。
_NORMALIZE_RE = re.compile(r"\s+")


def normalize_text(value: str) -> str:
    text = _NORMALIZE_RE.sub(" ", str(value or "").strip()).lower()
    # 全角转半角（空格/字母数字/常用标点）
    table = {0x3000: 0x20}
    chars: list[str] = []
    for ch in text:
        code = ord(ch)
        if code in table:
            code = table[code]
        elif 0xFF01 <= code <= 0xFF5E:
            code -= 0xFEE0
        chars.append(chr(code))
    text = "".join(chars)
    # 标点与空白一并剥掉：中文 query 的空格/标点不影响语义，
    # 留着会让「同问不同标点」去重失败；关键词子串匹配同样不受影响。
    return re.sub(r"[^\w\u4e00-\u9fff]+", "", text)


def query_hash(value: str) -> str:
    return hashlib.md5(normalize_text(value).encode("utf-8")).hexdigest()


#: FAQ 短路帧在 slot_hints 里的键（planner_fastpath 与 turn_frames 共用）。
FAQ_ANSWER_SLOT = "faq_answer"
FAQ_ITEM_ID_SLOT = "faq_item_id"
FAQ_QUESTION_SLOT = "faq_question"


#: 2-gram 自动提取：中文按字滑窗，英文按词。owner 可在采纳时增删。
_STOP_GRAMS = {
    "怎么", "什么", "如何", "可以", "请问", "一下", "我的", "你们",
    "这个", "那个", "是不是", "为什么", "需要", "应该",
}


def suggest_keywords(question: str, limit: int = 8) -> list[str]:
    """从问题文本自动提取候选关键词（采纳编辑框的预填值）。

    停用词（怎么/什么/请问…）先整段剔除再滑窗，避免「怎么配」「机端怎」
    这类跨词 gram 混进词表——它们会在无关 query 上制造误命中。
    """

    normalized = normalize_text(question)
    grams: list[str] = []
    for m in re.finditer(r"[a-z0-9]{2,}", normalized):
        grams.append(m.group(0))
    cjk = re.sub(r"[a-z0-9 ]+", " ", normalized)
    cjk = re.sub(r"[^\u4e00-\u9fff]+", " ", cjk)
    for stop in sorted(_STOP_GRAMS, key=len, reverse=True):
        cjk = cjk.replace(stop, " ")
    for token in cjk.split():
        if len(token) < 2:
            continue
        grams.extend(token[i : i + 2] for i in range(len(token) - 1))
    seen: set[str] = set()
    picked: list[str] = []
    for gram in grams:
        if gram in _STOP_GRAMS or gram in seen:
            continue
        seen.add(gram)
        picked.append(gram)
        if len(picked) >= limit:
            break
    return picked


def _keyword_hit_count(keywords: list[str], query: str) -> int:
    return sum(1 for kw in keywords if kw and kw in query)


def _hit_keywords(keywords: list[str], query: str) -> list[str]:
    return [kw for kw in keywords if kw and kw in query]


def match_faq_with_stats(
    db: Session, tenant_id: str, agent_id: str, message: str
) -> tuple[AgentFaqItem | None, int, list[str]]:
    """FAQ 短路匹配，附带「候选条数」与命中的关键词（给执行过程展示用）。

    命中口径：**任意 1 个关键词命中即算命中**（2026-11-17 按业务反馈调整）。
    以前要求 ≥2 个关键词同时命中，实际问法里用户只会说出一个核心词——问
    「怎么报销」时只有「报销」能命中，「报销流程」那个关键词不会出现在句子
    里，于是永远不命中。误命中风险由 owner 维护关键词来兜：词表里放
    「报销」「发工资」这类业务词，别放「怎么」「流程」这类泛词。

    并列时取命中数多者，其次词表占比高者（词表更精准优先）。
    """

    query = normalize_text(message)
    if not query or len(query) < 2:
        return None, 0, []
    rows = db.exec(
        select(AgentFaqItem).where(
            AgentFaqItem.tenant_id == tenant_id,
            AgentFaqItem.agent_id == agent_id,
            AgentFaqItem.status == "active",
        )
    ).all()
    candidates = 0
    best: AgentFaqItem | None = None
    best_score: tuple[float, float] = (0.0, 0.0)
    best_hits: list[str] = []
    for row in rows:
        # 单字关键词不参与：中文里单字命中的噪音压倒性大于信号。
        keywords = [
            str(k).strip() for k in (row.keywords_json or []) if len(str(k or "").strip()) >= 2
        ]
        if not keywords:
            continue
        candidates += 1
        hits = _hit_keywords(keywords, query)
        if not hits:
            continue
        score = (float(len(hits)), len(hits) / max(1, len(keywords)))
        if best is None or score > best_score:
            best = row
            best_score = score
            best_hits = hits
    return best, candidates, best_hits


def match_faq(db: Session, tenant_id: str, agent_id: str, message: str) -> AgentFaqItem | None:
    """对话入口的 FAQ 短路匹配：取任一关键词命中的 active 条目（并列取分高者）。"""

    item, _candidates, _hits = match_faq_with_stats(db, tenant_id, agent_id, message)
    return item


def record_unanswered(
    db: Session,
    tenant_id: str,
    agent_id: str,
    query: str,
    *,
    session_id: str | None = None,
    message_id: str | None = None,
    source: str = "knowledge_refusal",
) -> AgentUnansweredQuery | None:
    """知识直答无法回答时收集 query；同员工同问合并 hit_count。

    转人工类关键词不进这个池（那类会有人工兜底，走 handoff 复盘），
    由调用方的守卫保证。
    """

    text = normalize_text(query)
    if not text or len(text) < 4:
        # 太短的问句多半是闲聊/误触，不收集
        return None
    digest = query_hash(text)
    row = db.exec(
        select(AgentUnansweredQuery).where(
            AgentUnansweredQuery.tenant_id == tenant_id,
            AgentUnansweredQuery.agent_id == agent_id,
            AgentUnansweredQuery.query_hash == digest,
        )
    ).first()
    now = utc_now()
    if row is None:
        row = AgentUnansweredQuery(
            tenant_id=tenant_id,
            agent_id=agent_id,
            query_hash=digest,
            query=str(query or "").strip()[:500],
            source=source,
            last_session_id=session_id,
            last_message_id=message_id,
        )
        db.add(row)
    else:
        row.hit_count = int(row.hit_count or 1) + 1
        row.last_session_id = session_id or row.last_session_id
        row.last_message_id = message_id or row.last_message_id
        row.updated_at = now
        if row.status == "dismissed":
            # 反复被问说明确实缺失，重新拉回待处理
            row.status = "pending"
        db.add(row)
    db.commit()
    db.refresh(row)
    return row


#: 收集去抖：命中次数陡增的重复 query 不必每轮都提醒，24h 内已处理过的
#: dismissed 条目重新拉回 pending 由这里控制（防噪音回灌）。
DISMISS_REPULL_COOLDOWN = timedelta(hours=24)


class FaqService:
    """FAQ CRUD + 待沉淀列表。权限（owner/租户管理员）在 API 层判定。"""

    def __init__(self, db: Session):
        self.db = db

    def list_items(self, tenant_id: str, agent_id: str) -> list[AgentFaqItem]:
        return list(
            self.db.exec(
                select(AgentFaqItem)
                .where(
                    AgentFaqItem.tenant_id == tenant_id,
                    AgentFaqItem.agent_id == agent_id,
                )
                .order_by(AgentFaqItem.created_at.desc())
            ).all()
        )

    def list_unanswered(self, tenant_id: str, agent_id: str) -> list[AgentUnansweredQuery]:
        return list(
            self.db.exec(
                select(AgentUnansweredQuery)
                .where(
                    AgentUnansweredQuery.tenant_id == tenant_id,
                    AgentUnansweredQuery.agent_id == agent_id,
                    AgentUnansweredQuery.status == "pending",
                )
                .order_by(AgentUnansweredQuery.hit_count.desc(), AgentUnansweredQuery.updated_at.desc())
            ).all()
        )

    def get_item(self, tenant_id: str, agent_id: str, item_id: str) -> AgentFaqItem | None:
        row = self.db.get(AgentFaqItem, item_id)
        if row and row.tenant_id == tenant_id and row.agent_id == agent_id:
            return row
        return None

    def create_item(
        self,
        tenant_id: str,
        agent_id: str,
        *,
        question: str,
        answer_markdown: str,
        keywords: list[str],
        created_by_user_id: str,
        source: str = "manual",
        source_id: str | None = None,
        status: str = "active",
    ) -> AgentFaqItem:
        now = utc_now()
        row = AgentFaqItem(
            tenant_id=tenant_id,
            agent_id=agent_id,
            question=str(question or "").strip()[:500],
            answer_markdown=str(answer_markdown or ""),
            keywords_json=[str(k).strip() for k in (keywords or []) if str(k or "").strip()],
            source=source,
            source_id=source_id,
            status=status,
            created_by_user_id=created_by_user_id,
            adopted_at=now,
        )
        self.db.add(row)
        if source_id:
            unresolved = self.db.get(AgentUnansweredQuery, source_id)
            if (
                unresolved
                and unresolved.tenant_id == tenant_id
                and unresolved.agent_id == agent_id
            ):
                unresolved.status = "faq_adopted"
                unresolved.faq_item_id = row.id
                unresolved.updated_at = now
                self.db.add(unresolved)
            # 转人工候选采纳后要离开「待沉淀」：handoff 的 answered 是业务状态
            # 不能改（审计/会话恢复还在用），所以按「已忽略」标记排除出列表。
            if source == "handoff":
                already = self.db.exec(
                    select(AgentFaqIgnoredHandoff).where(
                        AgentFaqIgnoredHandoff.tenant_id == tenant_id,
                        AgentFaqIgnoredHandoff.agent_id == agent_id,
                        AgentFaqIgnoredHandoff.handoff_id == source_id,
                    )
                ).first()
                if already is None:
                    self.db.add(
                        AgentFaqIgnoredHandoff(
                            tenant_id=tenant_id,
                            agent_id=agent_id,
                            handoff_id=source_id,
                            created_by_user_id=created_by_user_id,
                        )
                    )
        self.db.commit()
        self.db.refresh(row)
        return row

    def update_item(
        self,
        row: AgentFaqItem,
        *,
        question: str | None = None,
        answer_markdown: str | None = None,
        keywords: list[str] | None = None,
        status: str | None = None,
    ) -> AgentFaqItem:
        if question is not None and str(question).strip():
            row.question = str(question).strip()[:500]
        if answer_markdown is not None:
            row.answer_markdown = str(answer_markdown)
        if keywords is not None:
            row.keywords_json = [str(k).strip() for k in keywords if str(k or "").strip()]
        if status in {"active", "disabled"}:
            row.status = status
        row.updated_at = utc_now()
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row

    def delete_item(self, row: AgentFaqItem) -> None:
        self.db.delete(row)
        self.db.commit()
