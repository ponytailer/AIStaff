"""场景 API（`/api/enterprise/scenes`）的端到端测试。

关注五件事，每一条都对应一个真实会踩的坑：

1. **权限**：场景是租户级定义，不绑员工时没有 agent_id 可传。而
   ``ensure_agent_scope_manager(db, tenant_id, None, user)`` 在 agent_id
   为空时**直接 return**——照抄其它资源那套写法会让任何成员都能改删别人的场景。
2. **绑定语义**：``PUT /{id}/agents`` 是整体覆盖。加了一个忘了减另一个，
   会把场景偷偷挂到别人的员工上。
3. **删除要连带收尾**：只删场景行会留下孤儿 binding，员工档案页出现
   「点进去 404」的空条目。
4. **空结果的解释**：必须量化说卡在哪一层（人数/天数/闸门），
   一句「没找到」等于把问题丢回给用户。
5. **导入质量**：表里的脏值必须被检出并告知，不能静默吃掉。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import select

sys.path.insert(0, str(Path(__file__).parent))

from dispatch_fixtures import (
    ADMIN_ID,
    MEMBER_A,
    OTHER_ID,
    OWNER_ID,
    TENANT,
    make_agent,
    make_user,
    memory_session,
    seed_tenant,
)

from app.api import scenes as scenes_api
from app.db import get_session
from app.db.models import (
    AgentProfile,
    AgentResourceBinding,
    Scene,
    SceneRun,
    SceneTableRow,
)
from app.security.auth import get_current_user

BASE = "/api/enterprise/scenes"

# 一张典型的行程表：人数 / 天数 / 预算 / 计划内容。
# 刻意让「4人5天」与「4天4人」两行共存 —— 后者是列写反的脏数据，
# 用来验证列级单位校验（见 matcher._EXPECTED_UNIT_BY_SLOT）。
CSV_FIXTURE = (
    "人数,天数,预算,计划内容\n"
    "4,5,3000,经典雪山五日\n"
    "4,5,6000,深度滑雪五日\n"
    "4天,4,3000,列写反的脏数据\n"
    "2,3,2000,双人三日\n"
    "6,7,9000,大团七日\n"
)


def _client(db, user):
    app = FastAPI()
    app.include_router(scenes_api.router)
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


@pytest.fixture()
def db():
    session = memory_session()
    seed_tenant(session)
    session.add(make_agent(MEMBER_A, name="行程规划", owner_id=OWNER_ID))
    session.commit()
    return session


def _import_table(client: TestClient, content: str = CSV_FIXTURE, name: str = "滑雪价目") -> dict:
    resp = client.post(
        f"{BASE}/tables/import",
        params={"tenant_id": TENANT, "name": name},
        files={"file": ("ski.csv", content.encode("utf-8"), "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _create_scene(client: TestClient, table_id: str, *, name: str = "滑雪行程推荐", agent_id=None) -> dict:
    payload = {
        "tenant_id": TENANT,
        "name": name,
        "description": "按人数天数预算推荐行程",
        "tables": [table_id],
        "status": "published",
        "agent_id": agent_id,
        "slots": [
            {"key": "people", "target": "人数", "required": True},
            {"key": "days", "target": "天数", "required": True},
            {"key": "budget", "target": "预算", "required": True},
        ],
    }
    resp = client.post(BASE, json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# 导入
# ---------------------------------------------------------------------------


def test_import_csv_parses_columns_and_rows(db) -> None:
    client = _client(db, make_user(OWNER_ID))
    body = _import_table(client)

    table = body["table"]
    assert table["row_count"] == 5
    # 表头关键词优先于样本推断：「预算」列就算全是数字也让 type=number/unit=元
    by_key = {c["key"]: c for c in table["columns"]}
    assert by_key["人数"]["unit"] == "人"
    assert by_key["天数"]["unit"] == "天"
    assert by_key["预算"]["unit"] == "元"
    assert by_key["预算"]["type"] == "number"
    # 计划内容是自由文本，不能被猜成数字
    assert by_key["计划内容"]["type"] == "text"
    # 预览只给前 20 行，原值原样返回（用户要来对账）
    assert len(body["rows"]) == 5
    assert body["rows"][0]["values"]["计划内容"] == "经典雪山五日"


def test_import_detects_dirty_values_without_swallowing_them(db) -> None:
    """「4天」填在人数列 → 必须报列级单位不匹配，而不是静默当 4。"""
    client = _client(db, make_user(OWNER_ID))
    body = _import_table(client)
    codes = {q["code"] for q in body["table"]["quality"]}
    assert "unit_mismatch" in codes
    issue = next(q for q in body["table"]["quality"] if q["code"] == "unit_mismatch")
    assert issue["column"] == "人数"
    assert issue["row_count"] >= 1


def test_import_rejects_unsupported_extension(db) -> None:
    client = _client(db, make_user(OWNER_ID))
    resp = client.post(
        f"{BASE}/tables/import",
        params={"tenant_id": TENANT},
        files={"file": ("a.pdf", b"%PDF-1.4", "application/pdf")},
    )
    assert resp.status_code == 400
    assert "xlsx" in resp.json()["detail"] or "csv" in resp.json()["detail"]


def test_import_rejects_empty_file(db) -> None:
    client = _client(db, make_user(OWNER_ID))
    resp = client.post(
        f"{BASE}/tables/import",
        params={"tenant_id": TENANT},
        files={"file": ("a.csv", b"", "text/csv")},
    )
    assert resp.status_code == 400
    assert "空" in resp.json()["detail"]


def test_imported_rows_keep_both_raw_and_normalized(db) -> None:
    """原值与归一化值都要落库。只存归一化值就无法回答「为什么这行没命中」。

    注意 ``norm_json`` 里的 unit 是**值级**的：单元格原文是裸 ``3000``，
    没有单位，所以这里 unit 为空。列级单位（元/人/天）存在 ``columns_json`` 里，
    两者不能混——混了会让「表里写 4、列是人数」和「表里写 4人」变成同一件事。
    """
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]

    rows = db.exec(select(SceneTableRow).where(SceneTableRow.table_id == table_id)).all()
    assert len(rows) == 5
    first = next(r for r in rows if r.row_index == 0)
    assert first.row_json["预算"] == "3000"
    assert first.norm_json["预算"]["num"] == 3000
    assert first.norm_json["预算"]["unit"] == ""
    # 脏行「4天」写进了人数列：值级单位应是「天」，这才叫「原样记下来」
    dirty = next(r for r in rows if r.row_json.get("计划内容") == "列写反的脏数据")
    assert dirty.norm_json["人数"]["num"] == 4
    assert dirty.norm_json["人数"]["unit"] == "天"


# ---------------------------------------------------------------------------
# CRUD 与权限
# ---------------------------------------------------------------------------


def test_create_requires_admin_when_not_bound_to_agent(db) -> None:
    """不绑员工的场景只有管理员能建。

    这是本次修的真实漏洞：``ensure_agent_scope_manager(None)`` 直接 return，
    照着其它资源写就等于不校验，任何成员都能造出租户级配置。
    """
    table_id = _import_table(_client(db, make_user(OWNER_ID)))["table"]["id"]

    member_client = _client(db, make_user(OTHER_ID))
    resp = member_client.post(
        BASE,
        json={"tenant_id": TENANT, "name": "成员私建", "tables": [table_id]},
    )
    assert resp.status_code == 403

    admin_client = _client(db, make_user(ADMIN_ID, role="admin"))
    ok = admin_client.post(
        BASE, json={"tenant_id": TENANT, "name": "管理员建", "tables": [table_id]}
    )
    assert ok.status_code == 200, ok.text


def test_create_bound_to_own_agent_allowed_for_member(db) -> None:
    table_id = _import_table(_client(db, make_user(OWNER_ID)))["table"]["id"]
    client = _client(db, make_user(OWNER_ID))
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)
    assert scene["agent_ids"] == [MEMBER_A]


def test_create_bound_to_someone_elses_agent_is_forbidden(db) -> None:
    """MEMBER_A 挂在 OWNER 名下，OTHER 不能把自己的场景塞进去。"""
    table_id = _import_table(_client(db, make_user(OWNER_ID)))["table"]["id"]
    client = _client(db, make_user(OTHER_ID))
    resp = client.post(
        BASE,
        json={
            "tenant_id": TENANT,
            "name": "偷挂场景",
            "tables": [table_id],
            "agent_id": MEMBER_A,
        },
    )
    assert resp.status_code == 403


def test_update_and_delete_reject_non_owner_member(db) -> None:
    """成员不能改/删别人的场景（同一处漏洞的另外两个入口）。"""
    admin = _client(db, make_user(ADMIN_ID, role="admin"))
    table_id = _import_table(admin)["table"]["id"]
    scene = _create_scene(admin, table_id)

    intruder = _client(db, make_user(OTHER_ID))
    upd = intruder.put(
        f"{BASE}/{scene['id']}",
        json={"tenant_id": TENANT, "description": "被改了"},
    )
    assert upd.status_code == 403
    assert intruder.delete(f"{BASE}/{scene['id']}", params={"tenant_id": TENANT}).status_code == 403

    # 管理员自己可以
    assert (
        admin.put(
            f"{BASE}/{scene['id']}", json={"tenant_id": TENANT, "description": "管理员改的"}
        ).status_code
        == 200
    )


def test_owner_can_edit_scene_used_by_own_agent(db) -> None:
    """自己员工正在用的场景，自己就能改 —— 否则改文案都要找管理员。"""
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)
    assert client.put(f"{BASE}/{scene['id']}", json={"tenant_id": TENANT, "icon": "🎿"}).status_code == 200


def test_duplicate_name_rejected(db) -> None:
    client = _client(db, make_user(ADMIN_ID, role="admin"))
    table_id = _import_table(client)["table"]["id"]
    _create_scene(client, table_id, name="同名")
    resp = client.post(BASE, json={"tenant_id": TENANT, "name": "同名", "tables": [table_id]})
    assert resp.status_code == 400
    assert "同名" in resp.json()["detail"]


def test_create_with_unknown_table_is_404(db) -> None:
    client = _client(db, make_user(ADMIN_ID, role="admin"))
    resp = client.post(BASE, json={"tenant_id": TENANT, "name": "空引用", "tables": ["sctable_nope"]})
    assert resp.status_code == 404


def test_delete_soft_deletes_bindings(db) -> None:
    """删场景必须连带把 binding 置为 deleted。

    硬删会留下孤儿 binding，员工档案页的计数把它算进去、点进去 404。
    """
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    assert client.delete(f"{BASE}/{scene['id']}", params={"tenant_id": TENANT}).status_code == 200

    assert db.get(Scene, scene["id"]) is None
    bindings = db.exec(
        select(AgentResourceBinding).where(AgentResourceBinding.resource_id == scene["id"])
    ).all()
    assert bindings and all(b.status == "deleted" for b in bindings)


def test_list_filters_by_agent(db) -> None:
    client = _client(db, make_user(ADMIN_ID, role="admin"))
    table_id = _import_table(client)["table"]["id"]
    bound = _create_scene(client, table_id, name="已绑定", agent_id=MEMBER_A)
    _create_scene(client, table_id, name="未绑定")

    all_scenes = client.get(BASE, params={"tenant_id": TENANT}).json()
    assert {s["name"] for s in all_scenes} == {"已绑定", "未绑定"}

    mine = client.get(BASE, params={"tenant_id": TENANT, "agent_id": MEMBER_A}).json()
    assert [s["id"] for s in mine] == [bound["id"]]

    by_agent = client.get(f"{BASE}/by-agent/{MEMBER_A}", params={"tenant_id": TENANT}).json()
    assert [s["id"] for s in by_agent] == [bound["id"]]


# ---------------------------------------------------------------------------
# 员工 ↔ 场景 绑定
# ---------------------------------------------------------------------------


def test_set_agents_overwrites_instead_of_appending(db) -> None:
    """整体覆盖：解绑的必须置 deleted，不能只增不减。"""
    db.add(make_agent("agent_second", name="第二个员工", owner_id=OWNER_ID))
    db.commit()

    client = _client(db, make_user(ADMIN_ID, role="admin"))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    resp = client.put(
        f"{BASE}/{scene['id']}/agents",
        json={"tenant_id": TENANT, "agent_ids": ["agent_second"]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["agent_ids"] == ["agent_second"]

    status = {
        b.agent_id: b.status
        for b in db.exec(
            select(AgentResourceBinding).where(AgentResourceBinding.resource_id == scene["id"])
        ).all()
    }
    assert status["agent_second"] == "active"
    assert status[MEMBER_A] == "deleted"


def test_set_agents_cannot_hijack_others_agent(db) -> None:
    """把自己的场景挂到别人员工上 → 403（否则等于强行往别人员工里塞能力）。"""
    admin = _client(db, make_user(ADMIN_ID, role="admin"))
    table_id = _import_table(admin)["table"]["id"]
    scene = _create_scene(admin, table_id)

    client = _client(db, make_user(OTHER_ID))
    resp = client.put(
        f"{BASE}/{scene['id']}/agents",
        json={"tenant_id": TENANT, "agent_ids": [MEMBER_A]},
    )
    assert resp.status_code == 403


def test_set_agents_rejects_overall_and_dispatcher(db) -> None:
    db.add(make_agent("agent_overall", name="总体", owner_id=OWNER_ID))
    overall = db.get(AgentProfile, "agent_overall")
    overall.is_overall = True
    db.add(overall)
    db.add(make_agent("agent_disp", name="调度", kind="dispatcher", owner_id=OWNER_ID))
    db.commit()

    client = _client(db, make_user(ADMIN_ID, role="admin"))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id)

    for agent_id in ("agent_overall", "agent_disp"):
        resp = client.put(
            f"{BASE}/{scene['id']}/agents",
            json={"tenant_id": TENANT, "agent_ids": [agent_id]},
        )
        assert resp.status_code == 400, (agent_id, resp.text)


# ---------------------------------------------------------------------------
# 试跑
# ---------------------------------------------------------------------------


def _run(client: TestClient, scene_id: str, slots: dict) -> dict:
    resp = client.post(
        f"{BASE}/{scene_id}/run",
        json={"tenant_id": TENANT, "slots": slots},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_run_returns_matching_rows_ranked(db) -> None:
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    body = _run(client, scene["id"], {"people": 4, "days": 5, "budget": 3000})
    assert body["empty_reason"] == ""
    contents = [h["values"]["计划内容"] for h in body["hits"]]
    # 预算正好 3000 的那条排第一
    assert contents[0] == "经典雪山五日"
    # 预算翻倍的 6000 是「近似结果」，闸门（max_score=2.0）放它进 top_k ——
    # 这是设计意图：空结果比给个偏贵的备选更糟。但它必须排在同价那条之后。
    if "深度滑雪五日" in contents:
        assert contents.index("深度滑雪五日") > contents.index("经典雪山五日")
    # 脏行（人数列写了 4天）不能因为数值同为 4 就混进结果
    assert "列写反的脏数据" not in contents
    # 2 人 / 6 人的行必须在人数这层就被排除
    assert not any("双人三日" in c or "大团七日" in c for c in contents)


def test_run_dirty_unit_row_is_dropped_at_normalize_layer(db) -> None:
    """脏行（人数列写了「4天」）在归一化层就被跳掉，并有 trace 说明。

    这是 ``_wrong_unit`` 的实际作用面，也是「4天冒充4人」唯一防得住的地方：
    ``unit_conflict`` 对「单边缺单位」是故意放行的（表单槽位是纯数字 4），
    所以匹配层防不住，只能在行侧按列期望单位判。
    """
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    body = _run(client, scene["id"], {"people": 4, "days": 4, "budget": 3000})
    contents = [h["values"]["计划内容"] for h in body["hits"]]
    assert "列写反的脏数据" not in contents

    normalize_step = next(s for s in body["steps"] if s["key"] == "normalize")
    assert "单位与列不符" in normalize_step["dropText"]
    # 5 行里正好 1 行是这样的脏数据
    assert normalize_step["to"] == 4


def test_run_without_dirty_row_hits_expected_row(db) -> None:
    """同一组条件，若表里没有脏行，本该命中的行要正常出现 ——
    证明上一条的「没命中」是脏行被排除，而不是整体算法坏了。"""
    client = _client(db, make_user(ADMIN_ID, role="admin"))
    clean = "人数,天数,预算,计划内容\n4,4,3000,干净的四日行\n"
    table_id = _import_table(client, content=clean, name="干净表")["table"]["id"]
    scene = _create_scene(client, table_id, name="干净场景")

    body = _run(client, scene["id"], {"people": 4, "days": 4, "budget": 3000})
    assert [h["values"]["计划内容"] for h in body["hits"]] == ["干净的四日行"]


def test_run_reports_why_people_layer_emptied(db) -> None:
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    body = _run(client, scene["id"], {"people": 99, "days": 5, "budget": 3000})
    assert body["hits"] == []
    assert "99" in body["empty_reason"] and "人" in body["empty_reason"]


def test_run_reports_days_layer_with_tolerance(db) -> None:
    """人数对得上但天数差太多 → 提示要带上 ±1 的容差语义。

    用户不知道系统会放过 ±1，只说「没有 5 天的方案」会让他反复试 5 和 6。
    """
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    body = _run(client, scene["id"], {"people": 2, "days": 20, "budget": 2000})
    assert body["hits"] == []
    assert "天数" in body["empty_reason"] or "±" in body["empty_reason"]


def test_run_zero_budget_does_not_crash_and_degrades_to_days(db) -> None:
    """预算非正 → 不能 500、不能 NaN，退化成「只按天数排序」并把原因写进 trace。

    注意 ``invalid_budget`` 是**降级信号**而不是「无结果」：
    预算算不了不代表这条查询失败，人数与天数照样能筛，所以 hits 可以非空。
    """
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    body = _run(client, scene["id"], {"people": 4, "days": 5, "budget": 0})
    assert body["invalid_budget"] is True
    score_step = next(s for s in body["steps"] if s["key"] == "score")
    assert "预算非正数" in score_step["detail"]
    # 不能出现 NaN 分数
    assert all(h["score"] == h["score"] for h in body["hits"])


def test_run_negative_budget_is_flagged(db) -> None:
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    body = _run(client, scene["id"], {"people": 4, "days": 5, "budget": -1})
    assert body["invalid_budget"] is True


def test_run_reports_empty_table(db) -> None:
    client = _client(db, make_user(ADMIN_ID, role="admin"))
    # 只有表头、没有数据行
    body = _import_table(client, content="人数,天数,预算\n", name="空表")
    table_id = body["table"]["id"]
    scene = _create_scene(client, table_id, name="空表场景")

    result = _run(client, scene["id"], {"people": 4, "days": 5, "budget": 3000})
    assert result["hits"] == []
    assert "没有数据" in result["empty_reason"]


def test_run_trace_is_json_serialisable(db) -> None:
    """trace 会原样塞进 JSON 列，任何不可序列化的东西都会在落库时炸。"""
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    body = _run(client, scene["id"], {"people": 4, "days": 5, "budget": 3000})
    assert body["steps"]
    for step in body["steps"]:
        assert set(step) >= {"key", "label", "from", "to"}
        assert isinstance(step["key"], str)


def test_run_persist_writes_scene_run(db) -> None:
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    resp = client.post(
        f"{BASE}/{scene['id']}/run",
        json={"tenant_id": TENANT, "slots": {"people": 4, "days": 5, "budget": 3000}, "persist": True},
    )
    assert resp.status_code == 200
    run_id = resp.json()["run_id"]
    assert run_id
    run = db.get(SceneRun, run_id)
    assert run is not None and run.scene_id == scene["id"]
    assert run.status == "ok"
    assert run.trace_json


def test_run_persist_no_match_status(db) -> None:
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    resp = client.post(
        f"{BASE}/{scene['id']}/run",
        json={"tenant_id": TENANT, "slots": {"people": 99, "days": 99, "budget": 1}, "persist": True},
    )
    run = db.get(SceneRun, resp.json()["run_id"])
    assert run is not None and run.status == "no_match"


def test_run_unknown_scene_is_404(db) -> None:
    client = _client(db, make_user(OWNER_ID))
    resp = client.post(
        f"{BASE}/scene_missing/run",
        json={"tenant_id": TENANT, "slots": {"people": 4}},
    )
    assert resp.status_code == 404


def test_run_never_leaks_other_tenant_scene(db) -> None:
    from app.db.models import Tenant

    db.add(Tenant(id="tenant_other", name="Other"))
    db.commit()
    client = _client(db, make_user(ADMIN_ID, role="admin"))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id)

    resp = client.post(
        f"{BASE}/{scene['id']}/run",
        json={"tenant_id": "tenant_other", "slots": {"people": 4}},
    )
    # 租户不匹配 → 当不存在处理，不能返回别人的数据
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# 路由注册
# ---------------------------------------------------------------------------


def test_table_index_and_row_index_are_ordered(db) -> None:
    """预览按 row_index 升序返回。顺序错了用户对账会对到错误的行。"""
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    body = client.get(f"{BASE}/tables/{table_id}", params={"tenant_id": TENANT, "limit": 3}).json()
    assert [r["row_index"] for r in body["rows"]] == [0, 1, 2]


def test_table_list_returns_imported_tables(db) -> None:
    client = _client(db, make_user(OWNER_ID))
    _import_table(client, name="表一")
    _import_table(client, name="表二")
    rows = client.get(f"{BASE}/tables", params={"tenant_id": TENANT}).json()
    assert {r["name"] for r in rows} == {"表一", "表二"}
    assert all(isinstance(r["columns"], list) for r in rows)


def test_scene_status_filter(db) -> None:
    client = _client(db, make_user(ADMIN_ID, role="admin"))
    table_id = _import_table(client)["table"]["id"]
    _create_scene(client, table_id, name="已发布")
    client.post(
        BASE,
        json={"tenant_id": TENANT, "name": "草稿", "tables": [table_id], "status": "draft"},
    )
    drafts = client.get(BASE, params={"tenant_id": TENANT, "status": "draft"}).json()
    assert [s["name"] for s in drafts] == ["草稿"]

def test_hit_values_contain_only_table_columns(db) -> None:
    """命中行的 values 必须是「纯表格行」，不能混入内部主键。

    API 层为了把数据库主键带进 matcher，会往行 dict 里塞一个内部键。
    那个键如果原样进入响应，前端会把它当成表格里真实存在的列 ——
    模板占位符校验会把它算作已知列，命中卡也会多渲染一格空列。
    """
    client = _client(db, make_user(OWNER_ID))
    table_id = _import_table(client)["table"]["id"]
    scene = _create_scene(client, table_id, agent_id=MEMBER_A)

    body = _run(client, scene["id"], {"people": 4, "days": 5, "budget": 3000})
    assert body["hits"], "前置条件：这次试跑应当有命中"
    for hit in body["hits"]:
        assert set(hit["values"]) == {"人数", "天数", "预算", "计划内容"}, (
            f"values 里混入了非表格列：{sorted(hit['values'])}"
        )
        # 主键仍然通过 row_id 单独带出，没有丢
        assert hit["row_id"]


def test_table_column_named_id_is_not_hijacked(db) -> None:
    """表里存在名为 id 的列时，它的值必须原样保留。

    这是「内部主键塞进 id 键」那个写法真正的数据面后果：
    ``{"id": 主键, **row_json}`` 会让用户填的 id 列被数据库主键覆盖，
    而且是在**静默**发生 —— 界面上看不到任何异常。
    """
    client = _client(db, make_user(OWNER_ID))
    csv = "id,人数,天数,预算,计划内容\nSKU-001,4,5,3000,经典雪山五日\nSKU-002,4,5,6000,深度滑雪五日\n"
    resp = client.post(
        f"{BASE}/tables/import",
        params={"tenant_id": TENANT},
        files={"file": ("sku.csv", csv.encode("utf-8"), "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    table_id = resp.json()["table"]["id"]

    scene = _create_scene(client, table_id, agent_id=MEMBER_A)
    body = _run(client, scene["id"], {"people": 4, "days": 5, "budget": 3000})

    assert body["hits"], "前置条件：这次试跑应当有命中"
    assert body["hits"][0]["values"]["id"] == "SKU-001", "用户填的 id 列被内部主键覆盖了"
    # 内部主键是另一套体系，不该长得像用户数据
    assert body["hits"][0]["row_id"] != "SKU-001"
