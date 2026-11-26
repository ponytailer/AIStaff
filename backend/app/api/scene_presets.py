"""场景预设 API（L2 层：开发者/超管定，普通用户只读）。

## 两个 router，故意分开

| router | 前缀 | 权限 | 谁用 |
|---|---|---|---|
| ``enterprise_router`` | ``/api/enterprise/scene-presets`` | 管理员（``ensure_tenant_admin``） | 超管配置页 |
| ``app_router`` | ``/api/enterprise/scene-presets/options`` | 登录即可 | 场景定义器的类型下拉 |

为什么不用一个接口加 ``is_admin`` 分支：定义器在员工档案里是**普通用户**打开的，
它只需要「有哪些类型可选 + 每个类型的默认值」；超管页需要「完整 JSON + 保存 +
重置」。两者的载荷和频率都不同，合成一个会让普通用户的请求也带上整份
``preset_json``（里面是超管调过的全局参数，没必要给每个人看），
也会让「定义器拉选项」这条高频路径受超管写接口的权限判定牵连。

## 出厂值 vs 库里的行

见 ``app/scenes/presets.py`` 的模块文档：库里没有就用出厂值，
**不做启动期种子**。所以本文件里没有「初始化」接口，只有 upsert / reset。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.db import get_session
from app.db.models import User
from app.scenes.presets import (
    get_preset,
    initial_scene_fields,
    list_presets_safe,
    reset_preset,
    upsert_preset,
)
from app.scenes.schema import SceneTypeLiteral
from app.security.auth import get_current_user
from app.security.permissions import ensure_tenant_admin

#: 管理端：读写预设
enterprise_router = APIRouter(
    prefix="/api/enterprise/scene-presets",
    tags=["enterprise:scene-presets"],
    dependencies=[Depends(get_current_user)],
)

#: 定义器用：只读选项（登录即可，不要求管理员）。
#:
#: 前缀刻意用**单数** `scene-preset-options`，不挂在 `scene-presets` 下面：
#: 后者已经有 `GET /{module_key}` 这条通配路由，`/scene-presets/options` 会被它
#: 抢先匹配成 `module_key="options"` 然后 404 —— 表现为「下拉永远是空的」，
#: 且日志里只有一条 404，看不出是路由顺序问题。
app_router = APIRouter(
    prefix="/api/enterprise/scene-preset-options",
    tags=["enterprise:scene-presets"],
    dependencies=[Depends(get_current_user)],
)


class ScenePresetRead(BaseModel):
    module_key: str
    display_name: str
    scene_type: str
    icon: str
    enabled: bool = True
    order_index: int = 0
    preset_json: dict[str, Any] = Field(default_factory=dict)
    updated_at: str = ""
    updated_by: str = ""


class ScenePresetUpdateRequest(BaseModel):
    """整份覆盖一条预设。

    ``preset_json`` 是**整份**（不是 patch）：超管页面编辑的就是完整 JSON，
    字段合并会让「删掉一个参数」永远删不掉（下次被旧值补回来）。
    """

    tenant_id: str
    display_name: str = ""
    scene_type: SceneTypeLiteral | None = None
    icon: str = ""
    enabled: bool = True
    order_index: int = 0
    preset_json: dict[str, Any] = Field(default_factory=dict)


class ScenePresetOption(BaseModel):
    """定义器「场景类型」下拉的一项。

    **不含 ``preset_json``**：普通用户只需要知道「有哪些可选、叫什么、
    默认值是什么」，不需要看到超管调的全局参数全貌。
    """

    module_key: str
    display_name: str
    scene_type: str
    icon: str
    #: 新建时可选的图标（下拉用）
    icons: list[str] = Field(default_factory=list)
    #: 预填的描述；用户可改
    description: str = ""


# ============================================================
# 管理端
# ============================================================


@enterprise_router.get("", response_model=list[ScenePresetRead])
def list_scene_presets(
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[ScenePresetRead]:
    """列出全部预设（含已停用的 —— 超管页要能看见并重新启用）。"""
    ensure_tenant_admin(tenant_id, current_user)
    return [ScenePresetRead(**row) for row in list_presets_safe(db)]


@enterprise_router.get("/{module_key}", response_model=ScenePresetRead)
def get_scene_preset(
    module_key: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ScenePresetRead:
    ensure_tenant_admin(tenant_id, current_user)
    row = get_preset(db, module_key)
    if row is None:
        raise HTTPException(status_code=404, detail=f"预设不存在：{module_key}")
    return ScenePresetRead(**row)


@enterprise_router.put("/{module_key}", response_model=ScenePresetRead)
def save_scene_preset(
    module_key: str,
    request: ScenePresetUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ScenePresetRead:
    """新建或整份覆盖一条预设。

    ``module_key`` 从路径取而不是 body：路径是唯一标识，两处都给会让
    「路径写 A、body 写 B」变成可表达的状态（那时存到哪个都没有正确答案）。
    """
    ensure_tenant_admin(request.tenant_id, current_user)
    _validate_module_key(module_key)
    try:
        row = upsert_preset(
            db,
            module_key=module_key,
            display_name=request.display_name,
            scene_type=str(request.scene_type or ""),
            icon=request.icon,
            enabled=request.enabled,
            preset_json=request.preset_json,
            order_index=request.order_index,
            updated_by=str(current_user.username or current_user.id or ""),
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    payload = get_preset(db, row.module_key)
    if payload is None:  # pragma: no cover - upsert 之后必然存在
        raise HTTPException(status_code=500, detail="保存后读不到预设")
    return ScenePresetRead(**payload)


@enterprise_router.post("/{module_key}/reset", response_model=ScenePresetRead)
def reset_scene_preset(
    module_key: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> ScenePresetRead:
    """丢弃库里的覆盖，回到代码里的出厂值。

    这是「改坏了怎么回滚」的唯一出口。没有它，超管把价格说明改错之后
    只能靠开发查出厂值手工填回去。
    """
    ensure_tenant_admin(tenant_id, current_user)
    row = reset_preset(db, module_key)
    if row is None:
        raise HTTPException(status_code=404, detail=f"这个 module 没有出厂预设：{module_key}")
    return ScenePresetRead(**row)


# ============================================================
# 定义器只读选项
# ============================================================


@app_router.get("", response_model=list[ScenePresetOption])
def list_scene_preset_options(
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> list[ScenePresetOption]:
    """定义器「场景类型」下拉的数据源。

    只返回 ``enabled=True`` 的：停用的预设不该出现在新建入口里。
    **存量场景不受影响** —— 它们已经存了自己的 ``module_key``，编辑时按原 key
    渲染（由 ``GET /{module_key}`` 那条取，不走这个下拉）。
    """
    if tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Tenant mismatch")
    rows = list_presets_safe(db, only_enabled=True)
    options: list[ScenePresetOption] = []
    for row in rows:
        fields = initial_scene_fields(db, str(row.get("module_key") or ""))
        options.append(
            ScenePresetOption(
                module_key=str(row.get("module_key") or ""),
                display_name=str(row.get("display_name") or row.get("module_key") or ""),
                scene_type=str(row.get("scene_type") or "table_match"),
                icon=str(row.get("icon") or ""),
                icons=[str(item) for item in fields.get("icons") or []],
                description=str(fields.get("description") or ""),
            )
        )
    return options


@app_router.get("/defaults/{module_key}")
def get_scene_preset_defaults(
    module_key: str,
    tenant_id: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """新建场景时预填用的默认值。

    返回 ``ui_config`` / ``trigger`` / ``slots`` / ``match_action`` /
    ``icons`` / ``description``。定义器用它把表单铺好，用户只需要改
    名称/图标/描述。

    与 ``/options`` 的分工：``/options`` 是「下拉里有哪些项」（轻量、列表页用），
    这里是「选了某一项之后填什么」（含槽位与匹配策略，只在打开编辑器时拉一次）。
    """
    if tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Tenant mismatch")
    fields = initial_scene_fields(db, module_key)
    if not fields.get("module_key"):
        raise HTTPException(status_code=404, detail=f"预设不存在：{module_key}")
    return fields


def _validate_module_key(module_key: str) -> None:
    """校验 ``<域>.<场景>`` 形状。复用场景模块的既有校验器，不另写一套。"""
    from app.scene_modules.constants import validate_module_key

    error = validate_module_key(str(module_key or "").strip())
    if error:
        raise HTTPException(status_code=400, detail=error)


__all__ = ["app_router", "enterprise_router"]