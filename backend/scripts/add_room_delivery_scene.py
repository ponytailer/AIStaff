"""在「仙林 AI G.O」上落地「客房送物」场景（可重复执行）。

做完四件事，每件都幂等：

1. 落 ``room.delivery_submit`` 工具（``DEMO_TOOLS`` 里新增的那个）；
2. 建 ``tool_submit`` 类型的场景，四个槽位（房间号 / 物品 / 数量 / 备注）；
3. 绑到员工 ``agent_eefcd08a8bc447e0``（仙林 AI G.O）；
4. 打印一遍实际配置，便于回头核对。

## 为什么是脚本而不是种子

``seed_demo_data`` 只在 ``init_db`` 跑，而本地库已经存在 —— 往种子函数里加
场景不会影响已有库（这正是项目「库里没有 = 用出厂值」那条约定的后果）。
一次性脚本显式、可重复、爆炸半径可见。

## 怎么跑

```bash
cd backend && .venv/bin/python scripts/add_room_delivery_scene.py
```

加 ``--dry-run`` 只看要做什么，不写库。
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlmodel import Session, select

from app.config import get_settings
from app.db.database import engine
from app.db.models import AgentResourceBinding, Scene, Tool, utc_now
from app.db.seed import ROOM_DELIVERY_SUBMIT_TOOL, _tool_config_with_base_url

TENANT = "tenant_demo"
AGENT_ID = "agent_eefcd08a8bc447e0"  # 仙林 AI G.O
SCENE_NAME = "客房送物"
MODULE_KEY = "generic.tool_submit"
TOOL_NAME = "room.delivery_submit"

#: 表单字段。`required` 决定「缺它就只发问、不调接口」。
#:
#: `quantity` 给了 `default: 1` —— 表单里会预填，用户不用为了送一瓶水
#: 专门填个数字。`note` 完全可选（「放门口」这类话对送物很有用，
#: 但强制填会让整张表变长）。
SLOTS = [
    {
        "key": "room_no",
        "label": "房间号",
        "type": "text",
        "required": True,
        "prompt": "例如 8306",
    },
    {
        "key": "item",
        "label": "需要送的物品",
        "type": "text",
        "required": True,
        "prompt": "例如 矿泉水、毛巾、牙刷",
    },
    {
        "key": "quantity",
        "label": "数量",
        "type": "number",
        "required": False,
        "default": 1,
        "unit": "件",
    },
    {
        "key": "guest_name",
        "label": "住客姓名",
        "type": "text",
        "required": False,
        "prompt": "可留空",
    },
    {
        "key": "note",
        "label": "备注",
        "type": "text",
        "required": False,
        "prompt": "例如 放门口即可",
    },
]

TOOL_API = {
    "tool_name": TOOL_NAME,
    # 正文模板：把回执最关键的三件事说成一句人话。
    # `{{order_no}}` 来自响应，`{{eta_minutes}}` 也是；房间号和物品两边都有，
    # 通道里**槽位优先**（用户填的比接口回显更可信）。
    "reply_template": (
        "已为 {{room_no}} 房提交{{item}}，受理单号 {{order_no}}，"
        "预计 {{eta_minutes}} 分钟内送达。"
    ),
    # 回执卡里「只在响应中出现」的字段的中文名。
    # 槽位里已有的（room_no / item / quantity）不用写 —— 通道会从槽位 label
    # 自动取。这里只补 `order_no` 与 `eta_minutes` 这两个纯响应字段，
    # 否则界面上会露出英文 key。
    "field_labels": {
        "order_no": "受理单号",
        "eta_minutes": "预计送达(分钟)",
    },
    "timeout_seconds": 8,
}

TRIGGER = {
    "shortcut": True,
    "shortcut_label": "客房送物",
    "keywords": ["客房送物", "送物", "送水", "送毛巾", "room service"],
    "examples": ["帮我送两瓶水到 8306", "客房送物"],
    "require_slots": True,
    # 场景直通：命中即走 channels，不进 planner（省掉一次模型路由）。
    "bypass_llm_router": True,
}

RESPOND = {
    "ask_prompt": "告诉我房间号和需要送的物品，我马上帮你安排。",
}

UI_CONFIG = {
    "schema_version": 1,
    "params": {
        "receipt_title": "客房送物已提交",
        "receipt_no_label": "受理单号",
    },
    "fallback_text": "客房送物申请已提交，稍后会有同事送达。",
    "form_title": "客房送物 · 请填写",
    "form_subtitle": "填好这几项，我立刻提交给客房部",
}

SHORTCUT = {"label": "客房送物", "icon": "🛎️"}


def ensure_tool(session: Session, *, dry_run: bool) -> Tool:
    settings = get_settings()
    payload = _tool_config_with_base_url(ROOM_DELIVERY_SUBMIT_TOOL, settings.normalized_tool_base_url)
    tool = session.exec(
        select(Tool).where(Tool.tenant_id == TENANT, Tool.name == payload["name"])
    ).first()

    if tool is None:
        print(f"  [新建] 工具 {payload['name']} → {payload['url']}")
        if dry_run:
            return Tool(tenant_id=TENANT, **payload)
        tool = Tool(tenant_id=TENANT, **payload)
        session.add(tool)
        session.commit()
        session.refresh(tool)
        return tool

    changed = []
    for key in ("display_name", "description", "bucket", "method", "url", "input_schema", "output_schema"):
        new_value = payload.get(key)
        if getattr(tool, key, None) != new_value:
            changed.append(key)
            if not dry_run:
                setattr(tool, key, new_value)
    if changed:
        print(f"  [更新] 工具 {tool.name} 字段: {', '.join(changed)}")
        if not dry_run:
            tool.updated_at = utc_now()
            session.add(tool)
            session.commit()
    else:
        print(f"  [跳过] 工具 {payload['name']} 已是最新")
    return tool


def ensure_scene(session: Session, *, dry_run: bool) -> Scene:
    scene = session.exec(
        select(Scene).where(Scene.tenant_id == TENANT, Scene.name == SCENE_NAME)
    ).first()

    fields = dict(
        description="住客提交客房送物申请（矿泉水、毛巾、拖鞋等），提交后由客房部送达。",
        icon="🛎️",
        scene_type="tool_submit",
        module_key=MODULE_KEY,
        status="published",
        trigger_json=dict(TRIGGER),
        slots_json=[dict(s) for s in SLOTS],
        respond_action_json=dict(RESPOND),
        ui_config_json=dict(UI_CONFIG),
        shortcut_json=dict(SHORTCUT),
        tool_api_json=dict(TOOL_API),
    )

    if scene is None:
        print(f"  [新建] 场景「{SCENE_NAME}」（{MODULE_KEY}）")
        if dry_run:
            return Scene(tenant_id=TENANT, name=SCENE_NAME, **fields)
        scene = Scene(tenant_id=TENANT, name=SCENE_NAME, **fields)
        session.add(scene)
        session.commit()
        session.refresh(scene)
        return scene

    changed = []
    for key, value in fields.items():
        if getattr(scene, key, None) != value:
            changed.append(key)
            if not dry_run:
                setattr(scene, key, value)
    print(f"  [更新] 场景「{SCENE_NAME}」字段: {', '.join(changed) if changed else '（无变化）'}")
    if changed and not dry_run:
        scene.updated_at = utc_now()
        session.add(scene)
        session.commit()
        session.refresh(scene)
    return scene


def ensure_binding(session: Session, scene: Scene, *, dry_run: bool) -> None:
    row = session.exec(
        select(AgentResourceBinding).where(
            AgentResourceBinding.tenant_id == TENANT,
            AgentResourceBinding.agent_id == AGENT_ID,
            AgentResourceBinding.resource_type == "scene",
            AgentResourceBinding.resource_id == scene.id,
        )
    ).first()
    if row is not None:
        if row.status != "active":
            print(f"  [更新] 绑定状态 {row.status} → active")
            if not dry_run:
                row.status = "active"
                session.add(row)
                session.commit()
        else:
            print("  [跳过] 已绑定到仙林 AI G.O")
        return
    print(f"  [新建] 绑定 → {AGENT_ID}（仙林 AI G.O）")
    if dry_run:
        return
    session.add(
        AgentResourceBinding(
            tenant_id=TENANT,
            agent_id=AGENT_ID,
            resource_type="scene",
            resource_id=scene.id,
            status="active",
        )
    )
    session.commit()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不写库")
    args = parser.parse_args()

    print(f"{'[dry-run] ' if args.dry_run else ''}落地「{SCENE_NAME}」场景")
    with Session(engine) as session:
        ensure_tool(session, dry_run=args.dry_run)
        scene = ensure_scene(session, dry_run=args.dry_run)
        ensure_binding(session, scene, dry_run=args.dry_run)

        if args.dry_run:
            print("\n[dry-run] 未写库。")
            return 0

        # 回读一遍，打印实际落库的值（而不是脚本里写的值）。
        session.refresh(scene)
        print("\n=== 落库结果 ===")
        print(f"scene_id     : {scene.id}")
        print(f"scene_type   : {scene.scene_type}")
        print(f"module_key   : {scene.module_key}")
        print(f"status       : {scene.status}")
        print(f"tool_name    : {dict(scene.tool_api_json).get('tool_name')}")
        print(f"slots        : {[s.get('key') for s in (scene.slots_json or [])]}")
        bindings = session.exec(
            select(AgentResourceBinding).where(
                AgentResourceBinding.resource_type == "scene",
                AgentResourceBinding.resource_id == scene.id,
            )
        ).all()
        print(f"bound agents : {[(b.agent_id, b.status) for b in bindings]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())