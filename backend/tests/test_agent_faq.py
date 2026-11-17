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


def test_match_hits_on_single_keyword(db_session: Session) -> None:
    """任意 1 个关键词命中即算命中。

    真实问法只会说出一个核心词：问「怎么报销」时句子里只有「报销」，
    「报销流程」这种长关键词永远不出现——按 ≥2 命中会让 FAQ 建了也命不中。
    """

    _add_faq(db_session, "手机端 Outlook 配置", ["手机", "outlook", "配置"])
    assert match_faq(db_session, "t1", "agent1", "手机端 outlook 怎么配置") is not None
    # 单个关键词命中即返回
    assert match_faq(db_session, "t1", "agent1", "outlook 是什么") is not None
    # 一个词都不沾才不命中
    assert match_faq(db_session, "t1", "agent1", "完全无关的问题") is None


def test_match_prefers_more_hits_then_specific(db_session: Session) -> None:
    """多条同时命中时取命中数多者；命中数相同取词表更精准者。"""

    # broad：词表更杂（还挂了「怎么」），命中占比低；exact：两个词都被说中
    broad = _add_faq(db_session, "报销流程", ["报销", "怎么", "发票"])
    exact = _add_faq(db_session, "报销流程与审批", ["报销", "流程"])
    matched = match_faq(db_session, "t1", "agent1", "报销流程怎么走")
    # 两条都命中 2 个词，但 exact 的命中占比 2/2 > broad 的 2/3 → 选 exact
    assert matched is not None and matched.id == exact.id
    assert broad.id != exact.id


def test_single_char_keywords_ignored(db_session: Session) -> None:
    _add_faq(db_session, "报销流程", ["报"])  # 单字词整条不参与，等于没有可用关键词
    assert match_faq(db_session, "t1", "agent1", "报一下") is None


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


def test_shortcircuit_traces_hit_and_miss(db_session: Session) -> None:
    """执行过程要能看见 FAQ 检索：命中、未命中各留一条 trace。"""

    from app.core.plan.planner_fastpath import _faq_shortcircuit_plan

    _add_faq(db_session, "报销流程", ["报销", "流程"])
    session = type("S", (), {})()
    session.tenant_id = "t1"
    session.agent_id = "agent1"
    session.active_skill_id = None
    session.active_step_id = None
    session.pending_tasks_json = None
    session.awaiting_input_json = None

    traces: list[tuple[str, dict]] = []

    def trace(text: str, extra: dict) -> None:
        traces.append((text, extra))

    plan = _faq_shortcircuit_plan(
        db_session, session, "怎么报销", [], None, "normal", on_trace=trace
    )
    assert plan is not None
    assert traces and traces[0][1]["faq_hit"] is True
    assert traces[0][1]["query"] == "怎么报销"
    assert "报销" in traces[0][1]["faq_keywords"]

    traces.clear()
    assert (
        _faq_shortcircuit_plan(
            db_session, session, "会议室怎么预定", [], None, "normal", on_trace=trace
        )
        is None
    )
    assert traces and traces[0][1]["faq_hit"] is False
    assert traces[0][1]["faq_candidates"] == 1

    # 一条 FAQ 都没有的 agent 不刷「未命中」噪音
    traces.clear()
    session.agent_id = "agent_without_faq"
    _faq_shortcircuit_plan(
        db_session, session, "会议室怎么预定", [], None, "normal", on_trace=trace
    )
    assert traces == []


def test_handoff_query_skips_human_reply_and_falls_back() -> None:
    """采纳为 FAQ 的「用户问法」：跳过 owner 人工回复，优先会话真实提问。

    真实踩坑：owner 从「待回答」回复的内容落库也是 user 角色，旧逻辑会把
    它当问法；会话消息被清理后又会把 bot 转接话术（pending_question）当问法。"""
    from app.api.faq import _handoff_query
    from app.db.models import HumanHandoffRequest, Message

    def _msg(content: str, human_reply: bool = False) -> Message:
        return Message(
            id=f"msg_{content[:6]}",
            tenant_id="t1",
            session_id="s1",
            role="user",
            content=content,
            metadata_json={"human_reply": True} if human_reply else {},
        )

    # 会话里有人工回复 + 真实提问：取真实提问
    row = HumanHandoffRequest(
        id="handoff_1", tenant_id="t1", session_id="s1", pending_question="bot 转接话术"
    )

    class _FakeResult:
        def __init__(self, rows: list) -> None:
            self._rows = rows

        def all(self) -> list:
            return self._rows

    class _FakeDb:
        def __init__(self, rows: list) -> None:
            self._rows = rows

        def exec(self, _statement: object) -> _FakeResult:
            return _FakeResult(self._rows)

    assert (
        _handoff_query(_FakeDb([_msg("总部每月7号发工资", human_reply=True), _msg("工资什么时候发")]), row)
        == "工资什么时候发"
    )

    # 会话消息被清空：回退到 pending_question（写路径已改为存真实问法）
    assert _handoff_query(_FakeDb([]), row) == "bot 转接话术"


def test_shortcircuit_plan_survives_planner_normalize(db_session: Session) -> None:
    """FAQ 短路计划必须活着穿过 planner._normalize。

    真实踩坑：_normalize 的 execution_mode 白名单漏了 faq_hit，命中帧被降级
    成 standard 走完整 LLM——执行记录显示「命中 FAQ」，回复却是模型自己编的。
    """
    from app.core.plan.planner import TurnPlanner
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

    normalized = TurnPlanner.__new__(TurnPlanner)._normalize(
        plan, "手机端 outlook 怎么配置", session, [], None, "normal"
    )
    assert len(normalized.task_frames) == 1
    frame = normalized.task_frames[0]
    assert frame.execution_mode == "faq_hit"
    assert frame.decision == "answer_only"
    assert frame.slot_hints.get("faq_answer") == "标准答案"
    assert (frame.slot_hints or {}).get("faq_item_id")


def test_shortcircuit_ignores_pending_handoff_frame(db_session: Session) -> None:
    """转人工挂起（handoff 帧非终态）不能挡 FAQ 短路。

    真实踩坑：用户先「怎么报销」（无命中）→「转人工」产生 status=handoff
    的 conversation 帧 → 再问「怎么报销」，守卫 or task_frame_state 命中，
    短路静默失效（连未命中 trace 都没有），回复退化成 LLM 泛答。
    """
    from app.core.plan.planner_fastpath import _faq_shortcircuit_plan

    _add_faq(db_session, "报销流程", ["报销", "流程"])
    session = type("S", (), {})()
    session.tenant_id = "t1"
    session.agent_id = "agent1"
    session.active_skill_id = None
    session.active_step_id = None
    session.pending_tasks_json = None
    session.awaiting_input_json = None

    handoff_state = [{"task_id": "t1", "kind": "conversation", "status": "handoff"}]
    plan = _faq_shortcircuit_plan(db_session, session, "怎么报销", [], handoff_state, "normal")
    assert plan is not None
    assert plan.task_frames[0].execution_mode == "faq_hit"

    # 其余非终态帧仍然拦截：进行中的 conversation、SOP 帧（含挂起的）
    in_progress = [{"task_id": "t2", "kind": "conversation", "status": "in_progress"}]
    assert _faq_shortcircuit_plan(db_session, session, "怎么报销", [], in_progress, "normal") is None
    sop_pending = [{"task_id": "t3", "kind": "sop", "status": "handoff"}]
    assert _faq_shortcircuit_plan(db_session, session, "怎么报销", [], sop_pending, "normal") is None
