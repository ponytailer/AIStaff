"""handoff brief 的规格测试。

覆盖三件容易出错的事：
1. `metadata.step_reply` 的规则抽取不能把「待用户补的信息」当成排查结论；
2. 批量计算不能退化成 N+1（这是 15 秒轮询下的硬约束）；
3. 孤儿 handoff（会话已删）不能抛异常，也不能把 bot 话术顶到标题位。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.core.engine import handoff_brief as hb
from app.db.models import ChatSession, HumanHandoffRequest, Message, Tenant, User


def _engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _seed(db: Session) -> None:
    db.add(Tenant(id="tenant_demo", name="Demo"))
    db.add(User(id="user_demo", tenant_id="tenant_demo", username="wei.liu", password_hash="x"))
    db.commit()


# ---------------------------------------------------------------- findings


def test_extract_findings_keeps_conclusions_and_drops_transfer_boilerplate() -> None:
    reply = (
        "已为您转接人工支持，后续由人工客服继续跟进处理。\n\n"
        "## 已排查的 Outlook 登录问题背景\n\n"
        "- 已确认问题类型：Outlook 客户端登录失败，与邮箱账户密码及初始密码状态相关。\n"
        "- 按《电脑端Outlook配置手册》要求，首次使用需先打开网页版邮箱。\n\n"
        "人工客服可直接沿用以上排查结果，无需您重复描述问题经过。"
    )
    findings = hb.extract_findings(reply)

    assert len(findings) == 2
    assert findings[0].text.startswith("已确认问题类型：Outlook")
    assert findings[1].text.startswith("按《电脑端Outlook配置手册》")
    joined = "".join(item.text for item in findings)
    assert "转接人工支持" not in joined
    assert "无需您重复描述" not in joined


def test_extract_findings_drops_pending_info_checklist() -> None:
    """「还需要您补充以下信息」是待办清单，不是排查结论。"""
    reply = (
        "好的，我来帮您申请 OA 系统的访问权限。目前还需要您补充以下信息：\n"
        "1. **员工工号**：请提供您的员工工号。\n"
        "2. **权限级别**：您需要哪种权限？例如只读、读写、管理员等。\n"
        "3. **访问级别/环境类型**：您需要访问哪个环境？\n"
    )
    assert hb.extract_findings(reply) == []


def test_extract_findings_keeps_past_reference_sentences() -> None:
    """「已根据您提供的信息…」引用的是既成事实，不能被待办规则误杀。"""
    reply = (
        "已根据您提供的信息（environment：production；system：crm）为您提交申请。\n\n"
        "- 工单号 TK001\n"
        "- 状态 待审批\n"
    )
    findings = hb.extract_findings(reply)
    assert [item.text for item in findings] == ["工单号 TK001", "状态 待审批"]


def test_extract_findings_falls_back_to_sentences_without_bullets() -> None:
    reply = "您的申请已受理并提交审批。审批结果将通过工单通知，您可凭工单号跟进进度。"
    findings = hb.extract_findings(reply)
    assert len(findings) == 2
    assert findings[0].text.startswith("您的申请已受理")


def test_extract_findings_returns_empty_for_blank_and_pure_transfer() -> None:
    assert hb.extract_findings(None) == []
    assert hb.extract_findings("   \n\n ") == []
    assert hb.extract_findings("正在为您转接人工客服，请稍候。") == []


# ------------------------------------------------------------------- slots


def test_build_slots_maps_labels_and_dedupes_aliases() -> None:
    slots = hb.build_slots(
        {
            "slots": {
                # SOP 同时写了三个同义 key，只应保留一个
                "system": "crm",
                "system_name": "crm",
                "target_system": "crm",
                "employee_id": "3019",
                "permission": "admin",
                "access_level": "production",
                "handoff_target": "IT主管审批",
                "routing": "manual_approval",
            }
        },
        {},
    )
    by_label = {slot.label: slot.value for slot in slots}

    assert by_label == {
        "员工工号": "3019",
        "目标系统": "CRM",
        "权限级别": "管理员",
        "访问范围": "生产环境",
        "流转目标": "IT主管审批",
        "流转方式": "人工审批",
    }
    # 别名去重：目标系统只出现一次
    assert [slot.label for slot in slots].count("目标系统") == 1


def test_build_slots_drops_internal_bookkeeping_keys() -> None:
    slots = hb.build_slots(
        {
            "slots": {
                "employee_id": "3019",
                "permission_preference": "倾向于申请生产环境的管理员权限",
                "approval_path": "n6_handoff",
                "node_id": "n6_handoff",
            }
        },
        {},
    )
    assert [slot.label for slot in slots] == ["员工工号"]


def test_build_slots_prefers_snapshot_over_session_current_value() -> None:
    """handoff 快照优先：session 现值可能已被后续轮次改写。"""
    slots = hb.build_slots(
        {"slots": {"employee_id": "3019"}},
        {"employee_id": "9999", "department": "IT"},
    )
    by_label = {slot.label: slot.value for slot in slots}
    assert by_label["员工工号"] == "3019"
    # session 里独有的 key 仍然补进来
    assert by_label["所属部门"] == "IT"


def test_build_slots_ignores_nested_and_empty_values() -> None:
    slots = hb.build_slots(
        {"slots": {"a": {"nested": 1}, "b": ["x"], "c": "", "d": None, "employee_id": "3019"}},
        None,
    )
    assert [slot.key for slot in slots] == ["employee_id"]


# --------------------------------------------------------------- transcript


def _session() -> ChatSession:
    return ChatSession(
        id="session_demo",
        tenant_id="tenant_demo",
        user_id="user_demo",
        agent_id="agent_demo",
        title="电脑outlook登陆总是显示用户名可能不正确",
        status="handoff",
    )


def test_build_transcript_marks_truncation_and_keeps_tail() -> None:
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    messages = [
        Message(
            id=f"msg_{index}",
            tenant_id="tenant_demo",
            session_id="session_demo",
            role="user" if index % 2 == 0 else "assistant",
            content=f"内容 {index}",
            created_at=base + timedelta(minutes=index),
        )
        for index in range(20)
    ]
    turns, truncated, total = hb.build_transcript(messages, limit=12)

    assert total == 20
    assert truncated is True
    assert len(turns) == 12
    assert turns[-1].text == "内容 19"  # 留在尾部


def test_build_transcript_marks_human_reply_role() -> None:
    message = Message(
        id="msg_human",
        tenant_id="tenant_demo",
        session_id="session_demo",
        role="user",
        content="总部每月7号发工资",
        metadata_json={"human_reply": True},
    )
    turns, _, _ = hb.build_transcript([message])
    assert turns[0].role == "human_reply"


def test_build_transcript_carries_citations_per_turn() -> None:
    message = Message(
        id="msg_assistant",
        tenant_id="tenant_demo",
        session_id="session_demo",
        role="assistant",
        content="按手册排查…",
        metadata_json={
            "knowledge_citations": [
                {"title": "PDF 文档 / 第 1 页"},
                {"title": "段落组 1"},
                {"bad": "item"},  # 脏数据要跳过
            ]
        },
    )
    turns, _, _ = hb.build_transcript([message])
    assert turns[0].citations == ["PDF 文档 / 第 1 页", "段落组 1"]


def test_aggregate_citations_dedupes_and_counts() -> None:
    msgs = [
        Message(
            id="m1",
            tenant_id="t",
            session_id="s",
            role="assistant",
            content="a",
            metadata_json={"knowledge_citations": [{"title": "段落组 1"}]},
        ),
        Message(
            id="m2",
            tenant_id="t",
            session_id="s",
            role="assistant",
            content="b",
            metadata_json={"knowledge_citations": [{"title": "段落组 1"}, {"title": "1.1手机端登录"}]},
        ),
        # user 消息里的引用不计入
        Message(
            id="m3",
            tenant_id="t",
            session_id="s",
            role="user",
            content="c",
            metadata_json={"knowledge_citations": [{"title": "不该出现"}]},
        ),
    ]
    citations = hb.aggregate_citations(msgs)
    assert [(item.title, item.count) for item in citations] == [
        ("段落组 1", 2),
        ("1.1手机端登录", 1),
    ]


# ------------------------------------------------------------------- ask


def _sop_handoff() -> HumanHandoffRequest:
    return HumanHandoffRequest(
        id="handoff_sop",
        tenant_id="tenant_demo",
        session_id="session_demo",
        trigger_skill_id="skill_perm_grant_routing_001",
        trigger_step_id="n6_handoff",
        metadata_json={"step": {"name": "转交IT主管审批"}, "step_reply": "- 工单号 TK001"},
    )


def test_build_ask_for_sop_uses_slots_instead_of_generic_phrase() -> None:
    slots = hb.build_slots(
        {"slots": {"system": "OA系统", "permission": "管理员", "access_level": "生产环境", "employee_id": "3019"}},
        {},
    )
    ask, source = hb.build_ask(
        _sop_handoff(), reason="sop_step", topic="申请权限", findings=[], slots=slots
    )

    assert source == "sop_step"
    assert "OA系统 管理员" in ask
    assert "生产环境" in ask
    assert "3019" in ask
    assert "转交IT主管审批" in ask
    assert "不必再向用户确认" in ask


def test_build_ask_for_sop_falls_back_to_step_id_when_step_metadata_missing() -> None:
    """线上 metadata.step 普遍是 {}，必须能用 trigger_step_id 兜住。"""
    handoff = HumanHandoffRequest(
        id="h",
        tenant_id="tenant_demo",
        session_id="session_demo",
        trigger_step_id="n6_handoff",
        metadata_json={},
    )
    ask, _ = hb.build_ask(handoff, reason="sop_step", topic=None, findings=[], slots=[])
    assert "n6_handoff" in ask


def test_build_ask_for_user_requested_mentions_topic_and_findings_count() -> None:
    findings = [hb.HandoffBriefFinding(text="结论一"), hb.HandoffBriefFinding(text="结论二")]
    ask, source = hb.build_ask(
        HumanHandoffRequest(id="h", tenant_id="t", session_id="s"),
        reason="user_requested",
        topic="Outlook 登录失败",
        findings=findings,
        slots=[],
    )
    assert source == "template"
    assert "Outlook 登录失败" in ask
    assert "2 条结论" in ask


def test_build_ask_without_findings_says_no_conclusion() -> None:
    ask, _ = hb.build_ask(
        HumanHandoffRequest(id="h", tenant_id="t", session_id="s"),
        reason="bot_escalated",
        topic="报销",
        findings=[],
        slots=[],
    )
    assert "没有给出明确结论" in ask
    assert "对话经过" in ask


def test_build_ask_for_orphan_handoff_does_not_pretend_to_have_context() -> None:
    ask, _ = hb.build_ask(
        HumanHandoffRequest(id="h", tenant_id="t", session_id="s"),
        reason="bot_escalated",
        topic=None,
        findings=[],
        slots=[],
    )
    assert "没有可用的会话记录" in ask


# ------------------------------------------------------ build_handoff_briefs


def test_build_handoff_briefs_end_to_end() -> None:
    engine = _engine()
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with Session(engine) as db:
        _seed(db)
        db.add(_session())
        db.add_all(
            [
                Message(
                    id="m1",
                    tenant_id="tenant_demo",
                    session_id="session_demo",
                    role="user",
                    content="电脑outlook登陆总是显示用户名可能不正确",
                    created_at=base,
                ),
                Message(
                    id="m2",
                    tenant_id="tenant_demo",
                    session_id="session_demo",
                    role="assistant",
                    content="请按以下顺序排查",
                    metadata_json={"knowledge_citations": [{"title": "PDF 文档 / 第 1 页"}]},
                    created_at=base + timedelta(minutes=1),
                ),
                Message(
                    id="m3",
                    tenant_id="tenant_demo",
                    session_id="session_demo",
                    role="user",
                    content="转人工",
                    created_at=base + timedelta(minutes=2),
                ),
            ]
        )
        handoff = HumanHandoffRequest(
            id="handoff_demo",
            tenant_id="tenant_demo",
            session_id="session_demo",
            requester_user_id="user_demo",
            status="pending",
            created_at=base + timedelta(minutes=3),
            metadata_json={
                "step": {},
                "step_reply": "已为您转接人工支持。\n\n- 已确认问题类型：Outlook 客户端登录失败。\n- 未修改初始密码将无法登入 Outlook。",
            },
        )
        db.add(handoff)
        db.commit()

        briefs = hb.build_handoff_briefs(db, [handoff], tenant_id="tenant_demo")
        brief = briefs["handoff_demo"]

    assert brief.topic == "电脑outlook登陆总是显示用户名可能不正确"
    # 会话里有「转人工」触发消息 → 用户主动转人工
    assert brief.reason == "user_requested"
    assert len(brief.findings) == 2
    assert "转接人工支持" not in "".join(item.text for item in brief.findings)
    assert len(brief.transcript) == 3
    assert brief.transcript_truncated is False
    assert [(c.title, c.count) for c in brief.citations] == [("PDF 文档 / 第 1 页", 1)]
    # rounds 只数真实用户发言（「转人工」也计入一次发言，但它不是提问）
    assert brief.rounds == 2
    assert brief.attempt_index == 1
    assert brief.waiting_seconds >= 0


def test_build_handoff_briefs_classifies_sop_reason() -> None:
    engine = _engine()
    with Session(engine) as db:
        _seed(db)
        db.add(_session())
        db.add(
            HumanHandoffRequest(
                id="handoff_sop",
                tenant_id="tenant_demo",
                session_id="session_demo",
                trigger_skill_id="skill_perm_grant_routing_001",
                trigger_step_id="n6_handoff",
                status="pending",
                resume_payload_json={
                    "slots": {"system": "OA系统", "permission": "管理员", "employee_id": "3019"}
                },
                metadata_json={"step": {"name": "转交IT主管审批"}},
            )
        )
        db.commit()

        brief = hb.build_handoff_briefs(
            db, db.exec(select(HumanHandoffRequest)).all(), tenant_id="tenant_demo"
        )["handoff_sop"]

    assert brief.reason == "sop_step"
    assert {slot.label for slot in brief.slots} == {"员工工号", "目标系统", "权限级别"}
    assert "SOP 卡在「转交IT主管审批」" in brief.ask


def test_build_handoff_briefs_survives_orphan_session() -> None:
    """线上 15/17 条 handoff 的会话行已不存在，绝不能因此 500。"""
    engine = _engine()
    with Session(engine) as db:
        _seed(db)
        db.add(
            HumanHandoffRequest(
                id="handoff_orphan",
                tenant_id="tenant_demo",
                session_id="session_gone",
                trigger_step_id="n6_handoff",
                status="pending",
                pending_question="正在为您转接人工客服，请稍候。",
                metadata_json={"step": {}},
            )
        )
        db.commit()

        brief = hb.build_handoff_briefs(
            db, db.exec(select(HumanHandoffRequest)).all(), tenant_id="tenant_demo"
        )["handoff_orphan"]

    assert brief.topic == "该会话已无原始记录"
    assert brief.transcript == []
    assert brief.citations == []
    # bot 话术不能变成标题
    assert "转接人工客服" not in brief.topic


def test_build_handoff_briefs_counts_repeated_handoff_per_session() -> None:
    """同一会话第 2 次转人工要能被标出来（线上 4 个会话各有 2 单）。"""
    engine = _engine()
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with Session(engine) as db:
        _seed(db)
        db.add(_session())
        db.add_all(
            [
                HumanHandoffRequest(
                    id="handoff_first",
                    tenant_id="tenant_demo",
                    session_id="session_demo",
                    status="answered",
                    created_at=base,
                ),
                HumanHandoffRequest(
                    id="handoff_second",
                    tenant_id="tenant_demo",
                    session_id="session_demo",
                    status="pending",
                    created_at=base + timedelta(hours=2),
                ),
            ]
        )
        db.commit()

        briefs = hb.build_handoff_briefs(
            db, db.exec(select(HumanHandoffRequest)).all(), tenant_id="tenant_demo"
        )

    assert briefs["handoff_first"].attempt_index == 1
    assert briefs["handoff_second"].attempt_index == 2


def test_build_handoff_briefs_uses_three_queries_regardless_of_row_count() -> None:
    """批量取数：行数增长不能让查询数增长（15 秒轮询下的硬约束）。"""
    engine = _engine()
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with Session(engine) as db:
        _seed(db)
        for index in range(12):
            session_id = f"session_{index}"
            db.add(
                ChatSession(
                    id=session_id,
                    tenant_id="tenant_demo",
                    user_id="user_demo",
                    title=f"问题 {index}",
                    status="handoff",
                )
            )
            db.add(
                Message(
                    id=f"msg_{index}",
                    tenant_id="tenant_demo",
                    session_id=session_id,
                    role="user",
                    content=f"提问 {index}",
                    created_at=base,
                )
            )
            db.add(
                HumanHandoffRequest(
                    id=f"handoff_{index}",
                    tenant_id="tenant_demo",
                    session_id=session_id,
                    status="pending",
                    created_at=base,
                )
            )
        db.commit()

        statements: list[str] = []

        def _record(conn, cursor, statement, params, context, executemany):  # noqa: ANN001
            statements.append(statement)

        event.listen(engine, "before_cursor_execute", _record)
        try:
            rows = db.exec(select(HumanHandoffRequest)).all()
            statements.clear()
            briefs = hb.build_handoff_briefs(db, rows, tenant_id="tenant_demo")
        finally:
            event.remove(engine, "before_cursor_execute", _record)

    assert len(briefs) == 12
    # sessions / messages / attempt 计数，各一条
    assert len(statements) == 3


def test_build_handoff_briefs_returns_empty_for_no_rows() -> None:
    engine = _engine()
    with Session(engine) as db:
        assert hb.build_handoff_briefs(db, [], tenant_id="tenant_demo") == {}


@pytest.mark.parametrize(
    ("step_reply", "expected_source"),
    [
        ("- 结论一\n- 结论二", "template"),
        ("", "template"),
    ],
)
def test_build_ask_source_is_stable(step_reply: str, expected_source: str) -> None:
    handoff = HumanHandoffRequest(
        id="h",
        tenant_id="t",
        session_id="s",
        metadata_json={"step_reply": step_reply},
    )
    _, source = hb.build_ask(
        handoff,
        reason="bot_escalated",
        topic="问题",
        findings=hb.extract_findings(step_reply),
        slots=[],
    )
    assert source == expected_source