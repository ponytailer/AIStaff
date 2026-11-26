"""定义器「接口」下拉的数据源：**只给这个员工能调的工具**。

锁的是这条口径（`app/api/scenes.py::list_scene_tool_options`）：

- 传 `agent_id` → 只列已绑定 + 已启用（与执行期 `visible_tool_rows` 同源）；
- 不传 → 广场口径（管理员验配置时没有员工语境）；
- 传了但不存在的 `agent_id` → 404，而不是静默给空列表。

## 为什么要单独一个文件

这个接口存在的唯一目的是「堵住界面层面的越权诱导」：下拉里列出来的，必须
就是执行时放行的。所以它的用例必须**同时**从两个方向验：不该出现的不能出现，
该出现的不能漏掉。
"""

from __future__ import annotations

import pytest

from dispatch_fixtures import TENANT, make_agent, memory_session, seed_tenant

from app.api.scenes import list_scene_tool_options
from app.db.models import AgentProfile, AgentResourceBinding, Tool

DELIVERY = {
    "name": "room.delivery_submit",
    "display_name": "客房送物受理",
    "bucket": "客房服务",
    "description": "把送物申请推给客房部",
    "method": "POST",
    "url": "https://mock.local/api/mock/room/delivery-submit",
    "headers_json": {},
    "auth_json": {},
    "input_schema": {"type": "object", "properties": {}},
    "output_schema": {"type": "object", "properties": {}},
    "allowed_skills_json": [],
    "enabled": True,
}

REPAIR = {
    **DELIVERY,
    "name": "repair.ticket_submit",
    "display_name": "报修工单",
    "bucket": "工程",
    "description": "开一张报修工单",
    "url": "https://mock.local/api/mock/repair/ticket-submit",
}


@pytest.fixture()
def db():
    session = memory_session()
    seed_tenant(session)
    session.add(make_agent("agent_xianlin", name="仙林 AI G.O", owner_id="user_owner"))
    session.add(Tool(tenant_id=TENANT, **DELIVERY))
    session.add(Tool(tenant_id=TENANT, **REPAIR))
    session.commit()
    return session


def _bind_tool(db, name: str, *, agent_id: str = "agent_xianlin", status: str = "active") -> None:
    from sqlmodel import select

    tool = db.exec(select(Tool).where(Tool.tenant_id == TENANT, Tool.name == name)).first()
    assert tool is not None, f"夹具里没有工具 {name}"
    db.add(
        AgentResourceBinding(
            tenant_id=TENANT,
            agent_id=agent_id,
            resource_type="tool",
            resource_id=tool.id,
            status=status,
        )
    )
    db.commit()


def _names(options) -> list[str]:
    return [item.name for item in options]


def _open_to_gallery(db, name: str) -> None:
    """把工具挂到 overall 员工上 = 在广场开放（`is_open_gallery_resource` 的口径）。"""
    from sqlmodel import select

    overall = db.exec(
        select(AgentProfile).where(
            AgentProfile.tenant_id == TENANT, AgentProfile.is_overall == True  # noqa: E712
        )
    ).first()
    if overall is None:
        overall = AgentProfile(
            id="agent_overall",
            tenant_id=TENANT,
            name="整体员工",
            is_overall=True,
            status="active",
        )
        db.add(overall)
        db.commit()
    tool = db.exec(select(Tool).where(Tool.tenant_id == TENANT, Tool.name == name)).first()
    db.add(
        AgentResourceBinding(
            tenant_id=TENANT,
            agent_id=overall.id,
            resource_type="tool",
            resource_id=tool.id,
            status="active",
        )
    )
    db.commit()


# ============================================================
# 传 agent_id：只给这个员工已绑 + 已启用的
# ============================================================


def test_only_bound_and_enabled_tools_are_listed(db):
    """绑了一个、另一个没绑 → 只出现绑了的那个。"""
    _bind_tool(db, "room.delivery_submit")

    options = list_scene_tool_options(tenant_id=TENANT, agent_id="agent_xianlin", db=db)

    assert _names(options) == ["room.delivery_submit"]
    # 没绑的那个绝不能出现 —— 这是「界面让人选了个调不通的」的源头
    assert "repair.ticket_submit" not in _names(options)


def test_agent_with_no_binding_gets_empty_list(db):
    """员工一个工具都没绑 → 空列表（前端据此提示「去绑定」）。"""
    options = list_scene_tool_options(tenant_id=TENANT, agent_id="agent_xianlin", db=db)

    assert options == []


def test_disabled_binding_is_excluded(db):
    """绑了但停在 `disabled`：`include_inactive=False` 的口径下不列。

    这条最容易漏 —— `visible_tool_rows` 的默认值是 `include_inactive=True`
    （工具管理页要用它显示「已停用」并让管理员重新启用）。执行期与下拉都必须
    显式传 `False`，传错的后果是「停用的工具照样能选、能调」。
    """
    _bind_tool(db, "room.delivery_submit", status="disabled")

    options = list_scene_tool_options(tenant_id=TENANT, agent_id="agent_xianlin", db=db)

    assert options == []


def test_globally_disabled_tool_is_excluded(db):
    """`Tool.enabled=False` → 不列。员工绑了也没用，那是全局定义开关。"""
    from sqlmodel import select

    _bind_tool(db, "room.delivery_submit")
    tool = db.exec(select(Tool).where(Tool.name == "room.delivery_submit")).first()
    tool.enabled = False
    db.add(tool)
    db.commit()

    options = list_scene_tool_options(tenant_id=TENANT, agent_id="agent_xianlin", db=db)

    assert options == []


def test_deleted_binding_is_excluded(db):
    """`status='deleted'` 是解绑（软删），不算绑定。"""
    _bind_tool(db, "room.delivery_submit", status="deleted")

    options = list_scene_tool_options(tenant_id=TENANT, agent_id="agent_xianlin", db=db)

    assert options == []


def test_options_carry_bucket_for_grouping(db):
    """带上 `bucket`：几百个工具时下拉要按段分组，一条长龙没法用。"""
    _bind_tool(db, "room.delivery_submit")

    options = list_scene_tool_options(tenant_id=TENANT, agent_id="agent_xianlin", db=db)

    assert options[0].bucket == "客房服务"
    assert options[0].description == "把送物申请推给客房部"


def test_unknown_agent_raises_404(db):
    """打错的 `agent_id` 必须 404，不能静默返回空列表。

    静默返回空的后果是「界面说这个员工一个工具都没有」，而真实原因是 id 错了 ——
    一个凭空捏造的结论，排查时会往完全错的方向走。
    """
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        list_scene_tool_options(tenant_id=TENANT, agent_id="agent_nope", db=db)

    assert exc.value.status_code == 404


# ============================================================
# 不传 agent_id：广场口径（管理员验配置时用）
# ============================================================


def test_without_agent_falls_back_to_open_gallery(db):
    """没有员工语境时按广场口径给：开放的一个、没开放的另一个。

    这是**刻意的**，不是漏了校验：定义器在「场景管理」页打开时本来就没有
    「哪个员工」这回事。真正执行时的拦截在 `ToolExecutor` 那层。
    """
    _open_to_gallery(db, "room.delivery_submit")
    _bind_tool(db, "repair.ticket_submit")  # 只绑给员工，没上广场

    options = list_scene_tool_options(tenant_id=TENANT, agent_id=None, db=db)

    assert _names(options) == ["room.delivery_submit"]
