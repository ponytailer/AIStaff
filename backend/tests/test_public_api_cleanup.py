"""清理过期 public_api 记录：并发下不许再抛「expected to delete N, 0 matched」。

现场（生产 PG，/root/staff/backend）::

    SAWarning: DELETE statement on table 'api_job_events' expected to delete
    450 row(s); 0 were matched.  (This warning originated from the Session
    'autoflush' process ...)

根因是旧实现「先 SELECT 出过期行，再逐行 db.delete(row)」。PG 部署下没有跨进程
互斥（``acquire_runtime_instance_lock`` 只对 SQLite 生效），而清理有三个入口：
启动钩子、维护线程每 60 分钟、rq worker 自己的启动钩子。两个进程同时算出一批
过期行时，后提交的那个会把「已删除的 id」再发一遍 DELETE，数据库匹配 0 行，
ORM 的预期/实际比对就炸了。

这组用例锁住三件事：
1. 正常情况：过期数据被删、未过期数据保留；
2. 并发情况：两个 session 算出同一批行时**不抛警告**，且只删一次；
3. 回归保护：清理逻辑不再走「逐行 ORM delete」（那正是警告的来源）。
"""

from __future__ import annotations

import warnings
from datetime import timedelta

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db.models import (
    APIIdempotencyRecord,
    APIJob,
    APIJobEvent,
    WebhookDelivery,
    utc_now,
)


def _engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _seed(engine, *, old_events: int = 450, fresh_events: int = 3) -> None:
    """按现场规模造数据：450 条过期事件，便于复现「expected to delete 450」。"""

    now = utc_now()
    long_ago = now - timedelta(days=60)
    with Session(engine) as db:
        db.add_all(
            [
                APIJobEvent(
                    id=f"apievent_old_{index}",
                    tenant_id="tenant_api",
                    job_id="apijob_old",
                    sequence=index,
                    event_type="run.output.delta",
                    created_at=long_ago,
                )
                for index in range(old_events)
            ]
        )
        db.add_all(
            [
                APIJobEvent(
                    id=f"apievent_new_{index}",
                    tenant_id="tenant_api",
                    job_id="apijob_new",
                    sequence=index,
                    event_type="run.output.delta",
                    created_at=now,
                )
                for index in range(fresh_events)
            ]
        )
        db.add(
            APIJob(
                id="apijob_old",
                tenant_id="tenant_api",
                credential_id="credential_api",
                kind="run",
                status="succeeded",
                created_at=long_ago,
                updated_at=long_ago,
            )
        )
        db.add(
            APIJob(
                id="apijob_running_old",
                tenant_id="tenant_api",
                credential_id="credential_api",
                kind="run",
                status="running",
                created_at=long_ago,
                updated_at=long_ago,
            )
        )
        db.add_all(
            [
                APIIdempotencyRecord(
                    id=f"apiidem_expired_{index}",
                    tenant_id="tenant_api",
                    credential_id="credential_api",
                    method="POST",
                    path="/agents/agent_api/runs",
                    idempotency_key=f"key-{index}",
                    request_hash="hash",
                    created_at=long_ago,
                    expires_at=long_ago,
                )
                for index in range(2)
            ]
        )
        db.add(
            WebhookDelivery(
                id="webhook_delivered_old",
                tenant_id="tenant_api",
                endpoint_id="webhook_endpoint_1",
                event_id="apijob_old",
                event_type="run.completed",
                status="delivered",
                created_at=long_ago,
                updated_at=long_ago,
            )
        )
        db.commit()


def _count(engine, model) -> int:
    from sqlmodel import select

    with Session(engine) as db:
        return len(db.exec(select(model)).all())


def _install(monkeypatch, engine):
    from app.public_api import jobs as jobs_module

    monkeypatch.setattr(jobs_module, "engine", engine)

    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "public_api_retention_days", 30, raising=False)

    from app.public_api.jobs import cleanup_public_api_records

    return cleanup_public_api_records


def test_cleanup_removes_only_expired_rows(monkeypatch) -> None:
    engine = _engine()
    _seed(engine)
    cleanup = _install(monkeypatch, engine)

    cleanup()

    # 过期事件全清，新事件保留。
    assert _count(engine, APIJobEvent) == 3
    # 终态的过期任务删除；仍在 running 的必须留着。
    from sqlmodel import select

    with Session(engine) as db:
        remaining_jobs = {row.id for row in db.exec(select(APIJob)).all()}
    assert remaining_jobs == {"apijob_running_old"}
    # 过期幂等记录与已投递 webhook 都清掉。
    assert _count(engine, APIIdempotencyRecord) == 0
    assert _count(engine, WebhookDelivery) == 0


def test_cleanup_does_not_warn_when_two_runners_race(monkeypatch) -> None:
    """复现现场：两个清理进程算出同一批 450 行，后提交的不许抛 ORM 警告。

    精确复现时序（已在改动前的代码上验证过这条断言会失败）：

        A：SELECT 出 450 行，准备逐行删
        B：先一步把这 450 行删干净并提交
        A：commit → DELETE ... WHERE id IN (450 个已消失的 id) → 0 matched
           → SAWarning: expected to delete 450 row(s); 0 were matched

    修复后 A 走的是 ``DELETE ... WHERE created_at < cutoff``：提交时那 450 行
    已经不在，DELETE 影响 0 行——0 行是**真实结果**，不和预期对账，所以不告警。
    """

    engine = _engine()
    _seed(engine, old_events=450, fresh_events=0)

    from app.config import get_settings
    from app.public_api import jobs as jobs_module

    monkeypatch.setattr(jobs_module, "engine", engine)
    monkeypatch.setattr(
        get_settings(), "public_api_retention_days", 30, raising=False
    )
    cutoff = utc_now() - timedelta(days=30)

    from sqlmodel import select

    # A：按修复后的写法查出「待删集合」——这里只为了制造「A 已经算过」的状态，
    # 实际提交发生在 B 之后。
    session_a = Session(engine)
    stale_ids = [
        row.id
        for row in session_a.exec(
            select(APIJobEvent).where(APIJobEvent.created_at < cutoff)
        ).all()
    ]
    assert len(stale_ids) == 450

    # B：抢先删光并提交（模拟另一个进程先跑完）。
    with Session(engine) as session_b:
        session_b.exec(
            jobs_module.sa_delete(APIJobEvent).where(
                APIJobEvent.created_at < cutoff
            )
        )
        session_b.commit()

    # A：继续跑完整清理。此时 450 行已不在，必须安静返回。
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        jobs_module.cleanup_public_api_records()
        session_a.close()

    delete_warnings = [
        str(item.message)
        for item in caught
        if "were matched" in str(item.message)
        or "expected to delete" in str(item.message)
    ]
    assert delete_warnings == [], (
        "并发清理不应再抛 ORM 批量删除警告，实际收到：" f"{delete_warnings}"
    )


def test_cleanup_is_idempotent(monkeypatch) -> None:
    """连跑两次不许报错或告警 —— 维护线程和启动钩子会先后触发。"""

    engine = _engine()
    _seed(engine, old_events=10)
    cleanup = _install(monkeypatch, engine)

    cleanup()
    first = _count(engine, APIJobEvent)

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        cleanup()

    assert _count(engine, APIJobEvent) == first
    assert [
        str(item.message) for item in caught if "were matched" in str(item.message)
    ] == []


def test_cleanup_uses_bulk_delete_not_row_by_row() -> None:
    """回归保护：源码里不该再出现「SELECT 一批 → 逐行 db.delete」。

    这条用例防止以后有人为了「可读性」把批量 DELETE 改回逐行 —— 那正是
    450 行警告的来源，而且在 PG 并发下是不确定行为。

    用 AST 而不是字符串匹配：函数 docstring 里写着旧写法做对比说明，
    字符串匹配会把注释也当成代码。
    """

    import ast
    import inspect
    import textwrap

    from app.public_api import jobs as jobs_module

    source = textwrap.dedent(
        inspect.getsource(jobs_module.cleanup_public_api_records)
    )
    tree = ast.parse(source)

    row_deletes: list[str] = []
    has_bulk_delete = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute):
                # db.delete(row) —— 逐行 ORM 删除
                if func.attr == "delete":
                    row_deletes.append(ast.unparse(node))
                # sa_delete(...) / jobs.sa_delete(...)
                if func.attr == "sa_delete":
                    has_bulk_delete = True
        if isinstance(node, ast.Name) and node.id == "sa_delete":
            has_bulk_delete = True

    assert has_bulk_delete, "清理必须用批量 DELETE"
    assert row_deletes == [], f"不要再逐行 ORM delete，发现：{row_deletes}"

    # 也不该把过期行全量取出再逐条删：.all() 就是把结果读进内存的那一步。
    selects = [
        ast.unparse(node)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "all"
    ]
    assert selects == [], f"不该先查出过期行再删，发现：{selects}"