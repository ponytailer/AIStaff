"""会话附件下载接口的路由层测试。

沿用 test_ai_review_api.py 的做法：路由函数直接以「内存 SQLite + 显式
current_user」调用，不建 lifespan、不连远程 PG。

覆盖的核心风险：附件字节按 (tenant, **uploader**, attachment_id) 寻址，
而下载的人是会话属主、上传的人可能是 owner（人工回复带的附件），两者不同
就要能读到；同时必须挡住「拿着别的会话的 attachment_id 横向读取」。
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.api.chat import download_chat_attachment
from app.db.models import ChatSession, HumanHandoffRequest, Message, Tenant, User
from app.session.attachment_store import stage_chat_attachment
from app.session.attachments import parse_chat_attachment
from app.session.session_schema import ChatAttachmentRead

TENANT = "tenant_attachment_test"


def _session() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _seed(db: Session, *, session_user_id: str = "user_owner") -> tuple[User, User, ChatSession]:
    """造一个租户、一个会话属主用户、一个客服用户和一条会话。"""

    db.add(Tenant(id=TENANT, name="Attachment Test"))
    owner = User(id=session_user_id, tenant_id=TENANT, username=owner_name(session_user_id), password_hash="x")
    agent_side = User(id="user_support", tenant_id=TENANT, username="support", password_hash="x")
    chat_session = ChatSession(id="session_att", tenant_id=TENANT, user_id=session_user_id)
    db.add(owner)
    db.add(agent_side)
    db.add(chat_session)
    db.commit()
    return owner, agent_side, chat_session


def owner_name(user_id: str) -> str:
    return "owner" if user_id == "user_owner" else user_id


def _stage(db: Session, *, filename: str, content_type: str, data: bytes, uploader: str) -> ChatAttachmentRead:
    """按真实上传链路落一份字节到暂存目录，返回描述符。"""

    attachment = parse_chat_attachment(filename, content_type, data, extract_text=False)
    return stage_chat_attachment(attachment, data, tenant_id=TENANT, user_id=uploader)


def _user_message(db: Session, session_id: str, attachment: ChatAttachmentRead) -> Message:
    row = Message(
        tenant_id=TENANT,
        session_id=session_id,
        role="user",
        content="看附件",
        metadata_json={"attachments": [attachment.model_dump(mode="json")]},
    )
    db.add(row)
    db.commit()
    return row


def _read_body(response) -> bytes:
    """StreamingResponse 的 body_iterator 是 async generator，用 asyncio 收起来。"""

    async def collect() -> bytes:
        chunks: list[bytes] = []
        async for chunk in response.body_iterator:
            chunks.append(chunk if isinstance(chunk, bytes) else str(chunk).encode())
        return b"".join(chunks)

    return asyncio.run(collect())


# ---------------------------------------------------------------------------
# 正常路径
# ---------------------------------------------------------------------------


def test_downloads_attachment_uploaded_by_session_owner() -> None:
    """用户自己发的附件：上传者就是会话属主，应能取回原字节。"""

    db = _session()
    owner, _support, chat_session = _seed(db)
    payload = b"finance-report-bytes"
    attachment = _stage(db, filename="报表.xlsx", content_type="application/octet-stream", data=payload, uploader=owner.id)
    _user_message(db, chat_session.id, attachment)

    response = download_chat_attachment(
        session_id=chat_session.id,
        attachment_id=attachment.id,
        tenant_id=TENANT,
        current_user=owner,
        db=db,
    )

    assert _read_body(response) == payload
    # media_type 由文件名后缀推断（xlsx 有自己的类型），不硬编码 octet-stream
    assert response.media_type
    # 非图片一律当附件下载，文件名同时给 ASCII 兜底与 UTF-8 原名
    disposition = response.headers["Content-Disposition"]
    assert disposition.startswith("attachment; ")
    assert "filename*=UTF-8''" in disposition


def test_downloads_human_reply_attachment_uploaded_by_owner() -> None:
    """人工回复带的附件：上传者是客服，下载者是会话属主。

    这正是线上「人工回了附件但用户下载不到」的场景：字节存在客服名下，
    用会话属主身份直接读会读不到，必须按 uploader 候选依次尝试。
    """

    db = _session()
    owner, support, chat_session = _seed(db)
    payload = b"docx-bytes-from-support"
    attachment = _stage(
        db,
        filename="未命名文档.docx",
        content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        data=payload,
        uploader=support.id,
    )
    # 人工回复投影成的消息（user 角色 + human_reply 标记）
    db.add(
        Message(
            tenant_id=TENANT,
            session_id=chat_session.id,
            role="user",
            content="参考文档",
            metadata_json={
                "human_reply": True,
                "handoff_id": "handoff_1",
                "attachments": [attachment.model_dump(mode="json")],
            },
        )
    )
    # handoff 上也要留着 reply_attachments，并记下 answered_by_user_id
    db.add(
        HumanHandoffRequest(
            id="handoff_1",
            tenant_id=TENANT,
            session_id=chat_session.id,
            requester_user_id=owner.id,
            status="answered",
            resume_payload_json={"answered_by_user_id": support.id},
            metadata_json={"reply_attachments": [attachment.model_dump(mode="json")]},
        )
    )
    db.commit()

    response = download_chat_attachment(
        session_id=chat_session.id,
        attachment_id=attachment.id,
        tenant_id=TENANT,
        current_user=owner,
        db=db,
    )

    assert _read_body(response) == payload


def test_image_attachment_is_inline_so_it_opens_in_browser() -> None:
    """图片默认 inline：点开就能看，不必先下载到本地。"""

    db = _session()
    owner, _support, chat_session = _seed(db)
    png = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 16
    attachment = _stage(db, filename="截图.png", content_type="image/png", data=png, uploader=owner.id)
    _user_message(db, chat_session.id, attachment)

    response = download_chat_attachment(
        session_id=chat_session.id,
        attachment_id=attachment.id,
        tenant_id=TENANT,
        current_user=owner,
        db=db,
    )

    assert _read_body(response) == png
    assert response.media_type == "image/png"
    assert response.headers["Content-Disposition"].startswith("inline; ")


# ---------------------------------------------------------------------------
# 权限与边界
# ---------------------------------------------------------------------------


def test_rejects_attachment_from_another_session() -> None:
    """拿着别的会话的 attachment_id 不能横向读取。"""

    db = _session()
    owner, _support, chat_session = _seed(db)
    payload = b"secret"
    foreign = _stage(db, filename="别的会话.txt", content_type="text/plain", data=payload, uploader=owner.id)
    # 另一个会话里才有这份附件，当前会话没有
    other = ChatSession(id="session_other", tenant_id=TENANT, user_id=owner.id)
    db.add(other)
    db.commit()
    _user_message(db, other.id, foreign)

    with pytest.raises(HTTPException) as raised:
        download_chat_attachment(
            session_id=chat_session.id,
            attachment_id=foreign.id,
            tenant_id=TENANT,
            current_user=owner,
            db=db,
        )
    assert raised.value.status_code == 404


def test_rejects_unknown_attachment_id() -> None:
    db = _session()
    owner, _support, chat_session = _seed(db)

    with pytest.raises(HTTPException) as raised:
        download_chat_attachment(
            session_id=chat_session.id,
            attachment_id="att_missing",
            tenant_id=TENANT,
            current_user=owner,
            db=db,
        )
    assert raised.value.status_code == 404


def test_rejects_session_the_user_cannot_open() -> None:
    """看不到会话的人，也拿不到其中的附件（与打开会话同一套权限）。"""

    db = _session()
    _owner, _support, chat_session = _seed(db)
    stranger = User(id="user_stranger", tenant_id=TENANT, username="stranger", password_hash="x")
    db.add(stranger)
    db.commit()
    attachment = _stage(db, filename="a.txt", content_type="text/plain", data=b"x", uploader="user_owner")
    _user_message(db, chat_session.id, attachment)

    with pytest.raises(HTTPException) as raised:
        download_chat_attachment(
            session_id=chat_session.id,
            attachment_id=attachment.id,
            tenant_id=TENANT,
            current_user=stranger,
            db=db,
        )
    assert raised.value.status_code == 404


def test_missing_staged_bytes_returns_404_instead_of_500() -> None:
    """描述符在库里但暂存字节已被清理：404，不能让接口 500。"""

    db = _session()
    owner, _support, chat_session = _seed(db)
    # 只造描述符，不落字节
    orphan = ChatAttachmentRead(
        id="att_orphan",
        filename="已清理.pdf",
        content_type="application/pdf",
        size=123,
        kind="pdf",
        sha256="b" * 64,
    )
    _user_message(db, chat_session.id, orphan)

    with pytest.raises(HTTPException) as raised:
        download_chat_attachment(
            session_id=chat_session.id,
            attachment_id=orphan.id,
            tenant_id=TENANT,
            current_user=owner,
            db=db,
        )
    assert raised.value.status_code == 404