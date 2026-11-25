"""场景（Scene）API。

权限沿用员工资源那一套，不另起一套判定：
- 读：``require_agent_scope_viewer``（管理员 / overall / owner / 已发布到广场 四种放行）
- 写：``_ensure_can_write``（管理员，或「这个场景挂在自己名下员工上」）

场景归属走 ``AgentResourceBinding(resource_type="scene")``，所以
「删除员工时级联清理」「从其他员工复制资源」「员工详情页资源计数」
这些能力全部复用现成的，不需要各写一遍。

v3 变化（见 docs/scenes/scene-v2-impl-map.md §1.3）：
``Scene.table_id``（单值）已删除，改成 ``SceneTable.scene_id`` 的 0..N 归属。
本文件里所有 ``table_id`` 的读写点必须**同步**改完，否则后端字段删了前端还在传、
或 ``_scene_read`` 还在读已删字段 → 直接 500。这是本次改动最易漏的连带面。

两类表路由**并存**（不是替代）：

- 租户级 ``/tables/import`` ``/tables`` ``/tables/{id}`` —— 保持原样不动。
  定义器「先传表、再建场景」的老流程与 34 处用例都走它；删掉会让它们集体 404，
  而错误信息看起来像「导入失败」，根因极难定位。
- 场景级 ``/{scene_id}/tables/*`` —— v3 新增。表归属场景、支持顺序调整与解挂。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlmodel import Session, select

from app.agents.branching import (
    ensure_private_resource_binding,
    get_agent,
    hide_open_gallery_binding,
)
from app.db import get_session
from app.db.models import (
    AgentProfile,
    AgentResourceBinding,
    Scene,
    SceneTable,
    SceneTableRow,
    User,
    utc_now,
)
from app.scene_modules.channels import (
    columns_diff,
    columns_signature,
    normalize_column,
)
from app.scene_modules.constants import (
    SCENE_TYPE_META,
    default_module_key,
    effective_needs_table,
    needs_table_of,
    table_count_issues,
    table_count_warnings,
)
from app.scene_modules.runtime import run_scene_instance
from app.scenes.schema import (
    DEFAULT_MATCH_ACTION,
    DEFAULT_TRIGGER,
    SceneColumn,
    SceneCreateRequest,
    SceneHitRead,
    SceneQualityIssue,
    SceneRead,
    SceneRunRead,
    SceneRunRequest,
    SceneTablePreview,
    SceneTablePreviewRow,
    SceneTableRead,
    SceneUpdateRequest,
)
from app.scenes.table_parser import SUPPORTED_TABLE_EXTENSIONS, parse_table
from app.security.auth import get_current_user
from app.security.permissions import (
    agent_owned_by_user,
    ensure_agent_scope_manager,
    is_admin_user,
    require_agent_scope_viewer,
)
from app.security.tenant import ensure_tenant

router = APIRouter(
    prefix="/api/enterprise/scenes",
    tags=["enterprise:scenes"],
    dependencies=[Depends(get_current_user)],
)

# 传给 matcher 的行里，用这个键挂数据库主键。
# 刻意不叫 "id"：表里可能有同名列，会被这一层覆盖掉；也刻意带双下划线前缀，
# 表示「内部字段，不对外」。响应里统一由 ``channels.hit_payload`` 剥掉。
# 保留这个别名是为了不破坏既有 import（``test_scene_api`` 等外部代码可能引用）。
ROW_ID_KEY = "__row_id__"


# ============================================================
# 序列化
# ============================================================


def _iso(value: datetime | None) -> str:
    return (value or utc_now()).isoformat()


def _table_read(row: SceneTable) -> SceneTableRead:
    return SceneTableRead(
        id=row.id,
        tenant_id=row.tenant_id,
        scene_id=str(row.scene_id or ""),
        order_index=int(row.order_index or 0),
        name=row.name,
        source_filename=row.source_filename,
        columns=[SceneColumn(**normalize_column(c)) for c in (row.columns_json or [])],
        quality=[SceneQualityIssue(**_quality_payload(q)) for q in (row.quality_json or [])],
        row_count=row.row_count,
        status=row.status,
        created_at=_iso(row.created_at),
        updated_at=_iso(row.updated_at),
    )


def _quality_payload(raw: dict[str, Any]) -> dict[str, Any]:
    level = raw.get("level")
    return {
        "level": level if level in ("error", "warning", "info") else "warning",
        "code": str(raw.get("code") or ""),
        "message": str(raw.get("message") or ""),
        "column": str(raw.get("column") or ""),
        "row_count": int(raw.get("row_count") or 0),
    }


def _agent_ids_by_scene(db: Session, tenant_id: str, scene_ids: list[str]) -> dict[str, list[str]]:
    """反查「这个场景挂在哪些员工上」。

    一次查完，不要在场景列表里逐个查——列表页 50 个场景就是 50 次查询。
    """
    if not scene_ids:
        return {}
    rows = db.exec(
        select(AgentResourceBinding).where(
            AgentResourceBinding.tenant_id == tenant_id,
            AgentResourceBinding.resource_type == "scene",
            AgentResourceBinding.resource_id.in_(scene_ids),
            AgentResourceBinding.status != "deleted",
        )
    ).all()
    out: dict[str, list[str]] = {}
    for binding in rows:
        out.setdefault(binding.resource_id, []).append(binding.agent_id)
    return out


def _table_ids_by_scene(db: Session, scene_ids: list[str]) -> dict[str, list[str]]:
    """反查「这个场景有哪些表」，按 ``order_index`` 升序。

    与 ``_agent_ids_by_scene`` 同样的理由：列表页必须一次查完。
    返回 ``scene_id → [table_id, ...]``，顺序即合并池次序——**顺序是语义**，
    不能换成 set（多表合并的行顺序会影响同分时的排序结果）。
    """
    if not scene_ids:
        return {}
    rows = db.exec(
        select(SceneTable)
        .where(SceneTable.scene_id.in_(scene_ids))
        .order_by(SceneTable.order_index, SceneTable.created_at)  # type: ignore[attr-defined]
    ).all()
    out: dict[str, list[str]] = {}
    for table in rows:
        if not table.scene_id:
            # scene_id == "" 的存量孤儿表永远不会进 ``in_(scene_ids)``
            # （除非有人传了空串进 scene_ids，这里再兜一层）
            continue
        out.setdefault(table.scene_id, []).append(table.id)
    return out


def _scene_warnings(scene: Scene, table_count: int) -> list[str]:
    """定义器侧的提示（**不阻断**，只是让前端能打角标）。

    与 ``create/update`` 里的 ``table_count_issues`` 严格互补：
    那边非空即 400，这边永不阻断。分开是为了让调用点只需判断
    「issues 是否为空」就能决定放不放行。
    """
    meta = SCENE_TYPE_META.get(str(scene.scene_type or ""), {})
    needs = effective_needs_table(meta, None)
    return table_count_warnings(needs, table_count)


def _scene_read(
    row: Scene,
    agent_ids: list[str] | None = None,
    table_ids: list[str] | None = None,
) -> SceneRead:
    """场景 → 读模型。

    ``table_ids`` 由调用方查好后传入（列表页用 ``_table_ids_by_scene`` 批量查，
    详情页查一次）。**不给默认查库**：``_scene_read`` 会被循环调用，
    在这里查库就是 N+1。
    """
    ids = list(table_ids or [])
    return SceneRead(
        id=row.id,
        tenant_id=row.tenant_id,
        name=row.name,
        description=row.description,
        icon=row.icon,
        status=row.status,
        scene_type=str(row.scene_type or "table_match"),
        module_key=str(row.module_key or ""),
        module_version=int(row.module_version or 1),
        ui_config=dict(row.ui_config_json or {}),
        module_config=dict(row.module_config_json or {}),
        table_ids=ids,
        trigger=dict(row.trigger_json or {}),
        slots=list(row.slots_json or []),
        match_action=dict(row.match_action_json or {}),
        respond_action=dict(row.respond_action_json or {}),
        shortcut=dict(row.shortcut_json or {}),
        flow=dict(row.flow_json or {}),
        handoff=dict(row.handoff_json or {}),
        scripts=list(row.scripts_json or []),
        agent_ids=agent_ids or [],
        warnings=_scene_warnings(row, len(ids)),
        created_at=_iso(row.created_at),
        updated_at=_iso(row.updated_at),
    )


# ============================================================
# 数据表（租户级：保持原样，老流程与 34 处用例都走它）
# ============================================================


def _import_table_core(
    db: Session,
    *,
    tenant_id: str,
    filename: str,
    data: bytes,
    name: str,
    scene_id: str = "",
    order_index: int = 0,
) -> SceneTablePreview:
    """解析 + 落库的公共实现。租户级与场景级导入共用，避免两份解析逻辑漂移。"""
    lower = filename.lower()
    if not any(lower.endswith(ext) for ext in SUPPORTED_TABLE_EXTENSIONS):
        raise HTTPException(
            status_code=400,
            detail=f"仅支持 {'/'.join(sorted(SUPPORTED_TABLE_EXTENSIONS))} 文件",
        )
    if not data:
        raise HTTPException(status_code=400, detail="文件内容为空")

    try:
        parsed = parse_table(filename, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        # 第三方解析库（openpyxl / csv）的异常类型不稳定，一律转成 400 而不是 500：
        # 用户传了个坏文件是客户端问题，不该让前端看到「服务器错误」。
        raise HTTPException(status_code=400, detail=f"解析失败：{exc}") from exc

    columns_payload = [c.model_dump() for c in parsed.columns]
    table = SceneTable(
        tenant_id=tenant_id,
        scene_id=scene_id,
        order_index=order_index,
        columns_signature=columns_signature(columns_payload),
        name=name.strip() or filename.rsplit(".", 1)[0],
        source_filename=filename,
        columns_json=columns_payload,
        quality_json=[q.model_dump() for q in parsed.quality],
        row_count=parsed.row_count,
        status="ready",
    )
    db.add(table)
    db.flush()

    for index, row in enumerate(parsed.rows):
        norm: dict[str, Any] = {}
        for col in parsed.columns:
            n = _normalize_for_cache(row.get(col.key))
            if n is not None:
                norm[col.key] = n
        db.add(
            SceneTableRow(
                tenant_id=tenant_id,
                table_id=table.id,
                row_index=index,
                row_json=row,
                norm_json=norm,
            )
        )

    db.commit()
    db.refresh(table)

    preview_rows = [
        SceneTablePreviewRow(row_index=i, values=parsed.rows[i])
        for i in range(min(20, len(parsed.rows)))
    ]
    return SceneTablePreview(table=_table_read(table), rows=preview_rows)


@router.post(
    "/tables/import",
    response_model=SceneTablePreview,
    dependencies=[Depends(require_agent_scope_viewer)],
)
async def import_table(
    tenant_id: str = Query(...),
    file: UploadFile = File(...),
    name: str = Query(default=""),
    db: Session = Depends(get_session),
) -> SceneTablePreview:
    """上传 xlsx/csv → 解析 → 落库 → 返回预览（含质量问题）。

    刻意把「解析」和「建表」放在一次调用里，但在响应里带上质量警告：
    用户能在同一个弹窗里看到「这列有 12 行解析不了」，然后决定是修表还是继续。
    分成两步（先解析预览、再确认入库）会需要临时存一份待确认数据，不值得。

    **不设 ``scene_id``**：这条路由属于「先建表、后建场景」的老流程，
    表是可复用资产，建场景时再通过 ``tables`` 列表认领它。
    """
    ensure_tenant(db, tenant_id)
    filename = file.filename or "upload.csv"
    data = await file.read()
    return _import_table_core(
        db, tenant_id=tenant_id, filename=filename, data=data, name=name
    )


def _normalize_for_cache(raw: Any) -> dict[str, Any] | None:
    """把归一化结果缓存成 JSON 友好的形态（排查时直接看得懂）。"""
    from app.scenes.normalize import normalize

    n = normalize(raw)
    if n is None:
        return None
    return {"num": n.num, "unit": n.unit, "raw": raw, "ok": n.ok}


@router.get("/tables", response_model=list[SceneTableRead], dependencies=[Depends(require_agent_scope_viewer)])
def list_tables(tenant_id: str = Query(...), db: Session = Depends(get_session)) -> list[SceneTableRead]:
    ensure_tenant(db, tenant_id)
    rows = db.exec(
        select(SceneTable)
        .where(SceneTable.tenant_id == tenant_id)
        .order_by(SceneTable.created_at.desc())  # type: ignore[attr-defined]
    ).all()
    return [_table_read(r) for r in rows]


@router.get(
    "/tables/{table_id}", response_model=SceneTablePreview, dependencies=[Depends(require_agent_scope_viewer)]
)
def get_table(
    table_id: str,
    tenant_id: str = Query(...),
    limit: int = Query(default=50, ge=1, le=500),
    db: Session = Depends(get_session),
) -> SceneTablePreview:
    table = _get_table(db, tenant_id, table_id)
    rows = db.exec(
        select(SceneTableRow)
        .where(SceneTableRow.table_id == table_id)
        .order_by(SceneTableRow.row_index)  # type: ignore[attr-defined]
        .limit(limit)
    ).all()
    return SceneTablePreview(
        table=_table_read(table),
        rows=[SceneTablePreviewRow(row_index=r.row_index, values=r.row_json or {}) for r in rows],
    )


def _get_table(db: Session, tenant_id: str, table_id: str) -> SceneTable:
    row = db.get(SceneTable, table_id)
    if not row or row.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Table not found")
    return row


# ============================================================
# 数据表（场景级：v3 新增）
# ============================================================


def _resolve_tables(
    db: Session, tenant_id: str, table_ids: list[str]
) -> list[SceneTable]:
    """按给定顺序取出表对象，任一不存在/跨租户 → 404。

    404 而不是 400：语义是「你引用了一个不存在的资源」，
    与 ``GET /tables/{id}`` 保持一致，前端能复用同一套错误提示。
    """
    out: list[SceneTable] = []
    seen: set[str] = set()
    for raw in table_ids:
        table_id = str(raw or "").strip()
        if not table_id or table_id in seen:
            continue
        seen.add(table_id)
        out.append(_get_table(db, tenant_id, table_id))
    return out


def _assert_isomorphic(tables: list[SceneTable]) -> None:
    """多表合并池必须共用同一套列语义（PRD §12.2）。

    不做这个校验的后果：合并池里出现「同一列名两种含义」，
    匹配结果的分数没法解释，用户对账时也看不出是哪张表错了。
    """
    if len(tables) < 2:
        return
    base = tables[0]
    base_sig = str(base.columns_signature or "") or columns_signature(base.columns_json)
    for table in tables[1:]:
        sig = str(table.columns_signature or "") or columns_signature(table.columns_json)
        if sig == base_sig:
            continue
        diffs = columns_diff(base.columns_json, table.columns_json)
        detail = "；".join(
            f"{d['column']}（{d['kind']}）" for d in diffs[:6]
        ) or "列结构不一致"
        raise HTTPException(
            status_code=400,
            detail=(
                f"表「{table.name}」与「{base.name}」的列结构不一致，不能合并：{detail}"
            ),
        )


def _check_table_count(scene_type: str, count: int) -> None:
    """表数量校验。**唯一的阻断点**。

    档位由 ``scene_type`` 决定（``optional`` / ``required`` / ``none``），
    上限 20 与类型无关。``optional`` + 0 张表返回空列表 —— 这是
    「先建场景、绑员工、后补表」这条路径能走通的原因。
    """
    issues = table_count_issues(needs_table_of(scene_type), count)
    if issues:
        raise HTTPException(status_code=400, detail=issues[0])


def _attach_tables(
    db: Session, *, tenant_id: str, scene: Scene, table_ids: list[str]
) -> list[SceneTable]:
    """把 ``table_ids`` 整体挂到场景上（整体覆盖语义）。

    三件事：
    1. 校验数量（``_check_table_count``）与存在性（``_resolve_tables``）；
    2. 校验同构（``_assert_isomorphic``）；
    3. 按列表顺序写 ``scene_id`` + ``order_index``，并**解挂**不再列表中的表。

    第 3 步的「解挂」不删表：PRD §11.3 要求「切类型后表与槽位保留但不再生效，
    切回来能恢复」。所以只把 ``scene_id`` 清成空串，表与行都留着。
    """
    tables = _resolve_tables(db, tenant_id, table_ids)
    _check_table_count(str(scene.scene_type or "table_match"), len(tables))
    _assert_isomorphic(tables)

    keep = {t.id for t in tables}
    # 先解挂：把此前属于本场景、但这次不在列表中的表摘掉
    for previous in db.exec(
        select(SceneTable).where(SceneTable.scene_id == scene.id)
    ).all():
        if previous.id not in keep:
            previous.scene_id = ""
            previous.order_index = 0
            previous.updated_at = utc_now()
            db.add(previous)

    for index, table in enumerate(tables):
        table.scene_id = scene.id
        table.order_index = index
        table.updated_at = utc_now()
        db.add(table)
    return tables


@router.post(
    "/{scene_id}/tables/import",
    response_model=SceneTablePreview,
    dependencies=[Depends(require_agent_scope_viewer)],
)
async def import_table_for_scene(
    scene_id: str,
    tenant_id: str = Query(...),
    file: UploadFile = File(...),
    name: str = Query(default=""),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SceneTablePreview:
    """在某个场景下直接上传数据表（表当场归属该场景）。

    与租户级 ``/tables/import`` 的差别只有两点：``scene_id`` 当场写上、
    以及**顺带做数量与同构校验**。后者是必要的——否则用户可以无限往一个
    ``script`` 场景塞表，或者把两张不同结构的表塞进同一个池子，
    直到试跑时才算出莫名其妙的结果。
    """
    ensure_tenant(db, tenant_id)
    scene = _get_scene(db, tenant_id, scene_id)
    _ensure_can_write(db, tenant_id, current_user, scene=scene)

    existing = db.exec(select(SceneTable).where(SceneTable.scene_id == scene.id)).all()
    _check_table_count(str(scene.scene_type or "table_match"), len(existing) + 1)

    filename = file.filename or "upload.csv"
    data = await file.read()
    preview = _import_table_core(
        db,
        tenant_id=tenant_id,
        filename=filename,
        data=data,
        name=name,
        scene_id=scene.id,
        order_index=len(existing),
    )

    # 同构校验在上传后进行：先落库才能拿到解析出的列，失败时把新表解挂，
    # 不删——用户可能只是想把它留作别处用（表是可复用资产）。
    uploaded = db.get(SceneTable, preview.table.id)
    if uploaded is not None and len(existing) >= 1:
        try:
            _assert_isomorphic([existing[0], uploaded])
        except HTTPException:
            uploaded.scene_id = ""
            uploaded.order_index = 0
            uploaded.updated_at = utc_now()
            db.add(uploaded)
            db.commit()
            raise
    return preview


@router.get(
    "/{scene_id}/tables",
    response_model=list[SceneTableRead],
    dependencies=[Depends(require_agent_scope_viewer)],
)
def list_scene_tables(
    scene_id: str, tenant_id: str = Query(...), db: Session = Depends(get_session)
) -> list[SceneTableRead]:
    """本场景的表，按 ``order_index`` 升序（顺序即合并池次序）。"""
    _get_scene(db, tenant_id, scene_id)
    rows = db.exec(
        select(SceneTable)
        .where(SceneTable.scene_id == scene_id)
        .order_by(SceneTable.order_index, SceneTable.created_at)  # type: ignore[attr-defined]
    ).all()
    return [_table_read(r) for r in rows]


@router.delete("/{scene_id}/tables/{table_id}")
def detach_scene_table(
    scene_id: str,
    table_id: str,
    tenant_id: str = Query(...),
    purge: bool = Query(default=False),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """把一张表从场景上摘下来。

    默认**只解挂不删表**（``scene_id = ""``）：表是可复用资产，
    用户可能只是想换一张，之后还会挂回来。
    ``purge=true`` 时才连行一起删——这是「我传错了要彻底清掉」的显式意图。
    """
    scene = _get_scene(db, tenant_id, scene_id)
    _ensure_can_write(db, tenant_id, current_user, scene=scene)
    table = _get_table(db, tenant_id, table_id)
    if table.scene_id != scene.id:
        raise HTTPException(status_code=404, detail="Table not found in this scene")

    if purge:
        for row in db.exec(
            select(SceneTableRow).where(SceneTableRow.table_id == table.id)
        ).all():
            db.delete(row)
        db.delete(table)
    else:
        table.scene_id = ""
        table.order_index = 0
        table.updated_at = utc_now()
        db.add(table)
    db.commit()
    return {"deleted": bool(purge), "detached": not purge, "id": table_id}


@router.put(
    "/{scene_id}/tables/order",
    response_model=list[SceneTableRead],
    dependencies=[Depends(require_agent_scope_viewer)],
)
def reorder_scene_tables(
    scene_id: str,
    payload: dict[str, Any],
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> list[SceneTableRead]:
    """调整合并池内表的顺序（整体覆盖）。

    多表合并时行顺序会参与同分排序，所以顺序是**语义**而不是展示偏好。
    要求提交的列表必须是当前表的完整排列：少给一张会让那张表掉出池子，
    而这种「悄悄少一张」从结果上完全看不出来。
    """
    tenant_id = str(payload.get("tenant_id") or "")
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required")
    ordered = [str(t) for t in (payload.get("table_ids") or [])]

    scene = _get_scene(db, tenant_id, scene_id)
    _ensure_can_write(db, tenant_id, current_user, scene=scene)

    current = db.exec(select(SceneTable).where(SceneTable.scene_id == scene.id)).all()
    current_ids = {t.id for t in current}
    if set(ordered) != current_ids:
        raise HTTPException(
            status_code=400,
            detail=(
                "table_ids 必须是当前场景全部数据表的一个完整排列"
                f"（当前 {len(current_ids)} 张，提交 {len(set(ordered))} 张）"
            ),
        )

    by_id = {t.id: t for t in current}
    for index, table_id in enumerate(ordered):
        table = by_id[table_id]
        table.order_index = index
        table.updated_at = utc_now()
        db.add(table)
    db.commit()
    return [_table_read(by_id[t]) for t in ordered]


# ============================================================
# 场景 CRUD
# ============================================================


@router.get("", response_model=list[SceneRead], dependencies=[Depends(require_agent_scope_viewer)])
def list_scenes(
    tenant_id: str = Query(...),
    agent_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_session),
) -> list[SceneRead]:
    """列表。

    ``agent_id`` 给定时只返回**绑定到该员工**的场景——这是员工档案页
    「场景」tab 的数据源。不给则返回租户全部（场景管理页）。
    """
    ensure_tenant(db, tenant_id)

    stmt = select(Scene).where(Scene.tenant_id == tenant_id)
    if status and status != "__all__":
        stmt = stmt.where(Scene.status == status)
    rows = db.exec(stmt.order_by(Scene.created_at.desc())).all()  # type: ignore[attr-defined]

    if agent_id:
        bound = set(
            db.exec(
                select(AgentResourceBinding.resource_id).where(
                    AgentResourceBinding.tenant_id == tenant_id,
                    AgentResourceBinding.agent_id == agent_id,
                    AgentResourceBinding.resource_type == "scene",
                    AgentResourceBinding.status != "deleted",
                )
            ).all()
        )
        rows = [r for r in rows if r.id in bound]

    scene_ids = [r.id for r in rows]
    agent_map = _agent_ids_by_scene(db, tenant_id, scene_ids)
    table_map = _table_ids_by_scene(db, scene_ids)
    return [
        _scene_read(r, agent_map.get(r.id, []), table_map.get(r.id, [])) for r in rows
    ]


@router.get("/{scene_id}", response_model=SceneRead, dependencies=[Depends(require_agent_scope_viewer)])
def get_scene(
    scene_id: str, tenant_id: str = Query(...), db: Session = Depends(get_session)
) -> SceneRead:
    row = _get_scene(db, tenant_id, scene_id)
    agent_map = _agent_ids_by_scene(db, tenant_id, [row.id])
    table_map = _table_ids_by_scene(db, [row.id])
    return _scene_read(row, agent_map.get(row.id, []), table_map.get(row.id, []))


@router.post("", response_model=SceneRead)
def create_scene(
    payload: SceneCreateRequest,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SceneRead:
    """新建场景。

    三处 v3 行为变化：

    1. **不再校验 ``table_id``**（字段已删）——表通过 ``payload.tables`` 传，
       数量校验走 ``needs_table`` 档位（``optional`` 允许 0 张）；
    2. **``module_key`` 留空时按 ``scene_type`` 预填** ``generic.*``，
       让「不写代码也能建场景」继续成立；
    3. **类型专属配置各写各的列**（flow / handoff / scripts），
       不塞进一个万能 config：类型切换时旧类型的配置必须保留，切回来能恢复。
    """
    ensure_tenant(db, payload.tenant_id)
    _ensure_can_write(db, payload.tenant_id, current_user, agent_id=payload.agent_id)

    # 表存在性 + 数量 + 同构，都在这里一次性校验完（在写库前）
    tables = _resolve_tables(db, payload.tenant_id, payload.tables)
    _check_table_count(payload.scene_type, len(tables))
    _assert_isomorphic(tables)

    _ensure_name_available(db, payload.tenant_id, payload.name, None)

    scene_type = str(payload.scene_type or "table_match")
    module_key = str(payload.module_key or "").strip() or default_module_key(scene_type)

    row = Scene(
        tenant_id=payload.tenant_id,
        name=payload.name.strip(),
        description=payload.description,
        icon=payload.icon,
        status=payload.status,
        scene_type=scene_type,
        module_key=module_key,
        ui_config_json=dict(payload.ui_config or {}),
        module_config_json=dict(payload.module_config or {}),
        trigger_json={**DEFAULT_TRIGGER, **(payload.trigger or {})},
        slots_json=payload.slots,
        match_action_json={**DEFAULT_MATCH_ACTION, **(payload.match_action or {})},
        respond_action_json=payload.respond_action,
        shortcut_json=payload.shortcut,
        flow_json=dict(payload.flow or {}),
        handoff_json=dict(payload.handoff or {}),
        scripts_json=list(payload.scripts or []),
    )
    db.add(row)
    db.flush()

    for index, table in enumerate(tables):
        table.scene_id = row.id
        table.order_index = index
        table.updated_at = utc_now()
        db.add(table)

    if payload.agent_id:
        ensure_private_resource_binding(db, payload.tenant_id, payload.agent_id, "scene", row.id)

    db.commit()
    db.refresh(row)
    return _scene_read(
        row,
        [payload.agent_id] if payload.agent_id else [],
        [t.id for t in tables],
    )


@router.put("/{scene_id}", response_model=SceneRead)
def update_scene(
    scene_id: str,
    payload: SceneUpdateRequest,
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SceneRead:
    """改场景。``tables`` 是整体覆盖语义（传了才动）。

    改 ``scene_type`` 时**旧类型的配置一律保留**（PRD §11.3）：
    表也保留（只是不再生效），槽位也保留。所以这里不做任何清理，
    只改 ``scene_type`` 本身。
    """
    row = _get_scene(db, payload.tenant_id, scene_id)
    _ensure_can_write(db, payload.tenant_id, current_user, scene=row)

    if payload.name is not None and payload.name.strip() != row.name:
        _ensure_name_available(db, payload.tenant_id, payload.name, row.id)
        row.name = payload.name.strip()
    if payload.description is not None:
        row.description = payload.description
    if payload.icon is not None:
        row.icon = payload.icon
    if payload.scene_type is not None:
        row.scene_type = str(payload.scene_type)
    if payload.module_key is not None:
        # 允许清空（空串 = 未装配，发布校验会拦），但非空时校验格式
        key = str(payload.module_key).strip()
        if key:
            from app.scene_modules.constants import validate_module_key

            error = validate_module_key(key)
            if error:
                raise HTTPException(status_code=400, detail=error)
        row.module_key = key
    if payload.status is not None:
        row.status = payload.status
    if payload.trigger is not None:
        row.trigger_json = {**DEFAULT_TRIGGER, **payload.trigger}
    if payload.slots is not None:
        row.slots_json = payload.slots
    if payload.match_action is not None:
        row.match_action_json = {**DEFAULT_MATCH_ACTION, **payload.match_action}
    if payload.respond_action is not None:
        row.respond_action_json = payload.respond_action
    if payload.shortcut is not None:
        row.shortcut_json = payload.shortcut
    if payload.ui_config is not None:
        row.ui_config_json = dict(payload.ui_config)
    if payload.module_config is not None:
        row.module_config_json = dict(payload.module_config)
    if payload.flow is not None:
        row.flow_json = dict(payload.flow)
    if payload.handoff is not None:
        row.handoff_json = dict(payload.handoff)
    if payload.scripts is not None:
        row.scripts_json = list(payload.scripts)

    row.updated_at = utc_now()
    db.add(row)
    db.flush()

    if payload.tables is not None:
        _attach_tables(
            db, tenant_id=payload.tenant_id, scene=row, table_ids=list(payload.tables)
        )

    db.commit()
    db.refresh(row)
    agent_map = _agent_ids_by_scene(db, payload.tenant_id, [row.id])
    table_map = _table_ids_by_scene(db, [row.id])
    return _scene_read(row, agent_map.get(row.id, []), table_map.get(row.id, []))


@router.delete("/{scene_id}")
def delete_scene(
    scene_id: str,
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """删除场景，**连带清理它私有的表与行**。

    绑定一并软删——硬删会留下孤儿 binding，让员工档案页出现
    「点进去 404」的空条目。

    表与行是真删（不是解挂）：它们是这个场景的私有资产，没有别处引用。
    留着只会让 ``scene_tables`` 里堆满 ``scene_id = ""`` 的孤儿行，
    而孤儿表永远不会被 ``load_scene_tables`` 命中，等于永久占空间且不可见。
    清理顺序必须是「行 → 表 → 绑定 → 场景」：反了会因外键/查询顺序留下残行。
    """
    row = _get_scene(db, tenant_id, scene_id)
    _ensure_can_write(db, tenant_id, current_user, scene=row)

    tables = db.exec(select(SceneTable).where(SceneTable.scene_id == scene_id)).all()
    table_ids = [t.id for t in tables]
    if table_ids:
        for table_row in db.exec(
            select(SceneTableRow).where(SceneTableRow.table_id.in_(table_ids))
        ).all():
            db.delete(table_row)
        for table in tables:
            db.delete(table)
        db.flush()

    for binding in db.exec(
        select(AgentResourceBinding).where(
            AgentResourceBinding.tenant_id == tenant_id,
            AgentResourceBinding.resource_type == "scene",
            AgentResourceBinding.resource_id == scene_id,
        )
    ).all():
        binding.status = "deleted"
        binding.updated_at = utc_now()
        db.add(binding)

    hide_open_gallery_binding(db, tenant_id, "scene", scene_id)
    db.delete(row)
    db.commit()
    return {"deleted": True, "id": scene_id, "removed_tables": len(table_ids)}


# ============================================================
# 员工 ↔ 场景 绑定
# ============================================================


@router.put("/{scene_id}/agents", response_model=SceneRead)
def set_scene_agents(
    scene_id: str,
    payload: dict[str, Any],
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> SceneRead:
    """整体覆盖：这个场景挂在哪几个员工上。

    这也是「员工档案页绑定场景」的写入入口。整体覆盖语义与
    ``PUT /agents/{id}/resources`` 一致，避免出现「加了一个忘了减另一个」。
    """
    tenant_id = str(payload.get("tenant_id") or "")
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id is required")
    agent_ids = [str(a) for a in (payload.get("agent_ids") or []) if a]

    row = _get_scene(db, tenant_id, scene_id)
    # 先校验「当前用户能不能改这个场景」——增删绑定时若只在被勾选的员工上
    # 校验，A 把自己员工的场景从别人的员工上摘掉这件事就绕过了权限。
    _ensure_can_write(db, tenant_id, current_user, scene=row)
    for agent_id in agent_ids:
        _ensure_can_manage(db, tenant_id, agent_id, current_user)

    existing = db.exec(
        select(AgentResourceBinding).where(
            AgentResourceBinding.tenant_id == tenant_id,
            AgentResourceBinding.resource_type == "scene",
            AgentResourceBinding.resource_id == scene_id,
        )
    ).all()
    by_agent = {b.agent_id: b for b in existing}

    for agent_id in agent_ids:
        if agent_id in by_agent:
            binding = by_agent[agent_id]
            if binding.status != "active":
                binding.status = "active"
                binding.updated_at = utc_now()
                db.add(binding)
        else:
            ensure_private_resource_binding(db, tenant_id, agent_id, "scene", scene_id)

    for agent_id, binding in by_agent.items():
        if agent_id not in agent_ids and binding.status != "deleted":
            binding.status = "deleted"
            binding.updated_at = utc_now()
            db.add(binding)

    db.commit()
    db.refresh(row)
    table_map = _table_ids_by_scene(db, [row.id])
    return _scene_read(row, agent_ids, table_map.get(row.id, []))


@router.get("/by-agent/{agent_id}", response_model=list[SceneRead])
def list_scenes_for_agent(
    agent_id: str, tenant_id: str = Query(...), db: Session = Depends(get_session)
) -> list[SceneRead]:
    return list_scenes(tenant_id=tenant_id, agent_id=agent_id, status=None, db=db)


# ============================================================
# 试跑
# ============================================================


@router.post("/{scene_id}/run", response_model=SceneRunRead)
def run_scene(
    scene_id: str,
    payload: SceneRunRequest,
    db: Session = Depends(get_session),
) -> SceneRunRead:
    """用给定槽位跑一次。定义器的「试跑面板」和聊天里的实际执行都走同一个入口
    （``run_scene_instance``），两者行为不漂移是 PRD 的硬要求。

    没有试跑面板，管理员调策略就是盲调。

    返回值**只加字段不改结构**：``hits`` / ``steps`` / ``empty_reason`` 被前端
    试跑面板与 11 个后端用例同时读；v3 的块走新增字段 ``ui_blocks``。
    """
    # 先做 404 判定（``run_scene_instance`` 对缺失场景只降级不抛，那是聊天链路的口径）
    _get_scene(db, payload.tenant_id, scene_id)

    action_overrides: dict[str, Any] = {}
    if payload.use_decision_model is not None:
        action_overrides["use_decision_model"] = payload.use_decision_model

    result = run_scene_instance(
        db,
        tenant_id=payload.tenant_id,
        scene_id=scene_id,
        slots=payload.slots,
        message=payload.message,
        persist=payload.persist,
        action_overrides=action_overrides or None,
    )

    detail = result.detail or {}
    hits = [_hit_read(h) for h in (detail.get("hits") or [])]
    ranked = [_hit_read(h) for h in (detail.get("ranked") or [])]
    steps = list(detail.get("steps") or result.trace or [])

    column_map: dict[str, str] = {}
    if detail.get("people_key"):
        column_map["people"] = str(detail["people_key"])
    if detail.get("days_key"):
        column_map["days"] = str(detail["days_key"])
    if detail.get("budget_key"):
        column_map["budget"] = str(detail["budget_key"])

    return SceneRunRead(
        scene_id=scene_id,
        hits=hits,
        ranked=ranked,
        steps=steps,
        total=int(detail.get("total") or 0),
        normalized_count=int(detail.get("normalized_count") or 0),
        unconvertible=int(detail.get("unconvertible") or 0),
        gate_out=int(detail.get("gate_out") or 0),
        reranked=bool(detail.get("reranked")),
        model_used=bool(detail.get("model_used")),
        invalid_budget=bool(detail.get("invalid_budget")),
        empty_reason=str(detail.get("empty_reason") or ""),
        run_id=str(result.run_id or ""),
        ui_blocks=result.to_blocks_dicts(),
        status=result.status,
        text=result.text,
        column_map=column_map,
    )


def _hit_read(payload: dict[str, Any]) -> SceneHitRead:
    """dict → ``SceneHitRead``。

    与 ``channels.hit_payload`` 配对使用：那里已经剥掉了所有 ``__`` 前缀的
    内部键，这里只做模型转换，**不重复过滤**——两处各写一遍过滤逻辑，
    迟早一处漏掉，内部键就会冒充成表格列。
    """
    return SceneHitRead(
        row_id=str(payload.get("row_id") or ""),
        values=dict(payload.get("values") or {}),
        score=float(payload.get("score") or 0.0),
        days_dev=float(payload.get("days_dev") or 0.0),
        budget_dev=float(payload.get("budget_dev") or 0.0),
        fused=payload.get("fused"),
        source_table=str(payload.get("source_table") or ""),
    )


# ============================================================
# 内部工具
# ============================================================


def _get_scene(db: Session, tenant_id: str, scene_id: str) -> Scene:
    row = db.get(Scene, scene_id)
    if not row or row.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Scene not found")
    return row


def _ensure_name_available(db: Session, tenant_id: str, name: str, exclude_id: str | None) -> None:
    existing = db.exec(
        select(Scene).where(Scene.tenant_id == tenant_id, Scene.name == name.strip())
    ).first()
    if existing and existing.id != exclude_id:
        raise HTTPException(status_code=400, detail=f"已有同名场景：{name}")


def _ensure_can_write(
    db: Session,
    tenant_id: str,
    current_user: User,
    *,
    scene: Scene | None = None,
    agent_id: str | None = None,
) -> None:
    """场景的写权限。

    **不能**只调 ``ensure_agent_scope_manager(db, tenant_id, None, user)``：
    那个函数在 ``agent_id`` 为空时直接 return，一句校验都不做。场景是
    **租户级**定义（不像 skill 有「每员工一份副本」），不绑定时根本没有
    agent_id 可传，于是这层形同虚设 —— 租户里任何成员都能改、能删别人的场景。

    这里的口径：
    - 管理员：全放行；
    - 显式指定员工：交给 owner / 管理员判定（与绑定其它资源一致）；
    - 未指定员工：只认管理员，或者「这个场景已经挂在当前用户名下的员工上」
      （自己员工在用的场景，自己能改，符合直觉且不会越权到别人）。
    """
    if is_admin_user(current_user):
        return
    if agent_id:
        ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
        return
    if scene is not None:
        owned = set(
            db.exec(
                select(AgentResourceBinding.agent_id).where(
                    AgentResourceBinding.tenant_id == tenant_id,
                    AgentResourceBinding.resource_type == "scene",
                    AgentResourceBinding.resource_id == scene.id,
                    AgentResourceBinding.status != "deleted",
                )
            ).all()
        )
        for owned_agent_id in owned:
            agent = db.get(AgentProfile, owned_agent_id)
            if agent and agent.tenant_id == tenant_id and agent_owned_by_user(agent, current_user):
                return
    raise HTTPException(
        status_code=403, detail="Only the creator or administrator can manage this scene"
    )


def _ensure_can_manage(
    db: Session, tenant_id: str, agent_id: str, current_user: User
) -> AgentProfile:
    agent = get_agent(db, tenant_id, agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent.is_overall:
        # overall 是广场宿主行，资源走全局池，不能挂私有场景
        raise HTTPException(status_code=400, detail="Overall agent uses the global resource pool")
    if agent.kind == "dispatcher":
        raise HTTPException(status_code=400, detail="Dispatcher agents cannot own scenes")
    ensure_agent_scope_manager(db, tenant_id, agent_id, current_user)
    return agent