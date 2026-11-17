"""答案尾部动作（「转人工」按钮）的判定规则。"""

from __future__ import annotations

from app.core.engine.message_actions import offers_human_handoff, suggested_actions


def test_detects_offer_to_handoff() -> None:
    reply = (
        "我这边暂时没有查到报销流程的相关资料，无法给你准确的步骤。"
        "如果你需要，我也可以帮你转接人工同事跟进这个问题。"
    )
    assert offers_human_handoff(reply) is True
    assert suggested_actions(reply, handoff_pending=False) == [
        {"type": "handoff", "label": "转人工", "text": "转人工"}
    ]


def test_no_action_when_handoff_already_pending() -> None:
    """真的转过去了就不要再给按钮，否则用户点一下重复建单。"""

    assert suggested_actions("已为你转接人工客服，请稍候。", handoff_pending=True) == []


def test_no_action_for_declining_wording() -> None:
    assert offers_human_handoff("当前流程可以自助完成，无需转人工。") is False
    assert offers_human_handoff("我无法转人工，请联系管理员。") is False


def test_no_action_for_plain_answers() -> None:
    assert suggested_actions("报销流程是先在 OA 提交单据，再由财务审批。", handoff_pending=False) == []
    assert suggested_actions("", handoff_pending=False) == []


def test_matches_alternative_wording() -> None:
    assert offers_human_handoff("需要的话我可以帮你转人工客服处理") is True
    assert offers_human_handoff("可以联系人工坐席进一步核实") is True
