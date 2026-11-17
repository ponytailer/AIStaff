"""反馈自进化 / 员工 FAQ 的核心行为测试。"""

from __future__ import annotations

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.db.models import AgentFaqIgnoredHandoff, AgentFaqItem, AgentUnansweredQuery
from app.faq.service import (
    FaqService,
    match_faq,
    normalize_text,
    record_unanswered,
    suggest_keywords,
)


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def _add_faq(
    db: Session,
    question: str,
    keywords: list[str],
    answer: str = "标准答案",
    status: str = "active",
) -> AgentFaqItem:
    return FaqService(db).create_item(
        "t1",
        "agent1",
        question=question,
        answer_markdown=answer,
        keywords=keywords,
        created_by_user_id="u1",
        status=status,
    )


def test_normalize_fullwidth_and_case() -> None:
    assert normalize_text("手机端　OUTLOOK 配置！") == "手机端outlook配置"
    assert normalize_text("邮箱,一直转圈。") == normalize_text("邮箱一直转圈")


def test_suggest_keywords_excludes_stopwords() -> None:
    kws = suggest_keywords("手机端怎么配置 Outlook 邮箱？")
    assert "outlook" in kws
    assert "配置" in kws
    for bad in ("怎么", "么配置", "怎么配"):
        assert bad not in kws


def test_match_requires_two_keyword_hits(db_session: Session) -> None:
    _add_faq(db_session, "手机端 Outlook 配置", ["手机", "outlook", "配置"])
    assert match_faq(db_session, "t1", "agent1", "手机端 outlook 怎么配置") is not None
    # 单关键词命中不触发（防泛词误答）
    assert match_faq(db_session, "t1", "agent1", "outlook 是什么") is None
    assert match_faq(db_session, "t1", "agent1", "完全无关的问题") is None


def test_match_ignores_disabled_and_other_agent(db_session: Session) -> None:
    _add_faq(db_session, "VPN 掉线处理", ["vpn", "掉线"], status="disabled")
    _add_faq(db_session, "报销单填写规范", ["报销", "发票"])
    assert match_faq(db_session, "t1", "agent1", "vpn 老是掉线") is None  # disabled 不匹配
    assert match_faq(db_session, "t1", "agent1", "会议室怎么预定") is None  # 词表不相交
    # 其他租户隔离
    _add_faq(db_session, "VPN 掉线处理", ["vpn", "掉线"])
    assert match_faq(db_session, "t2", "agent1", "vpn 老是掉线") is None


def test_record_unanswered_dedupes_and_counts(db_session: Session) -> None:
    first = record_unanswered(db_session, "t1", "agent1", "邮箱一直转圈登录不上")
    again = record_unanswered(db_session, "t1", "agent1", "邮箱一直转圈   登录不上！")
    assert first is not None and again is not None
    assert first.id == again.id
    assert again.hit_count == 2
    # 全角/大小写归一化后同 hash
    third = record_unanswered(db_session, "t1", "agent1", "邮箱一直转圈登录不上！")
    assert third.hit_count == 3
    # 太短的闲聊不收集
    assert record_unanswered(db_session, "t1", "agent1", "你好") is None


def test_dismissed_repulled_on_repeat(db_session: Session) -> None:
    row = record_unanswered(db_session, "t1", "agent1", "报销单驳回后怎么改")
    service = FaqService(db_session)
    row.status = "dismissed"
    db_session.add(row)
    db_session.commit()
    repulled = record_unanswered(db_session, "t1", "agent1", "报销单驳回后怎么改")
    assert repulled.status == "pending"
    service.list_unanswered("t1", "agent1")


def test_adopt_marks_source_resolved(db_session: Session) -> None:
    row = record_unanswered(db_session, "t1", "agent1", "飞书被锁找谁解锁")
    service = FaqService(db_session)
    item = service.create_item(
        "t1",
        "agent1",
        question="飞书被锁找谁解锁",
        answer_markdown="找 IT 服务台提工单。",
        keywords=["飞书", "解锁", "工单"],
        created_by_user_id="u1",
        source="unanswered",
        source_id=row.id,
    )
    assert row.id and row.faq_item_id == item.id
    refreshed = db_session.get(AgentUnansweredQuery, row.id)
    assert refreshed.status == "faq_adopted"
    assert service.list_unanswered("t1", "agent1") == []


def test_shortcircuit_plan_guard(db_session: Session) -> None:
    from app.core.plan.planner_fastpath import _faq_shortcircuit_plan

    _add_faq(db_session, "手机端 Outlook 配置", ["手机", "outlook", "配置"])
    session = type("S", (), {})()
    session.tenant_id = "t1"
    session.agent_id = "agent1"
    session.active_skill_id = None
    session.active_step_id = None
    session.pending_tasks_json = None
    session.awaiting_input_json = None

    plan = _faq_shortcircuit_plan(db_session, session, "手机端 outlook 怎么配置", [], None, "normal")
    assert plan is not None
    frame = plan.task_frames[0]
    assert frame.execution_mode == "faq_hit"
    assert frame.slot_hints.get("faq_answer") == "标准答案"

    # 转人工关键词优先：不短路
    assert _faq_shortcircuit_plan(db_session, session, "手机配置坏了 转人工", [], None, "normal") is None
    # 有活跃 SOP 时决策空间非空，不短路
    session.active_skill_id = "skill1"
    assert _faq_shortcircuit_plan(db_session, session, "手机端 outlook 怎么配置", [], None, "normal") is None


def test_adopt_from_handoff_removes_candidate_from_list(db_session: Session) -> None:
    """采纳转人工候选后必须离开「待沉淀」。

    handoff 的 answered 是业务状态不能改（审计/会话恢复还在用），所以按
    「已忽略」标记排除；同一 handoff 重复采纳也不能撞唯一约束。
    """

    def _adopt() -> None:
        FaqService(db_session).create_item(
            "t1",
            "agent1",
            question="工资什么时候发",
            answer_markdown="总部每月 7 号发工资",
            keywords=["工资", "发放"],
            created_by_user_id="u1",
            source="handoff",
            source_id="handoff_x",
        )

    _adopt()
    ignored = db_session.exec(
        select(AgentFaqIgnoredHandoff).where(AgentFaqIgnoredHandoff.handoff_id == "handoff_x")
    ).all()
    assert len(ignored) == 1
    assert ignored[0].created_by_user_id == "u1"
    assert ignored[0].agent_id == "agent1"

    # 幂等：同一 handoff 再采纳一次不会重复插忽略记录（唯一约束会炸）
    _adopt()
    assert len(
        db_session.exec(
            select(AgentFaqIgnoredHandoff).where(AgentFaqIgnoredHandoff.handoff_id == "handoff_x")
        ).all()
    ) == 1


def test_adopt_from_unanswered_keeps_ignored_table_clean(db_session: Session) -> None:
    """无法回答来源走 status=faq_adopted，不应污染忽略表。"""

    row = AgentUnansweredQuery(
        tenant_id="t1",
        agent_id="agent1",
        query="年假怎么请",
        query_hash="h1",
        source="model_refusal",
    )
    db_session.add(row)
    db_session.commit()

    FaqService(db_session).create_item(
        "t1",
        "agent1",
        question="年假怎么请",
        answer_markdown="OA 提交请假单",
        keywords=["年假", "请假"],
        created_by_user_id="u1",
        source="unanswered",
        source_id=row.id,
    )
    db_session.refresh(row)
    assert row.status == "faq_adopted"
    assert db_session.exec(select(AgentFaqIgnoredHandoff)).all() == []
