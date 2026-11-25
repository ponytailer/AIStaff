"""场景运行时：意图匹配 → 分派 → 组装块 → 唯一执行入口。

只有 4 个公开函数（arch §2.1）：``resolve_scene_hit`` / ``dispatch_scene`` /
``build_ui_blocks`` / ``run_scene_instance``，外加一个同族的
``_scene_shortcircuit_plan``（与 ``_faq_shortcircuit_plan`` /
``_handoff_shortcircuit_plan`` 命名一致：三者都是「零 LLM 合成 TurnPlan」）。

依赖方向（arch §6.1.1，这是硬约束）：
``api/scenes.py`` → ``scene_modules.runtime`` → ``scene_modules.channels``
``scene_modules.channels`` 只 import ``db.models`` 与 ``app.scenes.*``（纯库），
**绝不反向 import ``api.scenes``**——那会形成同层双节点循环，并让
``core/engine/turn_run.py`` 的调用链在运行期拉起一个 HTTP 路由模块。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable

from sqlmodel import Session, select

from app.db.models import AgentResourceBinding, Scene
from app.scene_modules.channels import (
    _run_handoff,
    _run_script,
    _run_sop_flow,
    _run_table_match,
)
from app.scene_modules.constants import SCENE_TYPE_META
from app.scene_modules.types import SceneRunResult, SceneUiBlock

if TYPE_CHECKING:
    from app.session.session_schema import TurnPlan

#: 未知 scene_type 的降级话术。**必须是一条 text block 而不是异常**：
#: 用户在对话里要能看到原因，而不是白屏或 500（arch §5.7）。
UNSUPPORTED_TYPE_TEXT = "这个场景的类型暂不支持。"

#: 多命中仲裁的 trace 键（统一前缀，便于在 trace 面板里过滤）
TRACE_ARBITRATION = "scene_arbitration"


# ============================================================
# 意图层
# ============================================================


def _bound_published_scenes(
    db: Session,
    *,
    tenant_id: str,
    agent_id: str,
) -> list[tuple[Scene, AgentResourceBinding]]:
    """该员工**绑定且已发布**的场景，一次查完（不要 N+1）。

    返回 ``(scene, binding)`` 而不是只有 scene：仲裁第 2 条要按
    ``binding.created_at`` 升序，绑定时序是候选集的一部分。

    SQL 层就把 ``status = "published"`` 与 ``binding.status = "active"``
    过滤掉，所以「绑了但草稿」「解绑后」这两种情况在运行时**天然不出现**，
    不需要额外的 if（arch §5.7 的「未匹配时优雅落回」就是靠这个）。
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
    ).all()
    return [(row[0], row[1]) for row in rows]


def _scene_keywords(scene: Scene) -> list[str]:
    """实例的触发关键词（``trigger_json.keywords``）。口语化清洗后去重。"""
    trigger = dict(scene.trigger_json or {})
    raw = trigger.get("keywords") or []
    out: list[str] = []
    for item in raw:
        text = " ".join(str(item or "").split()).strip()
        if text and text not in out:
            out.append(text)
    return out


def resolve_scene_hit(
    db: Session,
    *,
    tenant_id: str,
    agent_id: str,
    message: str,
    forced_scene_id: str | None = None,
    on_trace: Callable[[str, dict[str, Any]], None] | None = None,
) -> Scene | None:
    """意图层：这句话该不该进场景，进哪个。

    三条规则（arch §5.5，P0 只做确定性匹配，不做 LLM 语义路由）：

    1. ``forced_scene_id`` 存在 → 直接用它，但**必须校验它在候选集内**。
       否则解绑后的旧请求、或伪造的 scene_id 仍能触发场景；不在候选集就
       返回 ``None`` 落回普通对话（**不抛异常**）。
    2. 关键词子串匹配（复用 FAQ 的「任意 1 词命中即算」口径）。
    3. 多命中仲裁三条按序：最长命中关键词 → 绑定更早 → module_key 字典序小。

    每次都 trace 全部候选，否则「为什么是 A 不是 B」永远查不清。
    """
    candidates = _bound_published_scenes(db, tenant_id=tenant_id, agent_id=agent_id)
    if not candidates:
        return None

    forced = str(forced_scene_id or "").strip()
    if forced:
        for scene, _binding in candidates:
            if scene.id == forced:
                if on_trace is not None:
                    on_trace(
                        f"场景：按指定进入「{scene.name}」",
                        {"scene_id": scene.id, "reason": "forced", "candidates": len(candidates)},
                    )
                return scene
        # 未命中候选集：可能是解绑后的旧请求，也可能是伪造。
        # 静默落回普通对话——报错会让用户以为产品坏了。
        if on_trace is not None:
            on_trace(
                "场景：指定场景已不在可用范围，回落普通对话",
                {"scene_id": forced, "reason": "forced_outside_binding"},
            )
        return None

    text = " ".join(str(message or "").split()).strip()
    if not text:
        return None
    lowered = text.lower()

    matched: list[tuple[int, Any, Scene, AgentResourceBinding, list[str]]] = []
    for scene, binding in candidates:
        hits = [kw for kw in _scene_keywords(scene) if kw.lower() in lowered]
        if not hits:
            continue
        longest = max(len(kw) for kw in hits)
        matched.append((longest, binding.created_at, scene, binding, hits))

    if not matched:
        return None

    # 仲裁：① 最长命中关键词 ② 绑定更早 ③ module_key 字典序小（保证可复现）
    matched.sort(
        key=lambda item: (
            -item[0],
            item[1] or 0,
            str(item[2].module_key or ""),
        )
    )
    longest, _created, winner, _binding, winner_hits = matched[0]

    if on_trace is not None:
        on_trace(
            f"场景：命中「{winner.name}」（关键词：{'、'.join(winner_hits)}）",
            {
                "scene_id": winner.id,
                "reason": "keyword",
                "hit_keywords": winner_hits,
                "longest_keyword_len": longest,
                "candidates": [
                    {
                        "scene_id": item[2].id,
                        "name": item[2].name,
                        "module_key": item[2].module_key,
                        "hit_keywords": item[4],
                        "longest_keyword_len": item[0],
                    }
                    for item in matched
                ],
            },
        )
    return winner


# ============================================================
# 分派
# ============================================================


def dispatch_scene(
    db: Session,
    *,
    scene: Scene,
    slots: dict[str, Any],
    message: str,
    session_id: str = "",
    user_id: str | None = None,
    persist: bool = True,
    action_overrides: dict[str, Any] | None = None,
) -> SceneRunResult:
    """按 ``scene_type`` 分派到 channels 里的 4 个函数之一。

    用 ``match`` 不用 ``dict[str, Callable]`` 注册表：已知 4 个常量分支时
    ``match`` 能让类型检查器做穷尽性提醒；dict 查表会把「少注册一个」变成
    运行期 ``KeyError``（arch §2.5）。

    **未知类型不抛异常**：降级成一条 ``text`` block 说明原因，
    ``status = "error"``，让用户在对话里看到原因而不是白屏。
    """
    scene_type = str(getattr(scene, "scene_type", "") or "")

    match scene_type:
        case "table_match":
            return _run_table_match(
                db,
                scene=scene,
                slots=slots,
                message=message,
                session_id=session_id,
                user_id=user_id,
                persist=persist,
                action_overrides=action_overrides,
            )
        case "sop_flow":
            return _run_sop_flow(
                db,
                scene=scene,
                slots=slots,
                message=message,
                session_id=session_id,
                user_id=user_id,
                persist=persist,
                action_overrides=action_overrides,
            )
        case "handoff":
            return _run_handoff(
                db,
                scene=scene,
                slots=slots,
                message=message,
                session_id=session_id,
                user_id=user_id,
                persist=persist,
                action_overrides=action_overrides,
            )
        case "script":
            return _run_script(
                db,
                scene=scene,
                slots=slots,
                message=message,
                session_id=session_id,
                user_id=user_id,
                persist=persist,
                action_overrides=action_overrides,
            )
        case _:
            label = SCENE_TYPE_META.get(scene_type, {}).get("label") or scene_type or "未知"
            return SceneRunResult(
                blocks=[
                    SceneUiBlock(
                        kind="text",
                        data={"content": f"{UNSUPPORTED_TYPE_TEXT}（类型：{label}）"},
                    )
                ],
                text=UNSUPPORTED_TYPE_TEXT,
                trace=[
                    {
                        "key": "dispatch",
                        "scene_type": scene_type,
                        "supported": list(SCENE_TYPE_META.keys()),
                    }
                ],
                status="error",
            )


# ============================================================
# 块组装
# ============================================================


def _scene_fallback_text(scene: Scene) -> str:
    """场景级兜底文本。

    所有渠道的基线，不是某个 module 的私有参数：
    非 UI 渠道（企微/微信/短信）只吃文本，module 加载失败时也靠它。
    缺它的后果是「在微信用户那里变成空白消息」——最难发现的一类线上 bug，
    因为开发和测试都在 Web 端。所以发布校验把它列为阻断项。
    """
    ui_config = dict(scene.ui_config_json or {})
    return str(ui_config.get("fallback_text") or "").strip()


def build_ui_blocks(scene: Scene, result: SceneRunResult) -> list[SceneUiBlock]:
    """给每个 block 补 ``module_key`` / ``module_version`` / ``fallback_text``。

    补的是「这块归谁画」与「画不出来时说什么」，**不碰 ``kind`` / ``data``**。
    block 上已有非空值时保留（block 级覆盖优先于场景级）。
    """
    module_key = str(scene.module_key or "")
    module_version = int(scene.module_version or 0)
    scene_fallback = _scene_fallback_text(scene)

    blocks: list[SceneUiBlock] = []
    for block in result.blocks:
        block.module_key = block.module_key or module_key
        block.module_version = block.module_version or module_version
        if not block.fallback_text:
            # block 级兜底：优先该块自己的正文，其次场景级 fallback_text，
            # 最后才用「无法显示」。中间那档是硬要求——回退到「无法显示」
            # 会让「配置了 fallback_text 却看不到」变成静默 bug。
            block_text = str((block.data or {}).get("content") or "").strip()
            block.fallback_text = block_text or scene_fallback or "这个结果无法显示。"
        blocks.append(block)
    return blocks


def _persist_run(
    db: Session,
    *,
    scene: Scene,
    slots: dict[str, Any],
    result: SceneRunResult,
    session_id: str = "",
    user_id: str | None = None,
) -> str:
    """落一条 ``SceneRun``。「为什么这次没推荐出东西」全靠它 + trace。"""
    from app.db.models import SceneRun

    detail = result.detail or {}
    run = SceneRun(
        tenant_id=scene.tenant_id,
        scene_id=scene.id,
        module_key=str(scene.module_key or ""),
        session_id=session_id,
        user_id=user_id or "",
        input_json=dict(slots or {}),
        result_json={
            "status": result.status,
            "text": result.text,
            "hit_total": detail.get("total", 0),
            "hit_count": len(detail.get("hits") or []),
            "blocks": [
                {"kind": b.kind, "module_key": b.module_key} for b in result.blocks
            ],
        },
        trace_json=list(result.trace or []),
        status=result.status if result.status in ("ok", "no_match", "error") else "ok",
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run.id


def run_scene_instance(
    db: Session,
    *,
    tenant_id: str,
    scene_id: str,
    slots: dict[str, Any] | None = None,
    message: str = "",
    persist: bool = False,
    session_id: str = "",
    user_id: str | None = None,
    action_overrides: dict[str, Any] | None = None,
) -> SceneRunResult:
    """试跑面板与聊天执行**共用的唯一入口**（PRD 要求两者不漂移）。

    两条入口只是 ``persist`` / ``session_id`` 不同：
    - 试跑面板：``persist=False``（默认），不写 ``SceneRun``、不建工单；
    - 聊天执行：``persist=True`` + ``session_id``，写 ``SceneRun`` 并允许建单。

    找不到场景（已删/租户不匹配）时返回一条 ``error`` 结果而**不是抛异常**：
    调用方（``/run`` 路由）自己做 404 判定，聊天链路则应当降级而不是崩。
    """
    from app.db.models import utc_now

    scene = db.get(Scene, str(scene_id or ""))
    if scene is None or scene.tenant_id != tenant_id:
        return SceneRunResult(
            blocks=[SceneUiBlock(kind="text", data={"content": "这个场景已不存在。"})],
            text="这个场景已不存在。",
            trace=[{"key": "load_scene", "scene_id": scene_id, "found": False}],
            status="error",
        )

    # 空模块装配的场景不该静默跑：明确告诉调用方「没装配」，而不是产一堆无主 block
    if not str(scene.module_key or "").strip():
        result = dispatch_scene(
            db,
            scene=scene,
            slots=dict(slots or {}),
            message=message,
            session_id=session_id,
            user_id=user_id,
            persist=False,
            action_overrides=action_overrides,
        )
        result.blocks = build_ui_blocks(scene, result)
        result.trace.append(
            {"key": "module_key", "value": "", "detail": "场景未装配 module_key"}
        )
        # 未装配时不写运行记录：这类失败是配置问题，写进去只会污染命中率统计
        return result

    result = dispatch_scene(
        db,
        scene=scene,
        slots=dict(slots or {}),
        message=message,
        session_id=session_id,
        user_id=user_id,
        persist=persist,
        action_overrides=action_overrides,
    )
    result.blocks = build_ui_blocks(scene, result)

    if persist:
        result.run_id = _persist_run(
            db,
            scene=scene,
            slots=dict(slots or {}),
            result=result,
            session_id=session_id,
            user_id=user_id,
        )
        scene.updated_at = utc_now()
        db.add(scene)
        db.commit()

    return result


# ============================================================
# 短路计划（与 _faq_shortcircuit_plan / _handoff_shortcircuit_plan 同族）
# ============================================================


def _scene_shortcircuit_plan(
    db: Session,
    session: Any,
    message: str,
    request: Any,
    *,
    on_trace: Callable[[str, dict[str, Any]], None] | None = None,
) -> "TurnPlan | None":
    """场景命中即合成一个 ``scene_module`` 帧的计划；未命中返回 ``None``。

    **返回 None 时后续逻辑零改动**（FAQ → 缓存 → planner → 普通对话）——
    这是「未匹配时优雅落回」的实现方式：不写任何 fallback 分支，
    靠「返回 None 就不介入」（arch §5.1）。

    守卫（与 FAQ / handoff 同源，逐条都不能少）：
    - 只在 ``interaction_mode = normal`` 时介入；
    - 会话没有活跃 SOP / 待处理任务 / 待补槽 —— 那些上下文里「这句话」可能是
      SOP 节点内的回答，抢过来会让流程断在半路；
    - 场景是管理员定制的能力，**不进**已有 blocking 帧轮次。

    ⚠️ 决策 5（arch §10）：场景命中后同轮禁止 SOP 帧。所以这里产的计划
    只有一个 conversation 帧，不会带任何 sop 帧。
    """
    from app.session.session_schema import PlannedTaskFrame, TurnPlan

    interaction_mode = str(getattr(request, "interaction_mode", "normal") or "normal")
    if interaction_mode != "normal":
        return None

    forced_scene_id = str(getattr(request, "forced_scene_id", None) or "").strip()

    # 会话状态守卫。**只在「非指定」时生效**：用户点胶囊/表单提交是显式意图，
    # 此时会话里即使还有活跃 SOP 或待补槽，也该让用户走他想走的那条路 ——
    # 否则「点了按钮没反应」且没有任何提示。
    #
    # 反过来，非指定（靠关键词匹配）时必须守住：SOP 节点里用户说的一句话
    # 可能恰好含某个场景关键词，抢过来会让流程断在半路。
    if not forced_scene_id and (
        str(getattr(session, "active_skill_id", "") or "").strip()
        or str(getattr(session, "active_step_id", "") or "").strip()
        or getattr(session, "pending_tasks_json", None)
        or getattr(session, "awaiting_input_json", None)
    ):
        return None

    tenant_id = str(getattr(session, "tenant_id", "") or "")
    agent_id = str(getattr(session, "agent_id", "") or "")

    scene = resolve_scene_hit(
        db,
        tenant_id=tenant_id,
        agent_id=agent_id,
        message=message,
        forced_scene_id=forced_scene_id,
        on_trace=on_trace,
    )
    if scene is None:
        return None

    if on_trace is not None:
        on_trace(
            f"场景：进入「{scene.name}」",
            {
                "scene_id": scene.id,
                "module_key": scene.module_key,
                "scene_type": scene.scene_type,
            },
        )

    return TurnPlan(
        decision="answer_only",
        confidence=1.0,
        user_intent=str(message or "").strip()[:200] or scene.name,
        reason="scene shortcircuit: bound scene keyword/entry hit",
        task_frames=[
            PlannedTaskFrame(
                kind="conversation",
                decision="answer_only",
                execution_mode="scene_module",
                scene_id=scene.id,
                user_intent=str(message or "").strip()[:200] or scene.name,
                source_message=message,
            )
        ],
    )


__all__ = [
    "UNSUPPORTED_TYPE_TEXT",
    "_scene_shortcircuit_plan",
    "build_ui_blocks",
    "dispatch_scene",
    "resolve_scene_hit",
    "run_scene_instance",
]