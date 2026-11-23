"""每个微信绑定的长轮询线程。

iLink 的 ``getupdates`` 是长轮询（服务端最多 hold ~35s 才返回），没有 webhook。
所以每个 active 绑定需要一个常驻线程持续拉取。

可靠性策略（全部来自实战教训，别随手调小）：

- **游标持久化** — ``get_updates_buf`` 存库，进程重启后从断点续，不重放旧消息。
- **连接复用** — 一个绑定一个长生命周期 ``httpx.Client``，凭证变了才重建。
  每轮新建会泄漏连接池（httpcore 的池没有 ``__del__``），并让每轮多一次 TLS 握手。
- **指数退避** — 2s 起、翻倍到 60s 封顶。腾讯保留限速权，退避上限不能太低。
- **连续失败熔断** — 连败 5 次暂停 5 分钟，避免把临时故障放大成持续压测。
- **-14 自愈** — 该错误码是「会话过期」，官方插件的做法是冷却后用原 token
  重试；连续恢复失败达到上限才判定为真失效（置 disconnected，等重新扫码）。
- **心跳可观测** — 每轮成功都清 ``last_error``，并按 ``POLL_HEARTBEAT_SECONDS``
  节流刷新 ``last_seen_at``。前端靠它区分「刚抖了一下」和「已经掉线」。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Optional

import httpx
from sqlmodel import Session, select

from app.db.models import WechatBinding, utc_now
from app.wechat.client import WeChatApiError, WeChatClient, normalize_inbound_message

logger = logging.getLogger(__name__)

POLL_BACKOFF_START = 2.0
POLL_BACKOFF_MAX = 60.0
POLL_FAILURE_CIRCUIT_THRESHOLD = 5
POLL_FAILURE_CIRCUIT_SECONDS = 300.0
#: 心跳落库节流。长轮询本身 35s 一轮，每轮写库没必要；但也不能太稀，
#: 前端就是靠 ``last_seen_at`` 判断「这条绑定的轮询还活着吗」（10 分钟判死）。
POLL_HEARTBEAT_SECONDS = 60.0
SESSION_EXPIRED_ERRCODE = -14
RECOVERY_COOLDOWN_SECONDS = 3600.0
RECOVERY_MAX_FAILURES = 5

_threads: dict[str, "BindingPoller"] = {}
_guard = threading.Lock()


def _failure_code(exc: BaseException) -> str:
    """把异常收敛成前端能看懂的一小撮错误码。

    ``type(exc).__name__`` 会写出 ``ReadTimeout`` 这种给人看的半成品：用户不知道
    该做什么，也不知道严不严重。这里归一成稳定枚举，文案交给前端。
    """
    name = type(exc).__name__
    if isinstance(exc, httpx.TimeoutException):
        # ConnectTimeout / ReadTimeout / WriteTimeout / PoolTimeout 都是同一类：
        # 长轮询下绝大多数是「服务端这次没在窗口内回」，下一轮就好。
        return "network_timeout"
    if isinstance(exc, httpx.ConnectError):
        return "network_unreachable"
    if isinstance(exc, httpx.HTTPStatusError):
        return f"http_{exc.response.status_code}"
    if isinstance(exc, httpx.HTTPError):
        return "network_error"
    return name


class BindingPoller:
    """一个绑定的轮询循环。``stop()`` 后线程在下一轮退出。"""

    def __init__(
        self,
        binding_id: str,
        *,
        db_session_factory: Callable[[], Session],
        client_factory: Callable[[WechatBinding], WeChatClient],
        handler: Callable[..., bool],
    ) -> None:
        self.binding_id = binding_id
        self._db = db_session_factory
        self._client_factory = client_factory
        self._handler = handler
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._failures = 0
        self._recovery_failures = 0
        # 复用的客户端。每轮新建 httpx.Client 会泄漏连接池（httpcore 的池没有
        # __del__，SSL socket 还构成引用环，只能等循环 GC），单绑定一天能堆出
        # 上千个空转 Client；同时每轮重做一次 TLS 握手也更容易踩到 ReadTimeout。
        self._client: WeChatClient | None = None
        self._client_key: tuple[str, str] = ("", "")
        # 心跳上次落库的时间（time.monotonic，不受系统时钟调整影响）
        self._last_heartbeat = 0.0

    # ---- 生命周期 --------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name=f"wechat-poller-{self.binding_id}",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)
        self._close_client()

    def _close_client(self) -> None:
        client, self._client = self._client, None
        self._client_key = ("", "")
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001 - 关连接失败不该让线程退出路径报错
                logger.debug("关闭微信客户端失败 binding=%s", self.binding_id, exc_info=True)

    def _get_client(self, binding: WechatBinding) -> WeChatClient:
        """按 (base_url, token) 复用客户端；凭证变了才重建。

        换绑/重扫码后 token 与 base_url 可能变，旧连接带着旧 Bearer 只会一直
        401/-14，所以 key 一变就丢掉重建，而不是继续复用。
        """
        key = (binding.base_url, binding.bot_token_enc)
        if self._client is not None and self._client_key == key:
            return self._client
        self._close_client()
        self._client = self._client_factory(binding)
        self._client_key = key
        return self._client

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ---- 主循环 ----------------------------------------------------

    def _run(self) -> None:
        logger.info("微信长轮询启动 binding=%s", self.binding_id)
        try:
            while not self._stop.is_set():
                try:
                    self._poll_once()
                    self._failures = 0
                except WeChatApiError as exc:
                    if exc.code == SESSION_EXPIRED_ERRCODE and self._try_recover():
                        continue
                    if exc.code == SESSION_EXPIRED_ERRCODE:
                        self._mark_expired()
                        return
                    self._on_failure(f"api_error:{exc.code}")
                except Exception as exc:  # noqa: BLE001 - 线程不能因为单次异常退出
                    logger.warning("微信轮询异常 binding=%s: %s", self.binding_id, exc, exc_info=True)
                    self._on_failure(_failure_code(exc))
        finally:
            self._close_client()
            logger.info("微信长轮询退出 binding=%s", self.binding_id)

    def _poll_once(self) -> None:
        with self._db() as db:
            binding = db.get(WechatBinding, self.binding_id)
            if binding is None or binding.status != "active":
                self._stop.set()
                return
            cursor = binding.updates_cursor
            client = self._get_client(binding)

        result = client.get_updates(cursor)
        new_cursor = str(result.get("get_updates_buf") or "")
        messages = list(result.get("msgs") or [])

        # 本轮能拿到响应就算「活着」，不管游标有没有变。
        # 之前只在游标变化时清 last_error：一次偶发 ReadTimeout 之后，只要没人
        # 发消息（游标不动）这条错误就永远挂着，界面上分不清「刚抖了一下」和
        # 「已经死了三天」（2026-11-23 实际就是这么挂着的）。
        self._record_success(new_cursor if new_cursor != cursor else None)

        for raw in messages:
            if self._stop.is_set():
                return
            inbound = normalize_inbound_message(raw)
            if inbound is None:
                # 非文本消息（图片/文件）：先回一句提示，不静默丢弃
                self._notify_unsupported(raw, client)
                continue
            try:
                self._handler(binding, inbound, client=client)
            except Exception:  # noqa: BLE001 - 单条失败不影响后续消息
                logger.exception("微信消息处理失败 binding=%s", self.binding_id)

    def _record_success(self, new_cursor: str | None) -> None:
        """记一次成功的拉取：推进游标、清错误、按节流刷心跳。"""
        now = time.monotonic()
        heartbeat_due = now - self._last_heartbeat >= POLL_HEARTBEAT_SECONDS
        if new_cursor is None and not heartbeat_due:
            return
        with self._db() as db:
            row = db.get(WechatBinding, self.binding_id)
            if row is None:
                return
            if new_cursor is not None:
                row.updates_cursor = new_cursor
            row.last_seen_at = utc_now()
            row.last_error = ""
            db.add(row)
            db.commit()
        self._last_heartbeat = now

    def _notify_unsupported(self, raw: dict, client: WeChatClient | None = None) -> None:
        """图片/文件消息暂不支持，明确告知而不是当成没收到。"""
        from_user = str(raw.get("from_user_id") or "").strip()
        context_token = str(raw.get("context_token") or "").strip()
        if not from_user or not context_token:
            return
        try:
            if client is None:
                with self._db() as db:
                    binding = db.get(WechatBinding, self.binding_id)
                    if binding is None:
                        return
                    client = self._get_client(binding)
            client.send_text(
                from_user,
                context_token,
                "目前只支持文字消息，图片和文件还不能处理。可以直接把需求打成文字发我。",
            )
        except Exception:  # noqa: BLE001
            logger.debug("微信不支持消息提示发送失败", exc_info=True)

    # ---- 故障处理 --------------------------------------------------

    def _on_failure(self, reason: str) -> None:
        # 停机时 close() 会打断在途请求，那不算故障，别把它写成 last_error
        if self._stop.is_set():
            return
        self._failures += 1
        with self._db() as db:
            row = db.get(WechatBinding, self.binding_id)
            if row is not None:
                row.last_error = reason[:200]
                db.add(row)
                db.commit()

        if self._failures >= POLL_FAILURE_CIRCUIT_THRESHOLD:
            logger.warning(
                "微信轮询连续失败 %s 次，熔断 %.0fs binding=%s",
                self._failures, POLL_FAILURE_CIRCUIT_SECONDS, self.binding_id,
            )
            self._sleep(POLL_FAILURE_CIRCUIT_SECONDS)
            self._failures = 0
            return

        backoff = min(POLL_BACKOFF_START * (2 ** (self._failures - 1)), POLL_BACKOFF_MAX)
        self._sleep(backoff)

    def _try_recover(self) -> bool:
        """-14 自愈：冷却后原 token 重试一次；连续失败到上限返回 False。"""
        self._recovery_failures += 1
        if self._recovery_failures > RECOVERY_MAX_FAILURES:
            return False
        logger.warning(
            "微信会话过期（-14），冷却 %.0fs 后用原 token 重试（第 %s/%s 次） binding=%s",
            RECOVERY_COOLDOWN_SECONDS, self._recovery_failures, RECOVERY_MAX_FAILURES, self.binding_id,
        )
        self._sleep(RECOVERY_COOLDOWN_SECONDS)
        return not self._stop.is_set()

    def _mark_expired(self) -> None:
        logger.error("微信凭证已失效，需重新扫码 binding=%s", self.binding_id)
        with self._db() as db:
            row = db.get(WechatBinding, self.binding_id)
            if row is not None:
                row.status = "disconnected"
                row.last_error = "session_expired_need_rescan"
                row.updated_at = utc_now()
                db.add(row)
                db.commit()

    def _sleep(self, seconds: float) -> None:
        # 用 Event.wait 而不是 time.sleep：stop() 能立刻打断退避/冷却
        self._stop.wait(seconds)


# ---- 全局管理 ------------------------------------------------------------


def start(binding_id: str, **kwargs) -> BindingPoller:
    with _guard:
        poller = _threads.get(binding_id)
        if poller is None or not poller.running:
            poller = BindingPoller(binding_id, **kwargs)
            _threads[binding_id] = poller
            poller.start()
        return poller


def stop(binding_id: str) -> None:
    with _guard:
        poller = _threads.pop(binding_id, None)
    if poller is not None:
        poller.stop()


def stop_all() -> None:
    with _guard:
        pollers = list(_threads.items())
        _threads.clear()
    for _, poller in pollers:
        poller.stop()


def running_ids() -> list[str]:
    with _guard:
        return [bid for bid, poller in _threads.items() if poller.running]


def start_all_active(db_session_factory, client_factory, handler) -> int:
    """启动时拉起所有 active 绑定。返回启动数量。"""
    with db_session_factory() as db:
        rows = db.exec(select(WechatBinding).where(WechatBinding.status == "active")).all()
        ids = [row.id for row in rows]
    for binding_id in ids:
        start(
            binding_id,
            db_session_factory=db_session_factory,
            client_factory=client_factory,
            handler=handler,
        )
    return len(ids)