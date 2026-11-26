"""FAQ 批量导入：Excel 解析、模型输出收敛、勾选落库。

这里不碰真实模型（LLMClient 会去打网络），只测三处纯逻辑 + 一次端到端 API：
1. `read_workbook` / `pair_rows_locally` —— 表头识别、兜底配对；
2. `sanitize_model_items` —— 模型输出的字段兼容与关键词补齐；
3. `commit_faq_import` —— 勾选结果落库，重复问题跳过而不是重复插入。
"""

from __future__ import annotations

import io

import pytest
from fastapi import HTTPException
from openpyxl import Workbook
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.api.faq import FaqImportCommitRequest, FaqImportItem, commit_faq_import
from app.db.models import AgentFaqItem, AgentProfile, Tenant, User
from app.faq.import_service import (
    MAX_KEYWORDS,
    MIN_KEYWORDS,
    ensure_keywords,
    pair_rows_locally,
    read_workbook,
    sanitize_model_items,
)


def _xlsx(rows: list[list[object]], sheet: str = "FAQ") -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _session() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_read_workbook_reads_named_sheet_and_skips_blank_rows() -> None:
    data = _xlsx(
        [
            ["问题", "答案"],
            ["报销几天到账", "T+3 个工作日"],
            ["", ""],
            ["发票丢了怎么办", "提交遗失说明"],
        ]
    )
    table = read_workbook(data)
    assert table.sheet_name == "FAQ"
    assert table.headers == ["问题", "答案"]
    assert table.rows_total == 2
    # 行号是 Excel 里的真实行号（表头占 1，数据从 2 起）
    assert [row.row_number for row in table.rows] == [2, 4]


def test_read_workbook_infers_headers_when_missing() -> None:
    """首行不像表头时不能当表头吃掉 —— 那是用户的第一条数据。"""

    data = _xlsx([["报销几天到账", "T+3"], ["发票丢了怎么办", "提交遗失说明"]])
    table = read_workbook(data)
    assert table.rows_total == 2
    candidates = pair_rows_locally(table)
    assert [c.question for c in candidates] == ["报销几天到账", "发票丢了怎么办"]


def test_pair_rows_locally_matches_by_header_name() -> None:
    data = _xlsx([["答案内容", "用户问法"], ["T+3 到账", "报销几天到账"]])
    candidates = pair_rows_locally(read_workbook(data))
    assert len(candidates) == 1
    assert candidates[0].question == "报销几天到账"
    assert candidates[0].answer == "T+3 到账"


def test_pair_rows_locally_drops_rows_without_answer() -> None:
    data = _xlsx([["问题", "答案"], ["报销几天到账", ""], ["发票丢了", "提交遗失说明"]])
    candidates = pair_rows_locally(read_workbook(data))
    assert [c.question for c in candidates] == ["发票丢了"]


def test_pair_rows_locally_splits_inline_qa() -> None:
    data = _xlsx([["QA"], ["问：发票丢了怎么办 答：提交遗失说明"]])
    candidates = pair_rows_locally(read_workbook(data))
    assert len(candidates) == 1
    assert candidates[0].question == "发票丢了怎么办"
    assert "提交遗失说明" in candidates[0].answer


def test_ensure_keywords_fills_to_minimum_from_question() -> None:
    keywords, enough = ensure_keywords("怎么重置密码", "", [])
    assert enough
    assert len(keywords) >= MIN_KEYWORDS
    assert "密码" in keywords


def test_ensure_keywords_drops_generic_and_single_char() -> None:
    keywords, enough = ensure_keywords("发票丢了还能报销吗", "", ["怎么", "报", "发票"])
    assert "怎么" not in keywords
    assert "报" not in keywords
    assert enough
    assert keywords[0] == "发票"


def test_ensure_keywords_caps_length() -> None:
    raw = ["发票", "丢失", "报销", "凭证", "说明", "付款", "审批"]
    keywords, enough = ensure_keywords("发票丢了", "", raw)
    assert enough
    assert len(keywords) <= MAX_KEYWORDS


def test_sanitize_model_items_accepts_chinese_keys_and_string_keywords() -> None:
    items = sanitize_model_items(
        {"items": [{"问题": "发票丢了怎么办", "答案": "提交遗失说明", "关键词": "发票、丢失"}]}
    )
    assert len(items) == 1
    assert items[0].keywords == ["发票", "丢失"]


def test_sanitize_model_items_drops_incomplete_pairs() -> None:
    items = sanitize_model_items(
        {"items": [{"question": "只有问题"}, {"question": "完整", "answer": "答案"}]}
    )
    assert [item.question for item in items] == ["完整"]


def _seed(db: Session) -> User:
    db.add(Tenant(id="tenant_demo", name="Demo"))
    user = User(
        id="user_owner",
        tenant_id="tenant_demo",
        username="owner",
        display_name="Owner",
        password_hash="x",
    )
    db.add(user)
    db.add(
        AgentProfile(
            id="agent1",
            tenant_id="tenant_demo",
            name="客服",
            metadata_json={"owner_user_id": user.id, "owner_username": user.username},
        )
    )
    db.commit()
    return user


def test_commit_faq_import_creates_selected_items_and_skips_duplicates() -> None:
    db = _session()
    user = _seed(db)

    request = FaqImportCommitRequest(
        tenant_id="tenant_demo",
        items=[
            FaqImportItem(question="发票丢了怎么办", answer="提交遗失说明", keywords=["发票", "丢失"]),
            FaqImportItem(question="发票丢了怎么办", answer="重复条目", keywords=["发票", "丢失"]),
            FaqImportItem(question="报销几天到账", answer="T+3", keywords=["报销", "到账"]),
        ],
    )
    result = commit_faq_import("agent1", request, user, db)

    assert result.created == 2
    assert result.skipped == 1
    rows = db.exec(select(AgentFaqItem).where(AgentFaqItem.tenant_id == "tenant_demo")).all()
    assert len(rows) == 2
    assert {row.source for row in rows} == {"import"}
    assert all(row.status == "active" for row in rows)


def test_commit_faq_import_rejects_item_without_keywords() -> None:
    db = _session()
    user = _seed(db)
    request = FaqImportCommitRequest(
        tenant_id="tenant_demo",
        items=[FaqImportItem(question="发票丢了怎么办", answer="提交遗失说明", keywords=["发票"])],
    )
    with pytest.raises(HTTPException) as excinfo:
        commit_faq_import("agent1", request, user, db)
    assert excinfo.value.status_code == 422


def test_commit_faq_import_rejects_empty_selection() -> None:
    db = _session()
    user = _seed(db)
    with pytest.raises(HTTPException) as excinfo:
        commit_faq_import("agent1", FaqImportCommitRequest(tenant_id="tenant_demo"), user, db)
    assert excinfo.value.status_code == 422

# --------------------------------------------------------------------------
# 任务链路：create_job → run_import_job → get_job
# --------------------------------------------------------------------------


def test_run_import_job_without_model_falls_back_to_columns(monkeypatch) -> None:
    """没有模型也要能出预览（按列推断），否则功能在未配模型的环境里等于不存在。"""

    from app.faq import import_jobs

    db = _session()
    _seed(db)
    monkeypatch.setattr(import_jobs, "engine", db.get_bind())
    monkeypatch.setattr(import_jobs, "_resolve_model", lambda *args, **kwargs: None)

    job = import_jobs.create_job(
        tenant_id="tenant_demo",
        user_id="user_owner",
        agent_id="agent1",
        filename="faq.xlsx",
        file_bytes=_xlsx([["问题", "答案"], ["发票丢了怎么办", "提交遗失说明"]]),
    )
    import_jobs.run_import_job(job.id)

    payload = import_jobs.get_job(job.id, tenant_id="tenant_demo", user_id="user_owner")
    assert payload is not None
    assert payload.status == import_jobs.STATUS_SUCCEEDED
    assert len(payload.items) == 1
    assert payload.items[0].question == "发票丢了怎么办"
    assert len(payload.items[0].keywords) >= MIN_KEYWORDS
    # 降级路径必须显式告知用户，不能悄悄给一份本地推断的结果
    assert any("按列推断" in warning for warning in payload.warnings)
    # 解析完释放原始字节
    assert payload.file_bytes == b""


def test_run_import_job_marks_existing_question(monkeypatch) -> None:
    from app.faq import import_jobs

    db = _session()
    _seed(db)
    db.add(
        AgentFaqItem(
            tenant_id="tenant_demo",
            agent_id="agent1",
            question="发票丢了怎么办",
            answer_markdown="旧答案",
            keywords_json=["发票", "丢失"],
            created_by_user_id="user_owner",
        )
    )
    db.commit()
    monkeypatch.setattr(import_jobs, "engine", db.get_bind())
    monkeypatch.setattr(import_jobs, "_resolve_model", lambda *args, **kwargs: None)

    job = import_jobs.create_job(
        tenant_id="tenant_demo",
        user_id="user_owner",
        agent_id="agent1",
        filename="faq.xlsx",
        file_bytes=_xlsx([["问题", "答案"], ["发票丢了怎么办", "提交遗失说明"]]),
    )
    import_jobs.run_import_job(job.id)

    payload = import_jobs.get_job(job.id, tenant_id="tenant_demo", user_id="user_owner")
    assert payload is not None
    assert "已存在同问题" in payload.items[0].note


def test_run_import_job_reports_bad_file(monkeypatch) -> None:
    from app.faq import import_jobs

    monkeypatch.setattr(import_jobs, "engine", _session().get_bind())
    monkeypatch.setattr(import_jobs, "_resolve_model", lambda *args, **kwargs: None)
    job = import_jobs.create_job(
        tenant_id="tenant_demo",
        user_id="user_owner",
        agent_id="agent1",
        filename="faq.xlsx",
        file_bytes=b"not an excel file",
    )
    import_jobs.run_import_job(job.id)
    payload = import_jobs.get_job(job.id, tenant_id="tenant_demo", user_id="user_owner")
    assert payload is not None
    assert payload.status == import_jobs.STATUS_FAILED
    assert payload.error


def test_job_is_scoped_to_owner() -> None:
    from app.faq import import_jobs

    job = import_jobs.create_job(
        tenant_id="tenant_demo",
        user_id="user_owner",
        agent_id="agent1",
        filename="faq.xlsx",
    )
    assert import_jobs.get_job(job.id, tenant_id="tenant_demo", user_id="user_other") is None
    assert import_jobs.get_job(job.id, tenant_id="tenant_demo", user_id="user_owner") is not None


def test_build_import_candidates_uses_model_output(monkeypatch) -> None:
    """模型可用时用模型归并的结果（含合并/拆分说明），不走列推断。"""

    from app.faq import import_service

    class FakeClient:
        def __init__(self, _config):
            pass

        def generate_json(self, _system, payload):
            # 一批 40 行以内，模型应拿到表头 + 行号
            assert payload["表格"]["行"][0]["行号"] == 2
            return {
                "items": [
                    {
                        "question": "发票丢了还能报销吗",
                        "answer": "可以，需提交发票丢失说明并附付款凭证。",
                        "keywords": ["发票", "报销"],
                        "rows": [2],
                        "note": "合并了第 2、5 行的内容",
                    }
                ]
            }

    monkeypatch.setattr("app.llm.LLMClient", FakeClient)

    db = _session()
    result = import_service.build_import_candidates(
        db,
        "tenant_demo",
        "agent1",
        data=_xlsx([["问题", "答案"], ["发票丢了还能报销吗", "可以，需提交遗失说明"]]),
        model_config=object(),
    )
    assert [item.question for item in result.candidates] == ["发票丢了还能报销吗"]
    assert result.candidates[0].note == "合并了第 2、5 行的内容"
    assert result.candidates[0].keywords == ["发票", "报销"]
    assert result.model_name is None  # object() 没有 model 属性


def test_build_import_candidates_falls_back_when_model_fails(monkeypatch) -> None:
    from app.faq import import_service

    class BrokenClient:
        def __init__(self, _config):
            pass

        def generate_json(self, *_args, **_kwargs):
            raise RuntimeError("gateway 502")

    monkeypatch.setattr("app.llm.LLMClient", BrokenClient)

    db = _session()
    result = import_service.build_import_candidates(
        db,
        "tenant_demo",
        "agent1",
        data=_xlsx([["问题", "答案"], ["发票丢了怎么办", "提交遗失说明"]]),
        model_config=object(),
    )
    assert [item.question for item in result.candidates] == ["发票丢了怎么办"]
    assert any("模型匹配失败" in warning for warning in result.warnings)
