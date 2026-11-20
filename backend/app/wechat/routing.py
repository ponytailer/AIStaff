"""微信侧员工路由：当前员工指针、斜杠指令、数字菜单。

## 切换员工时旧消息怎么处理（本模块的设计前提）

会话在 ``service`` 层按 ``(agent_id, channel, external_conv_id)`` 三元组独立建立，
所以切换员工**不删、不清、不迁移任何消息**：

- 员工 A 的会话还在，历史完整保留，用户想回去聊时切回 A 即可继续（上下文不丢）。
- 员工 B 起一个新会话，**看不到** A 的上下文——这是有意的隔离，避免把 A 的
  业务上下文（报价、客户信息）串给 B。
- 微信只有一个聊天窗口，用户看到的是同一条消息流，所以必须靠**视觉分隔**让他
  知道「上面属于谁、下面属于谁」。

## 视觉与提示契约

切换成功时发一条横幅（纯文本，iLink 无富文本能力）：

    ━━━━━━━━━━━━━━
    已切换：客服小李
    上一条消息属于「销售小王」，TA 看不到以上内容
    ━━━━━━━━━━━━━━

## 迟到的旧回复

切换发生时，旧员工那一轮可能还在跑（LLM 慢）。如果直接发出去，用户会以为
新员工在说话。因此 ``service`` 在发送回复前比对「本轮 agent == 当前指针」，
不一致就加 ``【销售小王】`` 前缀标注归属。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import timedelta
from typing import Optional

from sqlmodel import Session, select

from app.db.models import (
    AgentProfile,
    User,
    WechatBinding,
    WechatBindingAgent,
    WechatConvState,
    utc_now,
)

# 数字菜单窗口：/员工 之后这段时间内回复「1」「2」直接切换。
# 太短用户来不及选，太长会让正常提问里的数字被误判。
MENU_WINDOW_SECONDS = 300

BANNER_LINE = "━" * 14


@dataclass
class ChannelCommand:
    """解析结果。kind: list / current / help / switch / menu_pick / unbind / handoff / cancel_handoff"""

    kind: str
    query: str = ""


@dataclass
class SwitchResult:
    """切换结果：ok=是否成功；text=要发回微信的完整文本。"""

    ok: bool
    text: str
    agent_id: str = ""
    agent_name: str = ""
    previous_agent_name: str = ""


# ---- 指令解析 ------------------------------------------------------------


_MENU_PICK = re.compile(r"^(\d{1,2})$")

#: 转人工**只认斜杠指令**（2026-11-20 调整）。
#:
#: 原先裸词「转人工」也直接拦截，问题在于：它太像正常说话，「这个功能不好用，
#: 帮我转人工看看」这类提问会被整段吞掉、连数字员工都不作答；而且微信里没有
#: 命令提示，用户不知道哪些词是"有魔力"的。统一成 /转人工 后语义边界清楚，
#: 裸词交回 LLM 正常回答。
#: 取消类保留裸词兼容：老用户已经养成「取消转人工」的说法，且它不像正常提问。
BARE_CANCEL_TRIGGERS = {"取消转人工", "结束人工", "不用人工了"}


def parse_command(text: str, *, menu_active: bool = False) -> Optional[ChannelCommand]:
    """解析斜杠指令与数字菜单选择。

    ``menu_active`` 由调用方传入（菜单窗口是否有效）。只有窗口内才把纯数字
    当选择，避免用户问「3 个方案怎么选」时被误判成切换员工。
    """
    stripped = (text or "").strip()
    if not stripped:
        return None

    if menu_active:
        matched = _MENU_PICK.match(stripped)
        if matched:
            return ChannelCommand(kind="menu_pick", query=matched.group(1))

    # 取消转人工仍允许裸词：老用户习惯这个说法，且它不像正常提问。
    # 正向的 /转人工 见下方斜杠分支——只认斜杠，裸词「转人工」交给 LLM 正常作答。
    if stripped in BARE_CANCEL_TRIGGERS:
        return ChannelCommand(kind="cancel_handoff")

    if not stripped.startswith("/"):
        return None

    body = stripped[1:].strip()
    lowered = body.lower()
    if lowered in {"员工", "list", "员工列表"}:
        return ChannelCommand(kind="list")
    if lowered in {"当前", "目前"}:
        return ChannelCommand(kind="current")
    if lowered in {"帮助", "?", "？", "help"}:
        return ChannelCommand(kind="help")
    if lowered in {"解绑", "unbind"}:
        return ChannelCommand(kind="unbind")
    # 转人工：用户明确要求真人介入时不再走 LLM
    if lowered in {"转人工", "人工", "人工客服", "handoff", "human"}:
        return ChannelCommand(kind="handoff")
    if lowered in {"取消转人工", "结束人工", "cancel_handoff"}:
        return ChannelCommand(kind="cancel_handoff")
    if lowered.startswith("切换"):
        return ChannelCommand(kind="switch", query=body[len("切换"):].strip())
    # /<名字> 直达
    if body and " " not in body and "\n" not in body:
        return ChannelCommand(kind="switch", query=body)
    return ChannelCommand(kind="help")


def help_text() -> str:
    return (
        "可用指令：\n"
        "/员工 查看可对话的员工（也可回数字直接切换）\n"
        "/切换 <名字> 切换到指定员工\n"
        "/当前 查看当前正在对话的员工\n"
        "/解绑 解除微信账号与 StaffDeck 账号的绑定\n"
        "/转人工 找真人同事接手当前对话\n"
        "/帮助 查看本说明"
    )


# ---- 挂载集 --------------------------------------------------------------


def mounted_agents(
    db: Session,
    binding: WechatBinding,
    *,
    user: Optional[User] = None,
) -> list[WechatBindingAgent]:
    """这个微信对话里能使用的员工。

    ## 语义（2026-11-19 修正）

    **每个人自己的微信、自己决定跟哪些员工对话。** 所以可见性看的是
    「发消息的这个人」的权限，而不是「租户级共享列表」——后者会让李四在
    微信里看到张三名下的私有员工，语义错位、也是越权。

    ``user`` 是发消息者在 StaffDeck 的身份（已绑定时是实名账号，未绑定时是
    渠道懒建账号）。传 None 时退回 bot 主人，保证旧调用路径不会突然空掉。

    两段式：
    1. 优先级最高——他在页面上显式勾选的员工（``WechatBindingAgent`` 行），
       勾选时已按同一套可见性校验过，这里只过滤存活状态。
       注意勾选行是**按 binding 存的**，同事共用 bot 时会共享这份勾选——
       因此仍要在下面用「他自己的可见集」做一次交集，不能直接信它。
    2. 没有勾选行时**不是报错，而是给他「他有权限的全部员工」**：新接入的
       微信立刻可用，不依赖用户先去配一遍。
    """
    if user is not None and user.source == "web":
        visible = set(visible_agent_ids_for(db, binding.tenant_id, user.id))
    elif user is not None:
        # 未绑定的微信用户（source='wechat' 懒建账号）：不继承 bot 主人的权限，
        # 只给广场上公开发布的——那本来就是「给所有人用」的员工。
        visible = set(
            visible_agent_ids_for(db, binding.tenant_id, None)
        )
    else:
        # 没传 user 的旧调用路径：按 bot 主人的权限，保持向后兼容
        visible = set(visible_agent_ids_for(db, binding.tenant_id, binding.owner_user_id))

    rows = list(
        db.exec(
            select(WechatBindingAgent)
            .where(WechatBindingAgent.binding_id == binding.id)
            .order_by(WechatBindingAgent.sort_order, WechatBindingAgent.created_at)
        ).all()
    )
    if rows:
        alive = _alive_agent_ids(db, binding.tenant_id, [row.agent_id for row in rows])
        kept = [row for row in rows if row.agent_id in alive and row.agent_id in visible]
        if kept:
            return kept

    ids = list(visible)
    if not ids:
        return []
    # 保持「最近更新优先」的顺序，取第一个做默认员工
    return [
        WechatBindingAgent(
            tenant_id=binding.tenant_id,
            binding_id=binding.id,
            agent_id=agent_id,
            is_default=(index == 0),
            sort_order=index,
        )
        for index, agent_id in enumerate(ids)
    ]


def _visible_agent_ids(db: Session, binding: WechatBinding) -> list[str]:
    return visible_agent_ids_for(db, binding.tenant_id, binding.owner_user_id)


def visible_agent_ids_for(db: Session, tenant_id: str, owner_user_id: Optional[str]) -> list[str]:
    """某个用户在微信侧可用（≈网页端可见）的员工 id。

    **两条调用链共用这一个口径**：
    - ``mounted_agents`` 在用户还没勾选时用它算默认集；
    - ``PUT /bindings/{id}/agents`` 用它校验勾选是否越权。
    分成两份实现就会漂移成「网页看得到、微信挂不上」或更糟的越权。

    权限与 ``app.api.agents._agent_visible_to_user`` 同一口径：管理员看全部，
    其他人看「自己 owner 的 + 已发布到广场的」，隐藏员工排除；
    ``is_overall`` 是租户兜底入口，不是具体员工，不参与微信对话。
    """
    owner = db.get(User, owner_user_id) if owner_user_id else None
    rows = db.exec(
        select(AgentProfile)
        .where(
            AgentProfile.tenant_id == tenant_id,
            AgentProfile.status == "active",
            AgentProfile.is_overall.is_(False),
        )
        .order_by(AgentProfile.updated_at.desc())
    ).all()

    if owner is None:
        # 找不到 owner（历史数据/被删号）：保守只给广场发布的，不放行私有员工
        return [row.id for row in rows if not _hidden(row) and _published(row)]
    if owner.role == "admin":
        return [row.id for row in rows if not _hidden(row)]
    return [
        row.id
        for row in rows
        if not _hidden(row) and (_owned_by(row, owner) or _published(row))
    ]


def _hidden(row: AgentProfile) -> bool:
    return (row.metadata_json or {}).get("hidden_from_staffdeck") is True


def _published(row: AgentProfile) -> bool:
    return (row.metadata_json or {}).get("published_to_gallery") is True


def _owned_by(row: AgentProfile, user: User) -> bool:
    metadata = row.metadata_json or {}
    for key in ("owner_user_id", "created_by_user_id", "creator_user_id", "owner_id"):
        if str(metadata.get(key) or "").strip() == user.id:
            return True
    return str(metadata.get("created_by") or "").strip() == user.username


def _alive_agent_ids(db: Session, tenant_id: str, agent_ids: list[str]) -> set[str]:
    if not agent_ids:
        return set()
    rows = db.exec(
        select(AgentProfile.id).where(
            AgentProfile.tenant_id == tenant_id,
            AgentProfile.id.in_(agent_ids),
            AgentProfile.status == "active",
        )
    ).all()
    return {row for row in rows}


def agent_names(db: Session, tenant_id: str, agent_ids: list[str]) -> dict[str, str]:
    if not agent_ids:
        return {}
    rows = db.exec(
        select(AgentProfile).where(
            AgentProfile.tenant_id == tenant_id,
            AgentProfile.id.in_(agent_ids),
        )
    ).all()
    return {row.id: row.name for row in rows}


def default_agent_id(mounts: list[WechatBindingAgent]) -> str:
    for mount in mounts:
        if mount.is_default:
            return mount.agent_id
    return mounts[0].agent_id if mounts else ""


# ---- 会话指针 ------------------------------------------------------------


def get_conv_state(db: Session, binding: WechatBinding, external_conv_id: str) -> Optional[WechatConvState]:
    return db.exec(
        select(WechatConvState).where(
            WechatConvState.binding_id == binding.id,
            WechatConvState.external_conv_id == external_conv_id,
        )
    ).first()


def resolve_current_agent(
    db: Session,
    binding: WechatBinding,
    external_conv_id: str,
    *,
    user: Optional[User] = None,
) -> tuple[str, bool]:
    """返回 (当前员工 id, 是否发生了重置)。

    无指针 → 建指针=默认员工；指针员工已不在挂载集（被移除/停用/删除）
    → 重置为默认并标记，让调用方补一条提示，避免用户以为还在跟原员工聊。
    """
    mounts = mounted_agents(db, binding, user=user)
    if not mounts:
        return "", False
    fallback = default_agent_id(mounts)
    state = get_conv_state(db, binding, external_conv_id)
    if state is None:
        state = WechatConvState(
            tenant_id=binding.tenant_id,
            binding_id=binding.id,
            external_conv_id=external_conv_id,
            current_agent_id=fallback,
        )
        db.add(state)
        db.flush()
        return fallback, False
    mounted_ids = {mount.agent_id for mount in mounts}
    if state.current_agent_id not in mounted_ids:
        state.current_agent_id = fallback
        state.routing_revision += 1
        state.updated_at = utc_now()
        db.add(state)
        db.flush()
        return fallback, True
    return state.current_agent_id, False


def set_current_agent(
    db: Session,
    binding: WechatBinding,
    external_conv_id: str,
    agent_id: str,
    *,
    clear_menu: bool = True,
) -> int:
    """写指针并返回新的 revision（服务端用它做迟到回复的归属判定）。"""
    state = get_conv_state(db, binding, external_conv_id)
    if state is None:
        state = WechatConvState(
            tenant_id=binding.tenant_id,
            binding_id=binding.id,
            external_conv_id=external_conv_id,
            current_agent_id=agent_id,
        )
    else:
        state.current_agent_id = agent_id
        state.routing_revision += 1
        state.updated_at = utc_now()
    if clear_menu:
        state.menu_agents_json = []
        state.menu_expires_at = None
    db.add(state)
    db.flush()
    return state.routing_revision


def menu_agent_ids(db: Session, binding: WechatBinding, external_conv_id: str) -> list[str]:
    """当前有效的菜单编号列表；窗口过期返回空列表。"""
    state = get_conv_state(db, binding, external_conv_id)
    if state is None or not state.menu_expires_at:
        return []
    if state.menu_expires_at <= utc_now():
        return []
    return list(state.menu_agents_json or [])


def store_menu(
    db: Session,
    binding: WechatBinding,
    external_conv_id: str,
    agent_ids: list[str],
) -> None:
    state = get_conv_state(db, binding, external_conv_id)
    if state is None:
        return
    state.menu_agents_json = list(agent_ids)
    state.menu_expires_at = utc_now() + timedelta(seconds=MENU_WINDOW_SECONDS)
    state.updated_at = utc_now()
    db.add(state)
    db.flush()


# ---- 指令执行 ------------------------------------------------------------


def switch_banner(target_name: str, previous_name: str) -> str:
    """切换横幅：一行视觉分隔 + 归属说明，让用户分清上下两段对话属于谁。"""
    lines = [BANNER_LINE, f"已切换：{target_name}"]
    if previous_name and previous_name != target_name:
        lines.append(f"以上消息属于「{previous_name}」，TA 看不到这些内容")
    lines.append("对话上下文各自独立，切回原员工可继续之前的对话")
    lines.append(BANNER_LINE)
    return "\n".join(lines)


def run_command(
    db: Session,
    binding: WechatBinding,
    external_conv_id: str,
    cmd: ChannelCommand,
    *,
    user: Optional[User] = None,
) -> str:
    """执行指令并返回要发回的文本。"""
    mounts = mounted_agents(db, binding, user=user)
    names = agent_names(db, binding.tenant_id, [mount.agent_id for mount in mounts])
    current_id, _ = resolve_current_agent(db, binding, external_conv_id, user=user)

    if cmd.kind == "list":
        return _render_list(db, binding, external_conv_id, mounts, names, current_id)

    if cmd.kind == "current":
        if not current_id:
            return "当前没有可对话的员工，请联系管理员在 StaffDeck 里配置。"
        return f"当前员工：「{names.get(current_id) or current_id}」。输入 /员工 查看可切换列表。"

    if cmd.kind == "menu_pick":
        try:
            index = int(cmd.query)
        except ValueError:
            return "请回复列表里的数字，或输入 /员工 重新查看。"
        menu_ids = menu_agent_ids(db, binding, external_conv_id)
        if not (1 <= index <= len(menu_ids)):
            return "编号已失效，输入 /员工 重新查看可切换的员工。"
        return _do_switch(db, binding, external_conv_id, menu_ids[index - 1], mounts, names, current_id)

    if cmd.kind == "switch":
        if not cmd.query:
            return "用法：/切换 <员工名字>。输入 /员工 查看可切换列表。"
        lowered = cmd.query.casefold()
        target = next(
            (m for m in mounts if (names.get(m.agent_id) or "").casefold() == lowered),
            None,
        )
        if target is None:
            # 允许唯一前缀匹配，减少用户记不全名字的摩擦
            candidates = [
                m for m in mounts if (names.get(m.agent_id) or "").casefold().startswith(lowered)
            ]
            if len(candidates) == 1:
                target = candidates[0]
        if target is None:
            return f"没有找到员工「{cmd.query}」。输入 /员工 查看可切换列表。"
        return _do_switch(db, binding, external_conv_id, target.agent_id, mounts, names, current_id)

    return help_text()


def _do_switch(
    db: Session,
    binding: WechatBinding,
    external_conv_id: str,
    target_agent_id: str,
    mounts: list[WechatBindingAgent],
    names: dict[str, str],
    current_id: str,
) -> str:
    target_name = names.get(target_agent_id) or target_agent_id
    if target_agent_id == current_id:
        return f"当前已经是「{target_name}」，直接发消息即可。\n输入 /员工 查看其他员工。"
    previous_name = names.get(current_id) or current_id
    set_current_agent(db, binding, external_conv_id, target_agent_id)
    return switch_banner(target_name, previous_name)


def _render_list(
    db: Session,
    binding: WechatBinding,
    external_conv_id: str,
    mounts: list[WechatBindingAgent],
    names: dict[str, str],
    current_id: str,
) -> str:
    if not mounts:
        return "当前没有可对话的员工，请联系管理员在 StaffDeck 里配置。"
    lines = ["可对话员工（回复数字即可切换）："]
    ids: list[str] = []
    for index, mount in enumerate(mounts, start=1):
        ids.append(mount.agent_id)
        marks: list[str] = []
        if mount.agent_id == current_id:
            marks.append("当前")
        elif mount.is_default:
            marks.append("默认")
        suffix = f" ← {'/'.join(marks)}" if marks else ""
        lines.append(f"{index}. {names.get(mount.agent_id) or mount.agent_id}{suffix}")
    lines.append(f"直接回复 1-{len(mounts)} 切换，{MENU_WINDOW_SECONDS // 60} 分钟内有效。")
    store_menu(db, binding, external_conv_id, ids)
    return "\n".join(lines)