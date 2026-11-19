from app.core.base.conversation_context import (
    ConversationContextSettings,
    build_conversation_context,
)


def test_conversation_context_keeps_full_history_under_budget() -> None:
    messages = [
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": "您好"},
        {"role": "user", "content": "我是 hx，我要买 A2"},
        {"role": "assistant", "content": "请问买几个？"},
        {"role": "user", "content": "买两个"},
    ]

    context = build_conversation_context(messages, token_budget=1_000)

    assert context["messages"] == messages
    assert context["metadata"]["compacted"] is False
    assert context["metadata"]["total_messages"] == 5
    assert context["metadata"]["omitted_messages"] == 0


def test_conversation_context_compacts_only_after_budget_is_exceeded() -> None:
    messages = [
        {"role": "user", "content": f"old user message {index} " + "x" * 80}
        if index % 2 == 0
        else {"role": "assistant", "content": f"old assistant message {index} " + "y" * 80}
        for index in range(20)
    ]

    context = build_conversation_context(messages, token_budget=500)
    projected = context["messages"]

    assert context["metadata"]["compacted"] is True
    assert context["metadata"]["omitted_messages"] > 0
    assert projected[0]["role"] == "user"
    assert "历史的信息可以被总结为" in projected[0]["content"]
    assert "近期的历史信息总结为" in projected[1]["content"]
    assert projected[-1]["content"] == messages[-1]["content"]
    assert context["metadata"]["estimated_tokens"] <= 500


def test_context_rotates_medium_history_into_long_history_on_next_threshold() -> None:
    messages = [
        {
            "id": f"message_{index}",
            "role": "user" if index % 2 == 0 else "assistant",
            "content": f"round {index} " + ("中" * 120),
            "created_at": f"2026-07-13T12:{index:02d}:00",
        }
        for index in range(20)
    ]
    summaries: list[tuple[str, str]] = []

    def summarize(label: str, source: str, _budget: int) -> str:
        summaries.append((label, source))
        return f"{label}摘要：{source[:120]}"

    first = build_conversation_context(
        messages, token_budget=700, summary_builder=summarize
    )
    first_state = first["context_state"]

    assert first_state["compaction_count"] == 1
    assert first_state["long_term_summary"] == ""
    assert first_state["medium_term_summary"].startswith("近期历史信息摘要")
    assert first["messages"][0]["content"].startswith("历史的信息可以被总结为：")
    assert first["messages"][1]["content"].startswith("近期的历史信息总结为：")

    more_messages = [
        *messages,
        *[
            {
                "id": f"message_{index}",
                "role": "user" if index % 2 == 0 else "assistant",
                "content": f"new round {index} " + ("新" * 120),
                "created_at": f"2026-07-13T13:{index - 20:02d}:00",
            }
            for index in range(20, 36)
        ],
    ]
    second = build_conversation_context(
        more_messages,
        token_budget=700,
        context_state=first_state,
        summary_builder=summarize,
    )
    second_state = second["context_state"]

    assert second_state["compaction_count"] == 2
    assert second_state["long_term_summary"].startswith("长期历史信息摘要")
    assert first_state["medium_term_summary"] in summaries[-2][1]
    assert second_state["medium_term_summary"].startswith("近期历史信息摘要")
    assert second["metadata"]["current_turn_time"] == "2026-07-13T13:15:00"
    assert second["metadata"]["estimated_tokens"] <= 700


def test_conversation_context_uses_runtime_compaction_settings() -> None:
    messages = [
        {
            "id": f"message_{index}",
            "role": "user" if index % 2 == 0 else "assistant",
            "content": f"message {index} " + ("内容" * 80),
        }
        for index in range(12)
    ]
    summary_budgets: list[int] = []

    def summarize(_label: str, source: str, budget: int) -> str:
        summary_budgets.append(budget)
        return source

    settings = ConversationContextSettings(
        token_budget=1_000,
        compaction_trigger_ratio=0.20,
        recent_round_limit=1,
        long_summary_token_budget=160,
        medium_summary_token_budget=180,
        allowed_roles=frozenset({"user"}),
        long_summary_prefix="长期上下文：",
        medium_summary_prefix="近期上下文：",
    )
    context = build_conversation_context(
        messages,
        settings=settings,
        summary_builder=summarize,
    )

    assert context["metadata"]["token_budget"] == 1_000
    assert context["metadata"]["compaction_trigger_ratio"] == 0.20
    assert context["metadata"]["compaction_trigger_tokens"] == 200
    assert context["metadata"]["recent_round_limit"] == 1
    assert context["metadata"]["long_summary_token_budget"] == 160
    assert context["metadata"]["medium_summary_token_budget"] == 180
    assert context["metadata"]["allowed_roles"] == ["user"]
    assert context["metadata"]["long_summary_prefix"] == "长期上下文："
    assert context["metadata"]["medium_summary_prefix"] == "近期上下文："
    assert all(message["role"] == "user" for message in context["messages"])
    assert context["messages"][0]["content"].startswith("长期上下文：")
    assert context["messages"][1]["content"].startswith("近期上下文：")
    assert summary_budgets == [180]


def test_conversation_context_compacts_assistant_only_history() -> None:
    context = build_conversation_context(
        [
            {
                "id": f"assistant_{index}",
                "role": "assistant",
                "content": f"assistant message {index} " + ("内容" * 80),
            }
            for index in range(8)
        ],
        settings=ConversationContextSettings(
            token_budget=600,
            compaction_trigger_ratio=0.20,
            recent_round_limit=2,
            long_summary_token_budget=128,
            medium_summary_token_budget=128,
            allowed_roles=frozenset({"assistant"}),
        ),
    )

    assert context["metadata"]["compacted_now"] is True
    assert context["metadata"]["allowed_roles"] == ["assistant"]
    assert context["context_state"]["summarized_through_message_id"] == "assistant_5"
    assert [message["role"] for message in context["messages"][-2:]] == [
        "assistant",
        "assistant",
    ]


# ---------------------------------------------------------------------------
# 图片成本计入预算
# ---------------------------------------------------------------------------
# 背景：此前 `_message_tokens` 只算 role + content，`images` 记为 0 token。
# 一张 100KB 截图的 base64 约 13.7 万字符，在预算表里却是 0 —— 于是
# `compact_conversation_context` 的 `estimated_tokens <= budget` 提前返回，
# 裁剪对图片永不触发。下面两个用例锁住「图片必须进入预算」这条契约。


def _image_message(message_id: str, text: str = "看这张截图") -> dict:
    return {
        "id": message_id,
        "role": "user",
        "content": text,
        "images": [
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64," + "A" * 4_000},
            }
        ],
    }


def test_image_counts_towards_token_budget() -> None:
    """纯文本版与带图版的消息数、文本完全相同，预算估算必须不同。"""

    text_only = [
        {"id": "m1", "role": "user", "content": "看这张截图"},
        {"id": "m2", "role": "assistant", "content": "好的"},
    ]
    with_image = [dict(text_only[0], images=_image_message("m1")["images"]), text_only[1]]

    plain = build_conversation_context(text_only, token_budget=100_000)
    imaging = build_conversation_context(with_image, token_budget=100_000)

    plain_tokens = plain["metadata"]["estimated_tokens"]
    image_tokens = imaging["metadata"]["estimated_tokens"]
    assert image_tokens > plain_tokens, (
        f"图片必须计入预算：带图 {image_tokens} 应大于纯文本 {plain_tokens}"
    )
    # 每张图按 IMAGE_TOKEN_ESTIMATE 折算，差值应正好是一张图的成本。
    assert image_tokens - plain_tokens == 1_000


def test_images_can_trigger_compaction_that_text_alone_would_not() -> None:
    """关键回归：预算刚好卡在文本量之上时，图片必须让它触发压缩。

    这正是线上场景 —— est_tokens 报 792（只有文本），实际出站 14 万字符。
    """

    messages = [
        _image_message(f"msg_{index}", f"第 {index} 轮追问")
        for index in range(4)
    ]
    text_only = [dict(message, images=[]) for message in messages]

    # 8000 token 预算：纯文本（4 条短消息）远远够用，但 4 张图共 4000 token
    # 会把它推到触发线附近。
    budget = 8_000
    plain = build_conversation_context(text_only, token_budget=budget)
    imaging = build_conversation_context(messages, token_budget=budget)

    assert plain["metadata"]["compacted"] is False, "纯文本不该触发压缩"
    assert imaging["metadata"]["estimated_tokens"] > plain["metadata"][
        "estimated_tokens"
    ]
    # 4 张图 = 4000 token，必须原样体现在估算里（而不是被当成 0）。
    assert (
        imaging["metadata"]["estimated_tokens"]
        - plain["metadata"]["estimated_tokens"]
        == 4_000
    )


def test_image_estimate_ignores_malformed_entries() -> None:
    """`images` 是本模块约定的轻量结构，非 image_url part 不参与估算。"""

    messages = [
        {
            "id": "m1",
            "role": "user",
            "content": "你好",
            "images": [
                {"type": "text", "text": "这不是图片"},
                {"no_type": True},
                "裸字符串",
            ],
        }
    ]

    context = build_conversation_context(messages, token_budget=100_000)
    baseline = build_conversation_context(
        [{"id": "m1", "role": "user", "content": "你好"}], token_budget=100_000
    )

    assert (
        context["metadata"]["estimated_tokens"]
        == baseline["metadata"]["estimated_tokens"]
    )
