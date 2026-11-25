"""微信长轮询线程的可靠性回归。

这三个点各自对应一次线上现象，改动前先读一遍：

1. **客户端复用** — 每轮 ``_client_factory`` 新建 httpx.Client 且从不 close，
   连接池靠循环 GC 才回收，单绑定一天能堆出上千个空转 Client。
2. **错误自愈** — 只在「游标变化」时清 ``last_error``，导致一次偶发 ReadTimeout
   之后只要没人发消息，界面上就永远挂着「最近错误：ReadTimeout」（实测挂了三天）。
3. **心跳可观测** — ``last_seen_at`` 也是只跟着游标动，没人说话就看不出轮询
   到底还活着没有；现在改成按轮次节流刷新，前端据此判断掉线。
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db.models import WechatBinding
from app.wechat import poller as poller_mod
from app.wechat.client import WeChatApiError
from app.wechat.poller import BindingPoller, _failure_code


# ---- fixtures ------------------------------------------------------------


@pytest.fixture()
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    return eng


@pytest.fixture()
def binding_id(engine):
    with Session(engine) as db:
        db.add(
            WechatBinding(
                id="wxbind_poll",
                tenant_id="tenant_t1",
                owner_user_id="user_owner",
                ilink_bot_id="bot_1",
                bot_token_enc="tok_v1",
                base_url="https://ilinkai.weixin.qq.com",
                status="active",
                last_error="ReadTimeout",
            )
        )
        db.commit()
    return "wxbind_poll"


class FakeClient:
    """够用就行的假客户端：只记调用，不发网络请求。"""

    def __init__(self, *, base_url: str, token: str, replies: list[dict] | None = None):
        self.base_url = base_url
        self.token = token
        self.closed = False
        self.calls = 0
        self.replies = list(replies or [])
        self.sent: list[tuple[str, str, str]] = []
        # 由测试驱动：每次 get_updates 抛出队列里的异常（None 表示正常返回）
        self.errors: list[BaseException | None] = []

    def get_updates(self, cursor: str = "", *, timeout_seconds: float = 40.0) -> dict:
        self.calls += 1
        if self.errors:
            err = self.errors.pop(0)
            if err is not None:
                raise err
        if self.replies:
            return self.replies.pop(0)
        return {"get_updates_buf": cursor, "msgs": []}

    def close(self) -> None:
        self.closed = True

    def send_text(self, to_user_id: str, context_token: str, text: str) -> None:
        self.sent.append((to_user_id, context_token, text))


def make_poller(engine, binding_id, *, clients: list[FakeClient], handled=None):
    """装配一个 poller；``clients`` 用来观察「新建了几次客户端」。"""
    queue = list(clients)

    def client_factory(binding: WechatBinding) -> FakeClient:
        if not queue:
            raise AssertionError("client_factory 被调用次数超出预期（疑似没有复用）")
        return queue.pop(0)

    return BindingPoller(
        binding_id,
        db_session_factory=lambda: Session(engine),
        client_factory=client_factory,
        handler=handled or (lambda binding, inbound, client=None: True),
    )


def read(engine, binding_id: str) -> WechatBinding:
    with Session(engine) as db:
        row = db.get(WechatBinding, binding_id)
        assert row is not None
        db.expunge(row)
        return row


# ---- 1. 客户端复用 -------------------------------------------------------


def test_client_is_reused_across_polls(engine, binding_id):
    """连续两轮只用同一个客户端：不许每轮新建（连接池泄漏的根因）。"""
    client = FakeClient(base_url="", token="")
    p = make_poller(engine, binding_id, clients=[client])

    p._poll_once()
    p._poll_once()
    p._poll_once()

    assert client.calls == 3
    assert client.closed is False
    assert p._client is client


def test_client_rebuilt_when_token_changes(engine, binding_id):
    """换绑/重扫码后 token 变了，必须丢掉旧连接（旧 Bearer 只会一直 -14）。"""
    old = FakeClient(base_url="", token="tok_v1")
    new = FakeClient(base_url="", token="tok_v2")
    p = make_poller(engine, binding_id, clients=[old, new])

    p._poll_once()
    assert p._client is old

    with Session(engine) as db:
        row = db.get(WechatBinding, binding_id)
        assert row is not None
        row.bot_token_enc = "tok_v2"
        db.add(row)
        db.commit()

    p._poll_once()
    assert p._client is new
    assert old.closed is True, "旧客户端必须被关掉，否则就是换个 key 继续泄漏"


def test_stop_closes_client(engine, binding_id):
    client = FakeClient(base_url="", token="")
    p = make_poller(engine, binding_id, clients=[client])
    p._poll_once()

    p.stop()

    assert client.closed is True
    assert p._client is None


# ---- 2. 错误自愈 ---------------------------------------------------------


def test_last_error_cleared_on_success_without_cursor_change(engine, binding_id):
    """游标不动（没人发消息）也要清错误——否则一次抖动会挂到天荒地老。"""
    assert read(engine, binding_id).last_error == "ReadTimeout"

    client = FakeClient(base_url="", token="")
    p = make_poller(engine, binding_id, clients=[client])
    p._poll_once()

    row = read(engine, binding_id)
    assert row.last_error == ""
    # 游标没变，不该被写成空
    assert row.updates_cursor == ""


def test_fresh_heartbeat_even_when_cursor_static(engine, binding_id):
    client = FakeClient(base_url="", token="")
    p = make_poller(engine, binding_id, clients=[client])

    assert read(engine, binding_id).last_seen_at is None
    p._poll_once()
    first = read(engine, binding_id).last_seen_at
    assert first is not None


def test_heartbeat_is_throttled(engine, binding_id):
    """节流：窗口内不重复写库，但游标变化时照写。"""
    client = FakeClient(base_url="", token="")
    p = make_poller(engine, binding_id, clients=[client])

    p._poll_once()
    first = read(engine, binding_id).last_seen_at

    # 第二次落在节流窗口内：不刷新心跳
    p._poll_once()
    assert read(engine, binding_id).last_seen_at == first

    # 把上次心跳时间推到窗口外，下一次应刷新
    p._last_heartbeat = 0.0
    p._poll_once()
    assert read(engine, binding_id).last_seen_at != first


def test_cursor_change_bypasses_heartbeat_throttle(engine, binding_id):
    """有消息推进游标时不能被节流挡住——丢了游标就会重放旧消息。"""
    client = FakeClient(
        base_url="",
        token="",
        replies=[{"get_updates_buf": "cursor_v2", "msgs": []}],
    )
    p = make_poller(engine, binding_id, clients=[client])

    p._poll_once()  # 首轮：写心跳 + 空游标
    p._poll_once()  # 次轮：游标变化，即使在节流窗口内也必须落库

    assert read(engine, binding_id).updates_cursor == "cursor_v2"


# ---- 3. 错误码收敛 -------------------------------------------------------


@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (httpx.ReadTimeout("read timed out"), "network_timeout"),
        (httpx.ConnectTimeout("connect timed out"), "network_timeout"),
        (httpx.ConnectError("unreachable"), "network_unreachable"),
        (httpx.RemoteProtocolError("boom"), "network_error"),
    ],
)
def test_failure_code_normalizes_transport_errors(exc, expected):
    """``ReadTimeout`` 这种类名直接怼给用户等于没说，收敛成稳定枚举。"""
    assert _failure_code(exc) == expected


def test_failure_code_keeps_unknown_exceptions_visible():
    """不认识的异常保留类名：排障时至少还能看到现场。"""

    class WeirdError(RuntimeError):
        pass

    assert _failure_code(WeirdError("x")) == "WeirdError"


def test_failure_code_reports_http_status():
    request = httpx.Request("POST", "https://ilinkai.weixin.qq.com/x")
    response = httpx.Response(502, request=request)
    exc = httpx.HTTPStatusError("bad gateway", request=request, response=response)
    assert _failure_code(exc) == "http_502"


# ---- 4. 失败落库 ---------------------------------------------------------


def test_failure_writes_normalized_code(engine, binding_id):
    client = FakeClient(base_url="", token="")
    p = make_poller(engine, binding_id, clients=[client])

    p._on_failure(_failure_code(httpx.ReadTimeout("x")))

    assert read(engine, binding_id).last_error == "network_timeout"


def test_stop_does_not_record_error(engine, binding_id):
    """停机时 close() 会打断在途长轮询，那不算故障：别写脏 last_error。

    否则每次重启服务，所有绑定都会带一条假的错误进页面。
    """
    with Session(engine) as db:
        row = db.get(WechatBinding, binding_id)
        assert row is not None
        row.last_error = ""
        db.add(row)
        db.commit()

    client = FakeClient(base_url="", token="")
    p = make_poller(engine, binding_id, clients=[client])
    p._poll_once()
    p._stop.set()

    # 模拟 stop() 打断在途请求后的异常回灌
    p._on_failure("network_error")

    assert read(engine, binding_id).last_error == ""


def test_stop_interrupts_backoff(engine, binding_id, monkeypatch):
    """``_sleep`` 必须能被 stop 打断，否则 shutdown 会卡满 60s 退避。"""
    # 退避时间拉长，确认 stop 不是靠等
    monkeypatch.setattr(poller_mod, "POLL_BACKOFF_START", 3600.0)

    client = FakeClient(base_url="", token="")
    p = make_poller(engine, binding_id, clients=[client])
    p._poll_once()

    import threading

    timer = threading.Timer(0.05, p.stop)
    timer.start()
    try:
        p._on_failure("network_timeout")  # 内部 sleep 1 小时，stop 会立刻打断
    finally:
        timer.cancel()

    assert p._stop.is_set()


# ---- 5. -14 自愈（2026-11-25 反馈：总要重新扫码）--------------------------
#
# 现场表现：用户隔三差五被要求重新扫码。线上日志给出的决定性证据是
#   「-14 冷却 3600s 第 1/5 次」→「Shutting down」→「凭证已失效，需重新扫码」，
# 计数只有 1/5 却判死了：停机打断了冷却，`_try_recover` 返回 False 被当成
# 「恢复失败达上限」。于是每次重启服务都干掉一条绑定。
#
# 另外两处叠加：`_recovery_failures` 只增不减（与「连续失败」语义不符）、
# 冷却固定 1 小时（> 前端 10 分钟判死窗口，必然劝用户重扫）。


class _ExpiringClient(FakeClient):
    """按脚本吐 -14 / 正常响应；跑够轮数后自己叫停 poller。"""

    def __init__(self, script: list[BaseException | None], *, stop_after: int, poller=None):
        super().__init__(base_url="", token="")
        self._script = list(script)
        self._stop_after = stop_after
        self._poller = poller

    def get_updates(self, cursor: str = "", *, timeout_seconds: float = 40.0) -> dict:
        self.calls += 1
        if self.calls >= self._stop_after and self._poller is not None:
            self._poller._stop.set()
        if self._script:
            err = self._script.pop(0)
            if err is not None:
                raise err
        return {"get_updates_buf": cursor, "msgs": []}


def _session_expired() -> WeChatApiError:
    return WeChatApiError(-14, "session timeout")


def test_recovery_counter_resets_after_a_successful_poll(engine, binding_id, monkeypatch):
    """连续 5 次 -14 之后只要成功一轮，计数就必须归零。

    反向验证：去掉 ``_run`` 里的 ``self._recovery_failures = 0``，序列
    「5 次 -14 → 成功 → 再来一次 -14」会让第 7 轮判定为失效（计数变成 6），
    这条用例就会红。
    """
    monkeypatch.setattr(poller_mod, "RECOVERY_COOLDOWN_START", 0.0)
    monkeypatch.setattr(poller_mod, "RECOVERY_COOLDOWN_MAX", 0.0)
    # 5 次 -14 → 成功一轮（计数必须归零）→ 再来一次 -14 → 恢复重试成功
    script = [_session_expired() for _ in range(5)] + [None, _session_expired(), None]

    p = make_poller(engine, binding_id, clients=[])
    # 第 8 轮是成功响应，在同一轮里置 stop：循环正常退出，而不是在恢复重试途中
    # 被判成「stop 被 set ⇒ 放弃自愈」（那是 stop() 打断的正常路径，不是失效）
    client = _ExpiringClient(script, stop_after=8, poller=p)
    p._client = client
    p._client_key = ("https://ilinkai.weixin.qq.com", "tok_v1")

    p._run()

    row = read(engine, binding_id)
    assert row.status == "active", "偶发 -14 自愈后不该被判成永久失效"
    assert row.last_error == "", "成功那轮已经清过错误"
    assert p._recovery_failures == 0, "成功之后计数必须从 0 重新数"


def test_stop_during_recovery_cooldown_does_not_expire_binding(engine, binding_id, monkeypatch):
    """停机打断 -14 冷却 ≠ 凭证失效。

    这是「总要重新扫码」的真实主因（2026-11-25 线上日志）：
        微信会话过期（-14），冷却 3600s 第 1/5 次 binding=wxbind_xxx
        Shutting down
        微信凭证已失效，需重新扫码 binding=wxbind_xxx
    计数才 1/5，却因为 ``_try_recover`` 里 ``return not self._stop.is_set()``
    返回 False，被 _run 当成「恢复失败达上限」而永久判死。于是**每次重启服务**
    都会把当时正在冷却的绑定干掉，用户重扫完下次重启又中招。
    """
    monkeypatch.setattr(poller_mod, "RECOVERY_COOLDOWN_START", 600.0)

    p = make_poller(engine, binding_id, clients=[])
    client = _ExpiringClient([], stop_after=99, poller=p)
    client._script = [_session_expired()]
    p._client = client
    p._client_key = ("https://ilinkai.weixin.qq.com", "tok_v1")

    import threading

    # 冷却中（600s）时外部叫停，模拟服务重启
    timer = threading.Timer(0.05, p.stop)
    timer.start()
    try:
        p._run()
    finally:
        timer.cancel()

    row = read(engine, binding_id)
    assert row.status == "active", "停机不是凭证失效，不能置 disconnected"
    assert row.last_error != "session_expired_need_rescan"


def test_consecutive_session_expiry_still_marks_expired(engine, binding_id, monkeypatch):
    """自愈不能变成无限重试：连续第 6 次 -14 仍然要判真失效。"""
    monkeypatch.setattr(poller_mod, "RECOVERY_COOLDOWN_START", 0.0)
    monkeypatch.setattr(poller_mod, "RECOVERY_COOLDOWN_MAX", 0.0)
    script = [_session_expired() for _ in range(6)]

    p = make_poller(engine, binding_id, clients=[])
    client = _ExpiringClient(script, stop_after=99, poller=p)
    p._client = client
    p._client_key = ("https://ilinkai.weixin.qq.com", "tok_v1")

    p._run()

    row = read(engine, binding_id)
    assert row.status == "disconnected"
    assert row.last_error == "session_expired_need_rescan"


def test_recovery_cooldown_is_exponential_not_flat(engine, binding_id, monkeypatch):
    """冷却必须退避：固定 1 小时会让偶发 -14 在界面上表现为「掉线」。"""
    slept: list[float] = []
    client = FakeClient(base_url="", token="")
    p = make_poller(engine, binding_id, clients=[client])
    p._sleep = lambda seconds: slept.append(seconds)  # type: ignore[method-assign]

    for _ in range(5):
        assert p._try_recover() is True

    assert slept == [30.0, 60.0, 120.0, 240.0, 300.0], "30s 起翻倍、300s 封顶"
    # 第 6 次直接判死，不再冷却
    assert p._try_recover() is False
    assert len(slept) == 5


def test_recovery_marks_binding_as_recovering(engine, binding_id, monkeypatch):
    """冷却期间要落一个「恢复中」状态：否则前端看到的只有变旧的心跳 → 劝重扫。"""
    monkeypatch.setattr(poller_mod, "RECOVERY_COOLDOWN_START", 600.0)
    client = FakeClient(base_url="", token="")
    p = make_poller(engine, binding_id, clients=[client])
    p._sleep = lambda seconds: None  # type: ignore[method-assign]
    p._last_heartbeat = 0.0

    p._try_recover()

    row = read(engine, binding_id)
    assert row.last_error == "session_recovering"
    # 顺带刷心跳：线程此刻确实活着，不能让它落进 10 分钟判死窗口
    assert row.last_seen_at is not None


def test_successful_poll_clears_recovering_state(engine, binding_id):
    """恢复成功后「恢复中」必须被清掉，否则界面一直停在「正在重连」。"""
    with Session(engine) as db:
        row = db.get(WechatBinding, binding_id)
        assert row is not None
        row.last_error = "session_recovering"
        db.add(row)
        db.commit()

    client = FakeClient(base_url="", token="")
    p = make_poller(engine, binding_id, clients=[client])
    p._poll_once()

    assert read(engine, binding_id).last_error == ""