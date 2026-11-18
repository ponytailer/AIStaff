"""新会话的「开场白」。

口径（产品）：
- 员工档案里配了 `greeting_message` → 新会话落一条 assistant 消息；
- 没配 → 这条链路完全不存在，不产生任何消息；
- 文案格式固定为「你好，{用户显示名}。」换行接正文。
"""

from __future__ import annotations

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.agents.greeting import (
    GREETING_MAX_LENGTH,
    agent_greeting_message,
    greeting_text_for_user,
    maybe_seed_greeting_message,
)
from app.db.models import AgentProfile, ChatSession, Message, Tenant, User
from app.security.auth import hash_password

TENANT = "tenant_demo"
USER_ID = "user_wang"
AGENT_ID = "agent_demo"


def _session() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _seed(
    db: Session,
    *,
    greeting: str | None = "我可以帮你查制度、整理纪要，也可以直接起草邮件。",
    display_name: str | None = "王小名",
) -> tuple[User, AgentProfile]:
    db.add(Tenant(id=TENANT, name="Demo"))
    user = User(
        id=USER_ID,
        tenant_id=TENANT,
        username="wangxm",
        display_name=display_name,
        password_hash=hash_password("secret"),
    )
    db.add(user)
    metadata = {"greeting_message": greeting} if greeting is not None else {}
    agent = AgentProfile(
        id=AGENT_ID,
        tenant_id=TENANT,
        name="小艾",
        status="active",
        metadata_json=metadata,
    )
    db.add(agent)
    db.commit()
    return user, agent


def _new_session(db: Session, *, channel: str | None = None) -> ChatSession:
    row = ChatSession(
        id="session_1",
        tenant_id=TENANT,
        user_id=USER_ID,
        agent_id=AGENT_ID,
        channel=channel,
    )
    db.add(row)
    db.flush()
    return row


def _messages(db: Session) -> list[Message]:
    return list(
        db.exec(
            select(Message)
            .where(Message.tenant_id == TENANT, Message.session_id == "session_1")
            .order_by(Message.created_at)
        ).all()
    )


def test_seeds_a_greeting_message_in_the_configured_format() -> None:
    db = _session()
    _seed(db)
    chat_session = _new_session(db)

    message = maybe_seed_greeting_message(db, chat_session)
    db.commit()

    assert message is not None
    assert message.role == "assistant"
    # 格式是硬约定：第一行「你好，显示名。」，第二行起才是正文。
    assert message.content.split("\n", 1)[0] == "你好，王小名。"
    assert message.content.split("\n", 1)[1] == "我可以帮你查制度、整理纪要，也可以直接起草邮件。"
    assert message.metadata_json.get("greeting") is True


def test_no_greeting_configured_produces_no_message() -> None:
    db = _session()
    _seed(db, greeting=None)
    chat_session = _new_session(db)

    assert maybe_seed_greeting_message(db, chat_session) is None
    db.commit()
    assert _messages(db) == []


def test_blank_greeting_is_treated_as_not_configured() -> None:
    # 配置端把输入框清空后可能留下空白串，不能因此发一条「你好，王小名。」+
    # 空正文的半截问候。
    db = _session()
    _seed(db, greeting="   \n  ")
    chat_session = _new_session(db)

    assert maybe_seed_greeting_message(db, chat_session) is None


def test_seeding_is_idempotent_once_the_session_has_messages() -> None:
    # 三个建会话入口可能先后调到；第二个调用必须安静退出，不能在对话中间
    # 再插一条迟到的问候。
    db = _session()
    _seed(db)
    chat_session = _new_session(db)
    assert maybe_seed_greeting_message(db, chat_session) is not None
    db.add(
        Message(
            tenant_id=TENANT,
            session_id=chat_session.id,
            role="user",
            content="帮我查一下报销标准",
        )
    )
    db.commit()

    assert maybe_seed_greeting_message(db, chat_session) is None
    db.commit()
    assert len(_messages(db)) == 2


def test_greeting_is_skipped_for_skill_test_channels() -> None:
    # 技能调试会话要的是 harness 原始行为，多一条寒暄会污染调试视图。
    db = _session()
    _seed(db)
    chat_session = _new_session(db, channel="skill_test")

    assert maybe_seed_greeting_message(db, chat_session) is None


def test_falls_back_to_username_when_display_name_is_missing() -> None:
    db = _session()
    _seed(db, display_name=None)
    chat_session = _new_session(db)

    message = maybe_seed_greeting_message(db, chat_session)
    db.commit()

    assert message is not None
    assert message.content.startswith("你好，wangxm。")


def test_greeting_still_sent_when_the_user_row_is_gone() -> None:
    # 分享访客 / 历史脏数据可能没有 user 行；这时宁可少半句也不出「你好，None。」。
    db = _session()
    _seed(db)
    chat_session = _new_session(db)
    chat_session.user_id = "user_missing"

    message = maybe_seed_greeting_message(db, chat_session)
    db.commit()

    assert message is not None
    assert message.content.startswith("你好。\n")


def test_greeting_text_helper_clamps_and_trims() -> None:
    assert greeting_text_for_user("  正文  ", "   ") == "你好。\n正文"
    assert greeting_text_for_user("", "王小名") == ""


def test_agent_greeting_message_clips_over_long_values() -> None:
    # 库里可能残留远超上限的值（导入 / 早期没有校验），读取侧必须截断。
    agent = AgentProfile(
        id=AGENT_ID,
        tenant_id=TENANT,
        name="小艾",
        status="active",
        metadata_json={"greeting_message": "长" * (GREETING_MAX_LENGTH + 200)},
    )
    assert len(agent_greeting_message(agent)) == GREETING_MAX_LENGTH


def test_agent_greeting_message_ignores_non_string_values() -> None:
    agent = AgentProfile(
        id=AGENT_ID,
        tenant_id=TENANT,
        name="小艾",
        status="active",
        metadata_json={"greeting_message": ["数组不是文本"]},
    )
    assert agent_greeting_message(agent) == ""