"""模型准入闸门：所有渠道、所有入口共用的一套规则。

为什么要有这个模块（2026-11-19）
--------------------------------
改造前，免费配额校验写在 ``app/api/chat.py`` 的 HTTP 处理器里，形如
``if not request.model_config_id and request.agent_id: free_model_turn_allowed(...)``。
这带来两个结构性问题：

1. **渠道旁路**：微信（``app/wechat/service.py``）、定时任务、公开 API、人工恢复
   这些调用方都直接 ``AgentLoop(...).handle_turn(...)``，不经过那个 HTTP 处理器，
   于是免费员工在微信里可以无限提问，配额表一条都不记。同理，「没有模型又没人给
   他兜底」的用户在这些渠道里也绕过了「请先配置模型」的拦截。
2. **规则分散**：判断「这个员工是不是免费」「这个人有没有自己的模型」的知识散落
   在 API 层、前端 ``useChatSession`` 的 ``canSend`` 里，任何一处漏写就是一条漏洞。

因此把规则上移一位：**统一挂在引擎入口 ``AgentLoop.handle_turn`` 之前**。
引擎是唯一必然经过的收口点（流式路径 ``_handle_turn_stream_v2`` 最终也调它），
所以放这里等于「一次写对，全渠道生效」，且新增渠道不需要记住去加校验。

规则口径（与产品 2026-10-08 确认、2026-11-19 补充一致）
------------------------------------------------------
对**每一轮真实对话**，按下面顺序判定：

1. 请求已显式指定 ``model_config_id`` → 用户（或分享链接）已经选定模型，
   直接用，本闸门不介入（配额记在模型属主头上）。
2. 员工被管理员标记为**免费**（``free_model_enabled``）：
   - 用户自己有可用模型 → 走自己的，不消耗免费配额；
   - 用户没有自己的模型 → 必须有租户全局免费模型，且今日配额未打满，
     否则拒绝并给出可操作的提示。
3. 员工**不是免费**：用户必须有自己的可用模型。
   注意这里**不再回落到「租户里任意一条 enabled 模型」**——那会让没配模型的成员
   静默蹭管理员的模型，与「不免费的要自己配置模型」直接冲突。
   （回落逻辑仍在 ``model_for_agent`` 里，供无 user 上下文的内部链路使用。）

内部轮次不消耗配额
------------------
下面这些不是「用户主动提问」，不应计入每日额度，也不该因为没模型而被拦：

- ``message_visibility == "internal"``：引擎内部重试轮。
- 派发子轮（``app/dispatch/stream.py``）：它显式带 ``model_config_id``，走规则 1。
- 人工恢复轮（``channel == "human_handoff_resume"``）：它是在补发**已经回答过**
  的那条答案，再扣一次配额等于对同一个问题收两次费。
- 定时任务（``channel == "scheduled_task"``）：由用户此前创建，后台自动执行；
  它照常消耗配额，但要允许「没模型也先跑起来」——因为创建时并未约束模型。
  实际口径：定时任务**消耗配额但不因缺模型而拒绝**，最终模型解析失败由
  引擎按 ``MODEL_UNAVAILABLE`` 正常报错，与改造前一致。

对外错误码
----------
``FREE_MODEL_QUOTA_EXHAUSTED_CODE`` 保持原值（前端已按它译提示语）；
新增 ``MODEL_REQUIRED_CODE`` 表示「这个员工需要你自己配置模型」。
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session, select

from app.agents.free_model import (
    FREE_MODEL_DAILY_LIMIT,
    FREE_MODEL_QUOTA_EXHAUSTED_CODE,
    consume_free_quota,
    get_global_free_model,
    is_agent_free_enabled,
    own_model_for_role,
    remaining_free_quota,
)
from app.session.session_schema import ChatTurnRequest

# 「这个员工不免费，请先配自己的模型」。
MODEL_REQUIRED_CODE = "model_required"
# 员工被标记为免费，但租户没指定全局免费模型（管理员配置缺失）。
NO_GLOBAL_FREE_MODEL_CODE = "no_global_free_model"

# 这些错误码的 message 是**写给使用者看的、可操作的**，渠道侧（微信等）
# 应该原样透传，而不是换成「处理失败，请稍后重试」这类通用文案。
MODEL_GATE_REPLY_CODES = frozenset(
    {MODEL_REQUIRED_CODE, NO_GLOBAL_FREE_MODEL_CODE, FREE_MODEL_QUOTA_EXHAUSTED_CODE}
)

# 这些渠道的轮次属于「系统补发/后台执行」，不参与「缺模型就拒绝」的判定。
# 它们仍可能消耗配额（见下面的 should_consume）。
_NON_USER_CHANNELS = {"human_handoff_resume"}

# 定时任务不因缺模型被拒：创建任务时并未要求选模型，后台跑起来再报错更可预期。
_SKIP_MODEL_REQUIRED_CHANNELS = {"scheduled_task"}


@dataclass(frozen=True)
class ModelGateDecision:
    """闸门结论。

    ``allowed`` 为 False 时，``code`` / ``message`` 直接作为本轮失败原因返回给调用方；
    为 True 时 ``consumed`` 表示本次是否已经扣了一问配额。
    """

    allowed: bool
    code: str = ""
    message: str = ""
    consumed: bool = False


def _allowed() -> ModelGateDecision:
    return ModelGateDecision(allowed=True)


def _reject(code: str, message: str) -> ModelGateDecision:
    return ModelGateDecision(allowed=False, code=code, message=message)


def _is_turn_replay(db: Session, request: ChatTurnRequest) -> bool:
    """这一轮是不是「同一个 client_turn_id 的重复投递」。

    引擎入口后面有 ``HarnessTurnStore.claim`` 做幂等重放；但闸门在它之前执行，
    如果不先判掉，同一条消息因网络重试/轮询重连投递两次就会**扣两问配额**。
    只按 ``(session_id, client_turn_id)`` 查一次收据表，命中即视为重放。
    """
    from app.db.models import HarnessTurnRecord

    client_turn_id = str(request.client_turn_id or "").strip()
    session_id = str(request.session_id or "").strip()
    if not client_turn_id or not session_id:
        return False
    return (
        db.exec(
            select(HarnessTurnRecord).where(
                HarnessTurnRecord.tenant_id == request.tenant_id,
                HarnessTurnRecord.session_id == session_id,
                HarnessTurnRecord.client_turn_id == client_turn_id,
            )
        ).first()
        is not None
    )


def check_turn_model_policy(
    db: Session,
    request: ChatTurnRequest,
) -> ModelGateDecision:
    """在引擎入口统一判定「这一轮能不能跑、要不要扣免费配额」。

    只做判定与计数，不改请求、不抛异常——调用方（``AgentLoop.handle_turn``）
    负责把 ``allowed=False`` 转成与既有 precondition 一致的响应形状。
    """
    tenant_id = str(request.tenant_id or "")
    agent_id = str(request.agent_id or "").strip() or None
    user_id = str(request.user_id or "").strip() or None
    channel = str(request.channel or "web")

    # 规则 1：显式选了模型 → 用户已为自己的选择负责，不介入。
    # 分享链接的访客也走这条（ShareScope 强制注入了创建者的 model_config_id）。
    if request.model_config_id:
        return _allowed()

    # 幂等重放：不重复判定、不重复扣额。
    if _is_turn_replay(db, request):
        return _allowed()

    # 没有 agent（例如纯会话标题生成、内部探测）不是「员工对话」，不管。
    if not agent_id:
        return _allowed()

    # 引擎内部重试轮：不该被拦，也不该扣额度（否则一次提问可能扣两次）。
    if request.message_visibility == "internal":
        return _allowed()

    own_model = own_model_for_role(db, tenant_id, user_id, "default") if user_id else None
    is_free_agent = is_agent_free_enabled(db, tenant_id, agent_id)

    if is_free_agent:
        # 有自己模型的人完全不受免费链路影响（口径见 free_model 模块头）。
        if own_model is not None:
            return _allowed()
        if get_global_free_model(db, tenant_id) is None:
            # 员工被标免费，但租户还没指定全局免费模型：这是管理员配置缺失，
            # 不该让使用者背锅去配模型，所以给一条能自解释的提示。
            return _reject(
                NO_GLOBAL_FREE_MODEL_CODE,
                f"「{_agent_name(db, agent_id)}」被设为免费员工，但管理员还没有指定"
                "全局免费模型，暂时无法对话。请联系管理员在「模型配置」里设置。",
            )
        if channel in _NON_USER_CHANNELS:
            return _allowed()
        if remaining_free_quota(db, tenant_id, user_id, agent_id) <= 0:
            return _reject(
                FREE_MODEL_QUOTA_EXHAUSTED_CODE,
                f"该员工今日免费额度已用完（每人每天 {FREE_MODEL_DAILY_LIMIT} 问）。"
                "明天再来，或在「模型配置」里添加自己的模型。",
            )
        # 原子占用一问：并发两条消息也不会超发。
        consumed = consume_free_quota(db, tenant_id, user_id, agent_id)
        if not consumed:
            # 并发抢占失败 —— 说明刚好被别人打满，按超限处理。
            return _reject(
                FREE_MODEL_QUOTA_EXHAUSTED_CODE,
                f"该员工今日免费额度已用完（每人每天 {FREE_MODEL_DAILY_LIMIT} 问）。"
                "明天再来，或在「模型配置」里添加自己的模型。",
            )
        return ModelGateDecision(allowed=True, consumed=True)

    # 规则 3：非免费员工必须自带模型。
    if own_model is not None:
        return _allowed()
    if channel in _SKIP_MODEL_REQUIRED_CHANNELS:
        return _allowed()
    return _reject(
        MODEL_REQUIRED_CODE,
        f"「{_agent_name(db, agent_id)}」没有为你配置模型。"
        "请在「模型配置」里添加自己的模型后再对话，"
        "或让管理员把这个员工设为免费员工。",
    )


def _agent_name(db: Session, agent_id: str) -> str:
    """取员工名用于提示语；拿不到就退化成「该员工」，绝不因此让闸门抛异常。"""
    from app.db.models import AgentProfile

    row = db.get(AgentProfile, agent_id)
    return (row.name if row and row.name else "") or "该员工"