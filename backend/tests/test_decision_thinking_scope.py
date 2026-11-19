"""Harness 决策轮按轮次开关思考模式。

背景：``harness.task_action`` 单轮实测 91-187s，其中很大一部分是思维链。
第 1 轮要读任务、决定下一步，思考有价值；第 2 轮之后输入已变成上一轮工具
返回的真实结果，基本只是「组织成答案」，思考纯亏。生产现场
（session_3230c8ab1b4b2cf2）同一个 payload 结构下，第 2 轮 1.83s、
第 3 轮 11.89s，差异几乎全在 thinking_mode 上。

这里锁三件事：
1. 第 1 轮不干预（沿用模型/全局配置）；
2. 第 2 轮起生效为 ``disabled``，且真的写进了出站 extra_body；
3. 作用域退出后完全还原，不会泄漏到工具调用或下一帧。
"""

from __future__ import annotations

from app.core.engine.step_loop import _decision_thinking_scope
from app.llm.client import _thinking_request_kwargs
from app.llm.output_policy import (
    operation_thinking_mode,
    thinking_mode_scope,
)

OPERATION = "harness.task_action"


def _effective(configured: str = "provider_default") -> str:
    return operation_thinking_mode(OPERATION, configured)


def test_first_iteration_leaves_thinking_untouched():
    """第 1 轮：推理能力必须完整保留。"""

    with _decision_thinking_scope(1):
        assert _effective() == "provider_default"


def test_second_iteration_disables_thinking():
    """第 2 轮起关思考 —— 这是这次改动的核心断言。"""

    with _decision_thinking_scope(2):
        assert _effective() == "disabled"


def test_later_iterations_also_disabled():
    """第 3 轮及以后同样是关的，不能只覆盖第 2 轮。"""

    for iteration in (3, 5, 12):
        with _decision_thinking_scope(iteration):
            assert _effective() == "disabled", iteration


def test_disabled_mode_reaches_outbound_request_body():
    """最后一道关：决定要真的写进出站 payload，而不只是内部变量变了。

    只断言 ``operation_thinking_mode`` 的返回值是不够的 —— 真正决定模型
    行为的是 ``extra_body`` 里的 ``thinking.type``。
    """

    with _decision_thinking_scope(2):
        mode = _effective()
    kwargs = _thinking_request_kwargs(mode, {})
    assert kwargs["extra_body"]["thinking"]["type"] == "disabled"


def test_first_iteration_sends_no_thinking_override():
    """第 1 轮不能出现任何 thinking 覆盖，否则等于悄悄改了默认行为。"""

    with _decision_thinking_scope(1):
        mode = _effective()
    assert _thinking_request_kwargs(mode, {}) == {}


def test_scope_restores_after_exit():
    """退出作用域必须还原，否则后面的工具调用会一起被关思考。"""

    with _decision_thinking_scope(2):
        assert _effective() == "disabled"
    assert _effective() == "provider_default"


def test_nested_scopes_do_not_clear_outer_override():
    """内层传空（第 1 轮）不应把外层已经声明的 disabled 抹掉。

    这类 bug 很隐蔽：单看每一层都对，组合起来就变成「外层说了关，内层一
    进去又开了」。
    """

    with thinking_mode_scope("disabled"):
        with _decision_thinking_scope(1):
            # 第 1 轮自己不设置，但外层已声明 disabled，应当继承
            assert _effective() == "disabled"
        assert _effective() == "disabled"


def test_operation_static_override_still_wins_over_model_config():
    """回归保护：静态 operation 覆盖（如知识库路由）不能被这次改动削弱。"""

    assert operation_thinking_mode("knowledge.bucket_route", "provider_default") == "disabled"

# ---------------------------------------------------------------------------
# 下面这条才是真正的回归保护：走完整 HarnessTaskAgent 决策循环，
# 断言**每轮**客户端实际看到的思考模式。
#
# 只测 _decision_thinking_scope 本身是不够的 —— 我把调用点的 scope 包装
# 摘掉后，纯函数用例依然全绿。那种用例保护不了「有没有真的接上去」。
# ---------------------------------------------------------------------------


def _model_config():
    from app.db.models import ModelConfig

    return ModelConfig(
        id="model-test",
        tenant_id="tenant-demo",
        name="测试模型",
        api_key_encrypted="test",
        model="test-model",
    )


def _requirement():
    from app.core.base.request_compiler import TaskRequirement

    return TaskRequirement(
        task_frame_id="task-thinking",
        kind="conversation",
        goal="这个报错怎么解决",
        requirements=["给出解决方案"],
        source_user_message="这个报错怎么解决",
    )


def _run_two_turn_loop(monkeypatch):
    """跑一个真的走两轮的 Harness 循环，返回每轮生成动作时看到的思考模式。"""

    from app.core.engine import step_loop as step_loop_module
    from app.core.engine.step_loop import HarnessTaskAgent

    observed: list[str] = []

    class _Client:
        def __init__(self, _model_config) -> None:
            # 不需要收集实例：观察点是「每次生成动作时的思考模式」，
            # 已经由闭包里的 observed 记录。
            del _model_config

        def generate_json(self, _system_prompt, payload, **_kwargs):
            # 关键：在「生成动作的这一刻」读思考模式，而不是事后读。
            observed.append(_effective())
            if payload.get("iteration") == 1:
                return {
                    "action": "tool",
                    "tool_name": "knowledge_search",
                    "arguments": {"query": "报错排查"},
                    "task_summary": "查手册",
                }
            return {
                "action": "finish",
                "status": "completed",
                "reply_fragment": "按手册处理。",
                "task_summary": "已给方案。",
            }

    monkeypatch.setattr(step_loop_module, "LLMClient", _Client)

    HarnessTaskAgent().run(
        _requirement(),
        _model_config(),
        lambda _name, _arguments: {"success": True, "chunks": []},
        max_actions=3,
    )
    return observed


def test_loop_disables_thinking_from_second_iteration(monkeypatch):
    """接上调用点之后的端到端断言：第 1 轮开、第 2 轮起关。"""

    observed = _run_two_turn_loop(monkeypatch)

    assert len(observed) >= 2, f"必须真的走两轮才测得到，实际 {observed}"
    assert observed[0] == "provider_default", "第 1 轮要保留推理能力"
    for mode in observed[1:]:
        assert mode == "disabled", f"第 2 轮起应关思考，实际 {observed}"
