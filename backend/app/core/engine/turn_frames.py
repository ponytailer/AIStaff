"""TaskFrame 执行：标准/直答帧调度与单帧执行（批次 4.3 自 turn.py 类体搬出，mixin 化，零行为改动）。"""

from __future__ import annotations

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Iterator
from copy import deepcopy
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from app.aigw_cache import get_json, set_json
from app.config import get_settings
from app.core.base.cancellation import is_chat_turn_cancelled
from app.core.capability.discovery import project_capability_manifest
from app.core.capability.manifest import CapabilityManifestBuilder
from app.core.base.conversation_projection import ConversationProjection
from app.core.engine.step_loop import (
    MODEL_UNAVAILABLE_FAILURE_CODE,
    HarnessExecutionCancelled,
    HarnessExecutionFenced,
    HarnessTaskAgent,
    _trace_capability_result,
)
from app.core.engine.attachments import (
    materialize_task_attachments,
    validated_task_image_payloads,
)
from app.core.engine.invoke import HarnessCapabilityInvoker
from app.core.knowledge_flow.prefetch import is_smalltalk
from app.core.plan.planner_fastpath import HANDOFF_INTENT_REPLY
from app.core.capability.deliverables import list_published_deliverables
from app.core.engine.session import (
    HarnessSessionLeaseLost,
    HarnessSessionLeaseStore,
    HarnessSessionLeaseToken,
)
from app.core.engine.session import (
    acquire_harness_session,
    release_harness_session,
)
from app.core.engine.session import HarnessTurnStore
from app.core.plan.slash import (
    SlashCommandError,
    SlashCommandSelection,
    build_slash_turn_plan,
    force_capability_for_requirement,
    parse_slash_command,
    resolve_capability,
    slash_command_message,
)
from app.core.sop.slots.form import build_slot_form
from app.core.sop.slots.hydration import SlotHydrationPolicy
from app.core.engine.frames import (
    TaskFrameClaimConflict,
    TaskFrameStore,
    planned_frame_from_record,
)
from app.core.base.request_compiler import (
    TaskExecutionResult,
    TaskRequestCompiler,
)
from app.core.plan.planner import TurnPlanner, turn_plan_router_decision
from app.core.base.ui_flags import knowledge_citations_hidden
from app.db.models import (
    ChatSession,
    HarnessRunRecord,
    HarnessTaskFrameRecord,
    HarnessTurnRecord,
    Message,
    Skill,
    utc_now,
)
from app.knowledge.citations import (
    citation_identity,
    compact_knowledge_citation_labels,
    renumber_citations,
    strip_citation_markers,
)
from app.llm.stage_protocol import stage_payload, unified_system_prompt
from app.memory.service import memory_read
from app.session.helpers import public_session
from app.session.session_schema import (
    ChatTurnRequest,
    ChatTurnResponse,
    StepAgentResult,
    TurnPlan,
)
from app.skills.nesting import discoverable_sops, expand_visible_sops

from app.core.engine.turn_support import (

    _aggregate_artifacts,
    _append_session_handoff_artifact,
    _build_knowledge_laya_router,
    _build_laya_router,
    _combine_results,
    _defer_failed_step_after_completed_checkpoint,
    _dependency_order,
    _enforce_required_slots,
    _globalize_citations,
    _inject_handoff_context,
    _is_recoverable_action_protocol_failure,
    _load_edge_condition_specs,
    _merge_discovered_artifacts,
    _prior_result,
    _response_task_payload,
    _restore_session_state,
    _session_state,
    _single_task_reply,
    _skill_step_timeout_seconds,
    _sibling_task_intents,
    _source_user_message,
    _step_result,
    _with_recoverable_first_session,
    get_or_create_harness_session,
)

from app.core.engine.turn_context import (
    INTENT_CACHE_TTL_SECONDS,
    KNOWLEDGE_ANSWER_OPERATION,
    _KNOWLEDGE_WORKFLOW_BLOCKING_KINDS,
    _TRACE_STREAM_STATUS,
    _apply_forced_sop_snapshot,
    _capability_summary_text,
    _direct_reply_answer,
    _direct_reply_answer_stream,
    _intent_cache_key,
    _is_knowledge_workflow_frame,
    _session_title_from_plan,
    _stream_status_for_trace,
    _turn_planner_message,
    _turn_skill_projection,
    _turn_slash_selection,
)


logger = logging.getLogger(__name__)


class _FrameExecutionMixin:
    def _touch_faq_usage(
        self, tenant_id: str, agent_id: str | None, frame: Any
    ) -> None:
        """FAQ 短路命中后 usage_count+1；失败静默——计数不影响回答。"""

        from app.db.models import AgentFaqItem

        item_id = str((frame.slot_hints or {}).get("faq_item_id") or "").strip()
        if not item_id or not agent_id:
            return
        try:
            row = self.db.get(AgentFaqItem, item_id)
            if row and row.tenant_id == tenant_id and row.agent_id == agent_id:
                row.usage_count = int(row.usage_count or 0) + 1
                self.db.add(row)
                self.db.commit()
        except Exception:  # noqa: BLE001
            self.db.rollback()

    def _run_direct_reply_frame(
        self,
        request: ChatTurnRequest,
        execution_request: ChatTurnRequest,
        session: ChatSession,
        row: HarnessTaskFrameRecord,
        frame: Any,
        model_config: Any,
        memory_context: list[dict[str, object]],
        conversation_context: dict[str, Any] | None,
        execution_mode: str = "direct_reply",
    ) -> TaskExecutionResult | None:
        """direct_reply / capability_intro 帧的轻量执行：一次问答模型调用直出
        最终回复。

        返回 None 表示应降级到标准 Harness 路径。帧记录/trace 事件保持与
        标准路径一致（task_frame_started/finished），前端零改动。
        """

        self.store.mark_running(row)
        agent_loop = self.store.ensure_agent_loop(row)
        self.active_frame_id = row.id
        self.active_frame_lease_owner = row.lease_owner
        self.active_frame_attempt_no = row.attempt_no
        self.events.record(
            request.tenant_id,
            session.id,
            "task_frame_started",
            {
                "task_frame_id": row.task_id,
                "kind": row.kind,
                "execution_mode": execution_mode,
                "agent_loop_id": agent_loop.id,
                "agent_loop_kind": agent_loop.kind,
                "execution_engine": "harness_v2",
            },
        )
        try:
            # faq_hit：反馈自进化的标准答案已在规划期命中，零 LLM 直出。
            # 答案不存在（FAQ 被并发删除/停用）时返回 None 降级标准路径。
            # 正文回放由外层 _handle_turn_stream_v2 的匀速回放统一处理，
            # 这里只产出 reply_fragment。
            if execution_mode == "faq_hit":
                faq_answer = str((frame.slot_hints or {}).get("faq_answer") or "").strip()
                if not faq_answer:
                    return None
                reply = faq_answer
            elif execution_mode == "handoff_intent":
                # 转人工直通：用户点按钮/明确要人时没有任何决策空间，固定话术
                # 一句说完，不再检索知识库、不再 capability_search 找工单接口。
                # 建单在下面 conversation handoff 分支照常发生。
                reply = HANDOFF_INTENT_REPLY
            else:
                # 未单独配置问答模型时直接用本轮请求模型——相比标准路径仍省掉
                # Harness 主模型决策 + ResponseGenerator 两次串行调用。
                answer_model = model_config
                persona_prompt = self.owner._get_persona_prompt(
                    request.tenant_id, session.agent_id
                )
                capability_summary: str | None = None
                if execution_mode == "capability_intro":
                    capability_summary = _capability_summary_text(
                        self.db, request.tenant_id, session.agent_id
                    )
                    if not capability_summary:
                        # 没有任何可介绍的能力：仍可直出（提示语会引导模型坦率说明），
                        # 但传 None 会走问候分支，因此显式给一个空清单说明。
                        capability_summary = "（当前该数字员工暂无可介绍的业务能力。）"
                reply = self._answer_direct_reply(
                    execution_request.message,
                    persona_prompt,
                    memory_context,
                    conversation_context,
                    answer_model,
                    capability_summary=capability_summary,
                )
        except Exception as exc:  # noqa: BLE001 - 降级到标准路径
            # 生成中途失败：清掉已下发的半截增量，避免降级到标准路径后
            # 两段互不相关的文本拼在一起。
            if self.turn_stream is not None:
                self.turn_stream.reset()
            row.status = "queued"
            row.updated_at = utc_now()
            self.db.add(row)
            self.db.commit()
            self.events.record(
                request.tenant_id,
                session.id,
                "task_frame_direct_reply_fallback",
                {
                    "task_frame_id": row.task_id,
                    "reason": str(exc)[:500],
                    "execution_engine": "harness_v2",
                },
            )
            return None
        if execution_mode == "faq_hit":
            # FAQ 命中计数：owner 在工作台看命中率调整词条
            self._touch_faq_usage(request.tenant_id, session.agent_id, frame)
        result = TaskExecutionResult(
            task_frame_id=row.task_id,
            status=(
                # handoff_intent：本帧就是转人工，建单后挂 handoff 状态，
                # 让会话进入 handoff（owner 收件箱可见、用户看到「已转接」）。
                "handoff" if execution_mode == "handoff_intent" else "completed"
            ),
            reply_fragment=reply,
            task_summary=frame.user_intent or (
                "能力介绍回复。" if execution_mode == "capability_intro" else "社交性对话回复。"
            ),
            action_count=1,
        )
        if execution_mode == "handoff_intent":
            # 直通路径不走标准 conversation handoff 分支（那条在 _run_frame
            # 的循环里），建单必须在这里补上，否则「已转接」只是一句空话。
            handoff = self.owner._create_human_handoff_request(
                request.tenant_id,
                session,
                None,
                _step_result(result),
            )
            result.artifacts.append(
                {
                    "type": "human_handoff",
                    "handoff_id": getattr(handoff, "id", None),
                }
            )
        self.store.finish_frame(
            row,
            status=result.status,
            step_id=row.step_id,
            slots=dict(row.slots_json or {}),
            result=result.model_dump(mode="json"),
        )
        self.store.finish_agent_loop_for_frame(
            row,
            result_status=result.status,
            checkpoint={},
            last_run_id=None,
        )
        self.events.record(
            request.tenant_id,
            session.id,
            "task_frame_finished",
            {
                "task_frame_id": row.task_id,
                "kind": row.kind,
                "execution_mode": execution_mode,
                "status": result.status,
                "action_count": result.action_count,
                "agent_loop_id": agent_loop.id,
                "agent_loop_status": result.status,
                "execution_engine": "harness_v2",
            },
        )
        self.db.commit()
        return result

    def _run_scene_frame(
        self,
        request: ChatTurnRequest,
        session: ChatSession,
        row: HarnessTaskFrameRecord,
        frame: Any,
    ) -> TaskExecutionResult | None:
        """场景实例帧的轻量执行：走 ``scene_modules.run_scene_instance``，零 LLM。

        为什么单独立一个方法而不是塞进 ``_run_direct_reply_frame``：那个方法已经
        200 多行、承载 5 种模式，再塞第七种会让「哪条路径漏了 commit / 漏了
        finish_frame」彻底看不出。这里照抄它的骨架（mark_running → 干活 →
        finish_frame → finish_agent_loop → 事件 → commit），只是中间那段
        「怎么产出回复」换成一次确定性场景执行。

        返回 ``None`` 表示应降级到标准 Harness 路径。哪些情况降级：

        - 帧上没有 ``scene_id``（计划是从旧版本库记录还原的，或计划生成期出错）
        - 场景已被删除 / 解绑 / 转成草稿（``run_scene_instance`` 返回 error）
        - 执行过程中抛异常（数据库、配置、第三方）

        **降级而不是报错**：用户点了按钮，最差也该拿到一段泛泛的回答，
        而不是一个红条。arch §5.7 的 graceful fallback 就是这条。
        """
        scene_id = str(getattr(frame, "scene_id", "") or "").strip()
        if not scene_id:
            # 没有 scene_id 的 scene_module 帧无法执行，也不可能靠重试修好
            # （是计划生成期的缺失），直接降级。
            self.events.record(
                request.tenant_id,
                session.id,
                "task_frame_scene_fallback",
                {
                    "task_frame_id": row.task_id,
                    "reason": "missing_scene_id",
                    "execution_engine": "harness_v2",
                },
            )
            return None

        from app.scene_modules.runtime import run_scene_instance

        self.store.mark_running(row)
        agent_loop = self.store.ensure_agent_loop(row)
        self.active_frame_id = row.id
        self.active_frame_lease_owner = row.lease_owner
        self.active_frame_attempt_no = row.attempt_no
        self.events.record(
            request.tenant_id,
            session.id,
            "task_frame_started",
            {
                "task_frame_id": row.task_id,
                "kind": row.kind,
                "execution_mode": "scene_module",
                "scene_id": scene_id,
                "agent_loop_id": agent_loop.id,
                "agent_loop_kind": agent_loop.kind,
                "execution_engine": "harness_v2",
            },
        )
        try:
            # 槽位来源有两个，必须合并（顺序：帧上已有的 → 本轮表单提交的覆盖）。
            #
            # ## 为什么必须读 `slot_submission`
            #
            # 表单提交轮发的文本是「人数：4；天数：5；预算：3000」，`slot_submission`
            # 里才是结构化取值。早期这里只读 `row.slots_json`，于是每一轮表单提交
            # 都在重放「空槽位 → 你还没填」——用户填完表，界面又弹回同一张空表，
            # 永远走不到结果卡。
            #
            # ## 为什么要写回帧
            #
            # 场景是**多轮**的：这一轮补了人数和天数，下一轮只补预算时，前两个值
            # 必须还在。不写回就是「每轮都从零开始」，用户永远凑不齐三个条件。
            frame_slots = dict(row.slots_json or {})
            submission = getattr(request, "slot_submission", None)
            if isinstance(submission, dict) and submission:
                frame_slots.update(submission)
                row.slots_json = dict(frame_slots)
                row.updated_at = utc_now()
                self.db.add(row)
                self.db.commit()
            # persist=True：聊天执行要落 SceneRun（命中率与排障靠它）。
            # session_id 传进去是因为 handoff 通道要在会话上下文里建真实工单。
            result = run_scene_instance(
                self.db,
                tenant_id=request.tenant_id,
                scene_id=scene_id,
                slots=frame_slots,
                message=str(request.message or ""),
                persist=True,
                session_id=session.id,
                user_id=request.user_id,
                # **当前会话挂的那个员工**，不是场景绑定的员工。
                #
                # 两者语义不同：场景可能同时绑在 3 个员工上，而这一轮是「哪个
                # 员工在跟用户说话」，工具鉴权必须按后者——否则 A 员工没勾选
                # 的工具，会因为 B 员工勾了而在 A 的会话里调得通。
                #
                # 这也和 `resolve_scene_hit` 用的是同一个 `session.agent_id`，
                # 场景层与工具层的判据因此严格对齐。
                agent_id=str(session.agent_id or "") or None,
            )
        except Exception as exc:  # noqa: BLE001 - 降级到标准路径
            row.status = "queued"
            row.updated_at = utc_now()
            self.db.add(row)
            self.db.commit()
            self.events.record(
                request.tenant_id,
                session.id,
                "task_frame_scene_fallback",
                {
                    "task_frame_id": row.task_id,
                    "scene_id": scene_id,
                    "reason": str(exc)[:500],
                    "execution_engine": "harness_v2",
                },
            )
            return None

        if result.status == "error":
            # 场景不存在 / 租户不匹配 / 类型不支持：这些都不是「本帧失败」，
            # 而是「这条场景不该被进入」。降级到普通对话比给用户看一句
            # 「这个场景已不存在」更体面，也让用户能继续问别的。
            row.status = "queued"
            row.updated_at = utc_now()
            self.db.add(row)
            self.db.commit()
            self.events.record(
                request.tenant_id,
                session.id,
                "task_frame_scene_fallback",
                {
                    "task_frame_id": row.task_id,
                    "scene_id": scene_id,
                    "reason": "scene_status_error",
                    "scene_text": result.text[:300],
                    "execution_engine": "harness_v2",
                },
            )
            return None

        reply = result.text or ""
        if not reply:
            # 只产了块、没有正文（例如纯 result 卡）：仍要给一条文本，
            # 否则非 UI 渠道（企微/微信/短信）会收到一条空消息。
            reply = next(
                (
                    str((block.data or {}).get("content") or "").strip()
                    for block in result.blocks
                    if str((block.data or {}).get("content") or "").strip()
                ),
                "已为你处理这个场景。",
            )

        execution_result = TaskExecutionResult(
            task_frame_id=row.task_id,
            status="completed",
            reply_fragment=reply,
            task_summary=frame.user_intent or "场景实例执行。",
            action_count=1,
            ui_blocks=result.to_blocks_dicts(),
            scene_params=dict(result.render_params or {}),
            scene_id=scene_id,
            scene_status=result.status,
        )
        self.store.finish_frame(
            row,
            status=execution_result.status,
            step_id=row.step_id,
            slots=dict(row.slots_json or {}),
            result=execution_result.model_dump(mode="json"),
        )
        self.store.finish_agent_loop_for_frame(
            row,
            result_status=execution_result.status,
            checkpoint={},
            last_run_id=None,
        )
        self.events.record(
            request.tenant_id,
            session.id,
            "task_frame_finished",
            {
                "task_frame_id": row.task_id,
                "kind": row.kind,
                "execution_mode": "scene_module",
                "scene_id": scene_id,
                "status": execution_result.status,
                "action_count": execution_result.action_count,
                "agent_loop_id": agent_loop.id,
                "agent_loop_status": execution_result.status,
                "execution_engine": "harness_v2",
            },
        )
        self.db.commit()
        return execution_result

    def _run_frame(
        self,
        request: ChatTurnRequest,
        session: ChatSession,
        row: HarnessTaskFrameRecord,
        frame: Any,
        active_skill: Skill | None,
        model_config: Any,
        memory_context: list[dict[str, object]],
        prior_frame_results: list[dict[str, Any]],
        max_actions: int,
        lightweight_model_config: Any = None,
        conversation_context: dict[str, Any] | None = None,
    ) -> tuple[TaskExecutionResult, StepAgentResult]:
        # 动作预算一律走配置（agent.harness_max_actions / UIConfig.agent_loop_max_actions，
        # 调用方按 remaining_turn_actions 逐帧递减传入），不按帧类型降档——
        # conversation 帧硬编码 6 轮会让租户配 32 只生效 6，与配置语义不符。
        self.store.mark_running(row)
        agent_loop = self.store.ensure_agent_loop(row)
        loop_checkpoint = dict(agent_loop.checkpoint_json or {})
        self.active_frame_id = row.id
        self.active_frame_lease_owner = row.lease_owner
        self.active_frame_attempt_no = row.attempt_no
        attachment_descriptors = materialize_task_attachments(
            request.attachments,
            tenant_id=request.tenant_id,
            session_id=session.id,
            task_frame_id=row.task_id,
            user_id=request.user_id or "",
            db=self.db,
        )
        image_payloads = validated_task_image_payloads(request.attachments)
        published_deliverables = list_published_deliverables(
            self.db,
            tenant_id=request.tenant_id,
            session_id=session.id,
            exclude_task_frame_id=row.task_id,
        )
        step_timeout_seconds = (
            _skill_step_timeout_seconds(active_skill)
            if frame.kind == "sop"
            else None
        )
        # 边条件的结构化编译产物（离线编译器写入 skill_edge_conditions）。
        # 每帧读一次、帧内各次外层迭代复用：图在同一次执行里不会变，而这张
        # 表按 (tenant, skill_id) 建了索引、行数就是图上条件边的条数。
        # 加载失败一律当「没有编译结果」，运行时回落 LLM 决策链路。
        edge_condition_specs = _load_edge_condition_specs(
            self.db,
            request.tenant_id,
            active_skill,
            frame.kind,
        )
        # Laya 出边决策旁路：仅 sop 帧构造（2026-10-26 已转正，开关下线，
        # shadow=False 真正采纳 Laya 判定；低置信/超时/熔断仍回退 LLM）。
        laya_router = _build_laya_router(frame.kind)
        # Laya 知识路由旁路（P2'）：任何帧都可能触发知识检索，独立实例、独立熔断。
        knowledge_laya_router = _build_knowledge_laya_router()
        self.events.record(
            request.tenant_id,
            session.id,
            "task_frame_started",
            {
                "task_frame_id": row.task_id,
                "kind": row.kind,
                "skill_id": row.skill_id,
                "skill_name": active_skill.name if active_skill is not None else None,
                "step_id": row.step_id,
                "step_timeout_seconds": step_timeout_seconds,
                "harness_max_actions": max_actions,
                "agent_loop_id": agent_loop.id,
                "agent_loop_kind": agent_loop.kind,
                "execution_engine": "harness_v2",
            },
        )
        remaining_actions = max_actions
        results: list[TaskExecutionResult] = []
        last_step_result = StepAgentResult()
        run: HarnessRunRecord | None = None

        while remaining_actions > 0:
            self._raise_if_cancelled(request, session)
            step_deadline_monotonic = (
                time.monotonic() + step_timeout_seconds
                if step_timeout_seconds is not None
                else None
            )
            frame.target_step_id = row.step_id or session.active_step_id
            manifest = self.manifests.build(
                request.tenant_id,
                session.agent_id,
                active_skill,
                frame.target_step_id,
                # 本轮「互联网检索」开关：开了才会在冻结清单里出现 web_search
                # 能力。invoker 持有同一标志，授权校验重建清单时必须同值。
                web_search=bool(getattr(request, "web_search", False)),
            )
            # Keep the complete frozen manifest server-side for authorization,
            # while compiling the TaskRequirement only from the safe model
            # projection. capability_describe can activate schemas later.
            model_manifest = project_capability_manifest(manifest)
            requirement = self.compiler.compile(
                frame,
                session,
                active_skill,
                model_manifest,
                memory_context,
                [
                    *prior_frame_results,
                    *[_prior_result(item) for item in results],
                ],
                attachment_descriptors,
                published_deliverables,
                source_user_message=(
                    request.message
                    if row.source_turn_id == self.user_message_id
                    else _source_user_message(self.db, row)
                ),
                out_of_scope_task_intents=_sibling_task_intents(self.db, row),
            )
            if (
                self.slash_command
                and self.slash_command.kind in {"skill", "tool"}
                and frame.kind == "conversation"
                and row.source_turn_id == self.user_message_id
            ):
                forced = resolve_capability(self.slash_command, manifest)
                force_capability_for_requirement(
                    requirement,
                    model_manifest,
                    forced,
                )
            self.store.save_requirement(
                row,
                requirement.model_dump(mode="json"),
                lease_owner=self.active_frame_lease_owner,
                attempt_no=self.active_frame_attempt_no,
            )
            if run is None:
                run = self.store.start_run(
                    row,
                    requirement=requirement.model_dump(mode="json"),
                    capability_snapshot=manifest.model_dump(mode="json"),
                    lease_owner=self.active_frame_lease_owner,
                    attempt_no=self.active_frame_attempt_no,
                )
                self.store.save_agent_loop_checkpoint(
                    agent_loop,
                    loop_checkpoint,
                    status="active",
                    last_run_id=run.id,
                )
            else:
                self.store.update_run_context(
                    run,
                    requirement=requirement.model_dump(mode="json"),
                    capability_snapshot=manifest.model_dump(mode="json"),
                )
            self.active_run_id = run.id
            self.db.commit()

            def trace(event_type: str, payload: dict[str, Any]) -> None:
                self.events.record(
                    request.tenant_id,
                    session.id,
                    event_type,
                    {
                        **payload,
                        "task_frame_id": row.task_id,
                        "harness_run_id": run.id,
                        "agent_loop_id": agent_loop.id,
                        "execution_engine": "harness_v2",
                    },
                )
                # Harness runs execute outside the response generator. Commit
                # each trace checkpoint so the stream relay can expose the
                # running TaskFrame instead of revealing it only at the end.
                self.db.commit()
                # 流式轮次：把「检索知识库 / 正在调用工具 X / 模型输出异常重试」
                # 等执行期环节翻译成等待期可见的状态，避免界面上「卡死」。
                self._trace_stream_status(event_type, payload)

            invoker = HarnessCapabilityInvoker(
                self.db,
                tenant_id=request.tenant_id,
                session=session,
                task_frame_id=row.task_id,
                model_config=model_config,
                manifest=manifest,
                active_skill=active_skill,
                active_step_id=frame.target_step_id,
                agent_id=session.agent_id,
                run_id=run.id,
                user_message=requirement.source_user_message,
                initially_activated_names=(
                    requirement.capability_manifest.allowed_names()
                ),
                is_cancelled=lambda: self._is_cancelled(request, session),
                ensure_execution_lease=lambda: self._renew_execution_leases(
                    row
                ),
                trace_sink=trace,
                step_deadline_monotonic=step_deadline_monotonic,
                knowledge_laya_router=knowledge_laya_router,
                web_search_enabled=bool(getattr(request, "web_search", False)),
            )

            # 仅知识库 conversation 帧：走确定性工作流（寒暄直回 / 代码直调
            # 检索 → 一次作答），不进入 Harness 决策循环。任何环节异常由工作流
            # 内部返回 None，自动降级到下面的标准路径。
            knowledge_workflow_result = None
            if _is_knowledge_workflow_frame(
                frame,
                manifest,
                slash_command=self.slash_command,
                has_attachments=bool(attachment_descriptors or image_payloads),
            ):
                knowledge_workflow_result = self._run_knowledge_workflow(
                    request,
                    session,
                    row,
                    frame,
                    requirement,
                    invoker,
                    model_config,
                    memory_context,
                    conversation_context,
                    trace,
                )
            if knowledge_workflow_result is not None:
                result = knowledge_workflow_result
            else:
                result = self.task_agent.run(
                    requirement,
                    model_config,
                    invoker.invoke,
                    max_actions=remaining_actions,
                    trace_sink=trace,
                    is_cancelled=lambda: self._is_cancelled(request, session),
                    image_payloads=image_payloads,
                    step_deadline_monotonic=step_deadline_monotonic,
                    step_timeout_seconds=step_timeout_seconds,
                    checkpoint=loop_checkpoint,
                    lightweight_model_config=lightweight_model_config,
                    edge_condition_specs=edge_condition_specs,
                    laya_router=laya_router,
                    # A2UI：只有「本帧就是当前用户消息的落点」时才认表单提交，
                    # 否则同一轮里被唤醒的其它帧会共用一份不属于它的槽位值。
                    slot_submission=(
                        request.slot_submission
                        if row.source_turn_id == self.user_message_id
                        else None
                    ),
                    # 流式轮次：2026-10-19 起关闭「决策 JSON 正文预览」通道。
                    # 预览会让正文跟随上游分包节奏抖动；改为不流式生成，由
                    # _handle_turn_stream_v2 统一按 8 字/45ms 匀速回放。
                    reply_preview_sink=None,
                )
            deferred_continuation = False
            if frame.kind == "sop":
                deferred_result = _defer_failed_step_after_completed_checkpoint(
                    result,
                    results,
                )
                if deferred_result is not result:
                    deferred_continuation = True
                    trace(
                        "harness_step_continuation_deferred",
                        {
                            "failed_step_id": frame.target_step_id,
                            "error": result.error,
                            "checkpoint_step_id": row.step_id,
                            "reason": "previous_step_already_produced_user_result",
                        },
                    )
                    result = deferred_result
            loop_checkpoint = dict(result.loop_checkpoint or {})
            _merge_discovered_artifacts(result, invoker.discover_artifacts())
            loop_checkpoint["artifacts"] = list(result.artifacts)
            self.store.save_agent_loop_checkpoint(
                agent_loop,
                loop_checkpoint,
                status="active",
                last_run_id=run.id,
            )
            results.append(result)
            remaining_actions -= max(1, result.action_count)

            if deferred_continuation:
                # The previous SOP step was already committed and moved the
                # session to this step.  Keep that durable checkpoint queued
                # for a later turn instead of applying a transient failure to
                # the session and replacing the useful answer already found.
                last_step_result = _step_result(result)
                break

            if frame.kind == "conversation":
                if (
                    frame.decision == "handoff_human"
                    or result.status == "handoff"
                ):
                    result.status = "handoff"
                    last_step_result = _step_result(result)
                    handoff = self.owner._create_human_handoff_request(
                        request.tenant_id,
                        session,
                        None,
                        last_step_result,
                    )
                    result.artifacts.append(
                        {
                            "type": "human_handoff",
                            "handoff_id": getattr(handoff, "id", None),
                        }
                    )
                else:
                    last_step_result = _step_result(result)
                break

            result = _enforce_required_slots(result, requirement, session)
            results[-1] = result
            if (
                result.status == "completed"
                and not result.next_step_id
                and active_skill is not None
            ):
                default_next = self.owner._default_next_step(
                    active_skill, session.active_step_id
                )
                if default_next:
                    result.next_step_id = str(
                        default_next.get("step_id")
                        or default_next.get("node_id")
                        or ""
                    ).strip() or None
            last_step_result = _step_result(result)
            previous_step_id = session.active_step_id
            self.owner._apply_step_result(
                request.tenant_id,
                session,
                last_step_result,
                active_skill,
            )
            finalize_state = self.owner._finalize_execution_after_reply(
                request.tenant_id,
                session,
                active_skill,
                turn_plan_router_decision(
                    TurnPlan(
                        decision=frame.decision,
                        task_frames=[frame],
                        user_intent=frame.user_intent,
                    )
                ),
                last_step_result,
                None,
            )
            row.step_id = session.active_step_id
            row.slots_json = dict(session.slots_json or {})
            continue_frame = True
            if finalize_state == "handoff":
                result.status = "handoff"
                _append_session_handoff_artifact(result, session)
                continue_frame = False
            elif result.status == "handoff":
                result.status = "failed"
                result.error = {
                    "code": "HANDOFF_NOT_ALLOWED",
                    "message": "当前 SOP 步骤未声明转人工能力。",
                }
                continue_frame = False
            elif finalize_state == "completed":
                result.status = "completed"
                continue_frame = False
            elif result.status != "completed":
                continue_frame = False
            elif (
                remaining_actions <= 0
                or not session.active_skill_id
                or session.active_step_id == previous_step_id
            ):
                result.status = "action_budget"
                continue_frame = False
            else:
                frame.target_step_id = session.active_step_id
            if not continue_frame:
                break

        combined = _combine_results(row.task_id, results)
        if run is not None:
            self.store.finish_run(
                run,
                status=combined.status,
                action_count=combined.action_count,
                result=combined.model_dump(mode="json"),
                lease_owner=self.active_frame_lease_owner,
                attempt_no=self.active_frame_attempt_no,
            )
            self.active_run_id = None
        row_status = combined.status
        preserve_agent_loop = _is_recoverable_action_protocol_failure(combined)
        if row_status == "action_budget" or preserve_agent_loop:
            row_status = "queued"
        self.store.finish_frame(
            row,
            status=row_status,
            step_id=row.step_id,
            slots=dict(row.slots_json or {}),
            result=combined.model_dump(mode="json"),
            lease_owner=self.active_frame_lease_owner,
            attempt_no=self.active_frame_attempt_no,
        )
        self.store.finish_agent_loop_for_frame(
            row,
            result_status=("queued" if preserve_agent_loop else combined.status),
            checkpoint=loop_checkpoint,
            last_run_id=run.id if run is not None else None,
        )
        self.events.record(
            request.tenant_id,
            session.id,
            "task_frame_finished",
            {
                "task_frame_id": row.task_id,
                "kind": row.kind,
                "skill_id": row.skill_id,
                "skill_name": active_skill.name if active_skill is not None else None,
                "status": combined.status,
                "step_id": row.step_id,
                "action_count": combined.action_count,
                "error": combined.error,
                "agent_loop_id": agent_loop.id,
                "agent_loop_status": agent_loop.status,
                "execution_engine": "harness_v2",
            },
        )
        self.db.commit()
        self.active_frame_id = None
        self.active_frame_lease_owner = None
        self.active_frame_attempt_no = None
        return combined, last_step_result

