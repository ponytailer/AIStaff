"""FAQ 页的只读口径。

历史问题：`GET /agents/{id}/faq/count` 原来挂在 `ensure_agent_scope_manager`
下面，非 owner 打开别人的员工档案时直接 403 —— 档案页头部的 FAQ 指标空着，
FAQ tab 点进去也是三个 403，页面看起来像坏了。

现在的分工是：

- **读**（列表 / 计数 / 待沉淀候选）走 `ensure_agent_scope_viewer`：
  管理员、员工 owner、以及「广场里已发布」的员工对全租户可读。
- **写**（新建 / 修改 / 删除 / 忽略候选）仍然只认 `ensure_agent_scope_manager`：
  创建人或管理员，其他一律 403。

这两条必须一起测 —— 只测读放行，很容易把写接口也顺手改宽。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.api.faq import (
    create_faq_item,
    delete_faq_item,
    dismiss_unanswered_query,
    faq_overview_count,
    list_faq_items,
    list_handoff_candidates,
    list_unanswered_queries,
    update_faq_item,
)
from app.api.faq import FaqUpsertRequest, FaqUpdateRequest
from app.db.models import AgentProfile, Tenant, User


def _session() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _seed(db: Session, *, published: bool) -> tuple[User, User, User, AgentProfile]:
    """owner 拥有一个员工；other 租户内同事；admin 管理员。"""

    db.add(Tenant(id="tenant_demo", name="Demo"))
    owner = User(
        id="user_owner",
        tenant_id="tenant_demo",
        username="owner",
        display_name="Owner",
        password_hash="x",
    )
    other = User(
        id="user_other",
        tenant_id="tenant_demo",
        username="other",
        display_name="Other",
        password_hash="x",
    )
    admin = User(
        id="user_admin",
        tenant_id="tenant_demo",
        username="admin",
        display_name="Admin",
        role="admin",
        password_hash="x",
    )
    db.add(owner)
    db.add(other)
    db.add(admin)
    metadata: dict[str, object] = {"owner_user_id": owner.id, "owner_username": owner.username}
    if published:
        metadata["published_to_gallery"] = True
    agent = AgentProfile(
        id="agent_faq_scope",
        tenant_id="tenant_demo",
        name="小艾",
        metadata_json=metadata,
    )
    db.add(agent)
    db.commit()
    return owner, other, admin, agent


def test_readonly_endpoints_open_to_gallery_agents() -> None:
    """non-owner 对已发布员工能读：列表 / 计数 / 待沉淀都不许 403。"""

    with _session() as db:
        owner, other, _admin, agent = _seed(db, published=True)
        created = create_faq_item(
            agent.id,
            FaqUpsertRequest(
                tenant_id="tenant_demo",
                question="怎么报销",
                answer_markdown="走 OA",
                keywords=["报销"],
            ),
            current_user=owner,
            db=db,
        )
        assert created.question == "怎么报销"

        # other 不是创建人，但员工已发布 → 三个读接口都要通
        rows = list_faq_items(agent.id, tenant_id="tenant_demo", current_user=other, db=db)
        assert [row.id for row in rows] == [created.id]

        assert list_unanswered_queries(
            agent.id, tenant_id="tenant_demo", current_user=other, db=db
        ) == []
        assert list_handoff_candidates(
            agent.id, tenant_id="tenant_demo", current_user=other, db=db
        ) == []

        counts = faq_overview_count(
            agent.id, tenant_id="tenant_demo", current_user=other, db=db
        )
        # 档案页头部就是读这几个数
        assert counts["faq_items"] == 1
        assert counts["faq_active"] == 1


def test_readonly_endpoints_still_block_private_agents() -> None:
    """没发布的私有员工：non-owner 连读都不给（不然等于泄露别人的内部资料）。"""

    with _session() as db:
        _owner, other, _admin, agent = _seed(db, published=False)
        for call in (
            lambda: list_faq_items(agent.id, tenant_id="tenant_demo", current_user=other, db=db),
            lambda: list_unanswered_queries(
                agent.id, tenant_id="tenant_demo", current_user=other, db=db
            ),
            lambda: list_handoff_candidates(
                agent.id, tenant_id="tenant_demo", current_user=other, db=db
            ),
            lambda: faq_overview_count(
                agent.id, tenant_id="tenant_demo", current_user=other, db=db
            ),
        ):
            with pytest.raises(HTTPException) as error:
                call()
            assert error.value.status_code == 403


def test_write_endpoints_stay_owner_or_admin_only() -> None:
    """写接口一律 manager 口径：员工发布了也不代表同事能改它的 FAQ。"""

    with _session() as db:
        owner, other, admin, agent = _seed(db, published=True)
        created = create_faq_item(
            agent.id,
            FaqUpsertRequest(
                tenant_id="tenant_demo",
                question="怎么报销",
                answer_markdown="走 OA",
                keywords=["报销"],
            ),
            current_user=owner,
            db=db,
        )

        with pytest.raises(HTTPException) as create_error:
            create_faq_item(
                agent.id,
                FaqUpsertRequest(
                    tenant_id="tenant_demo",
                    question="再建一条",
                    answer_markdown="x",
                    keywords=["x"],
                ),
                current_user=other,
                db=db,
            )
        assert create_error.value.status_code == 403

        with pytest.raises(HTTPException) as update_error:
            update_faq_item(
                agent.id,
                created.id,
                FaqUpdateRequest(tenant_id="tenant_demo", status="disabled"),
                current_user=other,
                db=db,
            )
        assert update_error.value.status_code == 403

        with pytest.raises(HTTPException) as delete_error:
            delete_faq_item(
                agent.id, created.id, tenant_id="tenant_demo", current_user=other, db=db
            )
        assert delete_error.value.status_code == 403

        with pytest.raises(HTTPException) as dismiss_error:
            dismiss_unanswered_query(
                agent.id, "query_x", tenant_id="tenant_demo", current_user=other, db=db
            )
        assert dismiss_error.value.status_code == 403

        # admin 可以改
        updated = update_faq_item(
            agent.id,
            created.id,
            FaqUpdateRequest(tenant_id="tenant_demo", status="disabled"),
            current_user=admin,
            db=db,
        )
        assert updated.status == "disabled"