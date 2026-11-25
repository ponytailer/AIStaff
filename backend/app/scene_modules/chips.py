"""入口胶囊的查询与 ``GET /api/chat/scenes`` 路由。

**绑定即生效、解绑即消失，均不发版** —— 这条红线的唯一数据源就是这个接口
（架构文档 §5.8）。``scenes/schema.py`` 里虽然早已定义 ``AgentSceneShortcut``，
但全库零引用，本期把它真正接上。

为什么不用 ``/api/enterprise/scenes/by-agent/{id}``：
| 原因 | 说明 |
|---|---|
| 权限 | 管理 router 挂 ``Depends(get_current_user)`` + 每个端点 ``require_agent_scope_viewer``。分享访客的 ``_SHARE_SCOPE_ALLOWED_PREFIXES`` 只放行 ``/api/chat/`` 与 ``/api/public/agent-shares/``，访问不到 |
| 载荷 | 管理接口返回 trigger/slots/match_action/respond_action/shortcut 全量；聊天页只要 6 个字段。给分享页返回全量配置是信息泄漏 |
| 稳定性 | 管理接口随定义器演进，聊天页不该跟着变 |

所以这里刻意**新建** ``/api/chat/scenes``，与管理接口并存而不是替代。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from app.db import get_session
from app.db.models import AgentResourceBinding, Scene
from app.scenes.schema import SceneModuleRead
from app.security.tenant import ensure_tenant

#: 入口胶囊的响应模型 = ``SceneModuleRead``（``app/scenes/schema.py``）。
#:
#: 为什么用那个而不是在这里另起一个 ``SceneChipRead``：同一份载荷写两个
#: pydantic 模型，改字段时必然只改一处，而**两处都叫「聊天端场景」**，
#: 从代码里看不出哪个是真正在服务的那个。``SceneModuleRead`` 已在
#: schema 层（前端 OpenAPI 类型生成的来源）定义，这里直接复用它。
#:
#: 口径提醒：**刻意没有 ``on_click``** —— 入口行为由 module 的
#: ``meta.entry_behavior`` 声明（PRD §19 第 6 条），后端不持有这个事实
#: （后端没有 module 的 meta）。抄一份进 DB 会让「改了代码线上行为没变」
#: 而且两处都看不到对方。
chat_router = APIRouter(prefix="/api/chat/scenes", tags=["chat:scenes"])


def _chip_label(scene: Scene) -> str:
    """入口文案：``shortcut_json.label`` → ``trigger_json.shortcut_label`` → 场景名。

    三级回落是必要的：``trigger_json.shortcut_label`` 是 v1 的字段（
    定义器早期就写它），``shortcut_json.label`` 是 v3 的实例覆盖位。
    只读一个会让存量场景的胶囊变成空字符串。
    """
    shortcut = dict(scene.shortcut_json or {})
    label = str(shortcut.get("label") or "").strip()
    if label:
        return label
    trigger = dict(scene.trigger_json or {})
    label = str(trigger.get("shortcut_label") or "").strip()
    if label:
        return label
    return str(scene.name or "").strip()


def _chip_send_text(scene: Scene) -> str:
    """``send_text`` 行为时要发的话：``shortcut_json.message`` → 第一个关键词。"""
    shortcut = dict(scene.shortcut_json or {})
    text = str(shortcut.get("message") or "").strip()
    if text:
        return text
    trigger = dict(scene.trigger_json or {})
    keywords = [str(k).strip() for k in (trigger.get("keywords") or []) if str(k).strip()]
    return keywords[0] if keywords else ""


def _chip_icon(scene: Scene) -> str:
    return str(dict(scene.shortcut_json or {}).get("icon") or scene.icon or "").strip()


def list_scene_chips(
    db: Session,
    *,
    tenant_id: str,
    agent_id: str,
) -> list[SceneModuleRead]:
    """该员工对话页的入口胶囊。

    只返回 ``published`` + ``active`` 绑定的场景，按绑定时间升序
    （与 ``resolve_scene_hit`` 的仲裁第 2 条同源）。

    刻意**不**返回 draft / archived：draft 不该出现在对话页（PRD §9.4）。
    返回值里不含任何场景内部配置（表 id 一律不给），因为这个接口会被分享页调用。
    """
    if not tenant_id or not agent_id:
        return []

    rows = db.exec(
        select(Scene, AgentResourceBinding)
        .join(
            AgentResourceBinding,
            AgentResourceBinding.resource_id == Scene.id,  # type: ignore[arg-type]
        )
        .where(
            AgentResourceBinding.tenant_id == tenant_id,
            AgentResourceBinding.agent_id == agent_id,
            AgentResourceBinding.resource_type == "scene",
            AgentResourceBinding.status == "active",
            Scene.tenant_id == tenant_id,
            Scene.status == "published",
        )
        .order_by(AgentResourceBinding.created_at)  # type: ignore[attr-defined]
    ).all()

    chips: list[SceneModuleRead] = []
    seen: set[str] = set()
    for row in rows:
        scene = row[0]
        if scene.id in seen:
            continue
        seen.add(scene.id)
        chips.append(
            SceneModuleRead(
                scene_id=scene.id,
                module_key=str(scene.module_key or ""),
                module_version=int(scene.module_version or 1),
                label=_chip_label(scene),
                icon=_chip_icon(scene),
                send_text=_chip_send_text(scene),
                slots=[dict(slot) for slot in (scene.slots_json or []) if isinstance(slot, dict)],
                scene_name=str(scene.name or ""),
                scene_type=str(scene.scene_type or "table_match"),
            )
        )
    return chips


@chat_router.get("", response_model=list[SceneModuleRead])
def get_scene_chips(
    tenant_id: str = Query(...),
    agent_id: str = Query(...),
    db: Session = Depends(get_session),
) -> list[SceneModuleRead]:
    """聊天页入口胶囊（``GET /api/chat/scenes?tenant_id=&agent_id=``）。

    前缀必须是 ``/api/chat/``：分享访客的路径白名单只放行该前缀
    （``main.py:86-89`` 的 ``_SHARE_SCOPE_ALLOWED_PREFIXES``）。挂在
    ``/api/enterprise/`` 下会让分享页 403，且失败信息看不出根因。
    """
    ensure_tenant(db, tenant_id)
    return list_scene_chips(db, tenant_id=tenant_id, agent_id=agent_id)


__all__ = ["chat_router", "get_scene_chips", "list_scene_chips"]