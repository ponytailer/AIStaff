"""只读诊断：拆解每轮对话的模型调用耗时，并盯住「图片有没有被重复付费」。

用法：
    cd backend && .venv/bin/python scripts/diagnose_planner_latency.py
    cd backend && .venv/bin/python scripts/diagnose_planner_latency.py --turn <turn_id>
    cd backend && .venv/bin/python scripts/diagnose_planner_latency.py --limit 5

只读 SELECT，不写任何数据。

## 这一版修掉的两个盲区

**① `payload_chars` 少报数十倍。**
该字段在 ``client.py:_request_shape_metrics`` 里算，输入是**已脱敏**的
``serialized_payload``——base64 图片在那之前就被替换成了
``[data:image/png payload omitted; base64_chars=136736]`` 这样的占位符。
于是线上真实出站 142,156 字符的 planner 请求，``payload_chars`` 只记 3,839。
旧脚本据此判断「体量很小、没问题」，方向完全反了。

本版改为从 ``request_messages`` 里把占位符中的真实字符数还原出来
（``base64_chars=`` 后的数字），得到 ``真实出站字符数``，并与
``payload_chars`` 并排展示两者差值。

**② 看不见图片。**
``request_messages`` 里的 ``image_url`` part 数量才是「这一轮到底发了几张图」，
也是视觉 token 的唯一来源。本版逐 span 统计 ``img`` 张数与 image 字节数，
并按 operation 汇总，直接回答「同一张图被发了几次」。

## 判定基线（2026-11 起的正确行为）

- ``turn_planner.plan`` **不应**再出现 ``img>0``：意图识别只看文本与附件描述。
  出现即说明 ``planner._planner_context_without_images`` 未生效。
- ``harness.task_action`` 在带图会话里**最多一张图、且只出现在转写失败的降级
  路径**：正常路径是 ``harness.image_transcribe`` 一次性转写，之后决策只看文本。
- ``harness.image_transcribe`` 每轮最多 1 次：它是「只读一次」的载体，
  同一 turn 出现多次说明图片被重复理解。

## 时区

服务器 DB 存 UTC。本脚本所有时间输出统一转北京时间（+8h）。
**手写 SQL 过滤时间窗口时必须自己减 8 小时**，否则窗口内一条都查不到
（这个坑踩过：按北京时间查 11:24 的事件返回 0 行，误以为改动没生效）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text

from app.db.database import engine
from app.llm.output_policy import OPERATION_TIMEOUT_SECONDS

# 服务器 DB 存 UTC；输出统一转北京时间（+8h）显示，避免人工换算看错
TZ_OFFSET = timedelta(hours=8)

# 从脱敏占位符里取回真实 base64 长度：`[data:image/png payload omitted; base64_chars=136736]`
_BASE64_CHARS_RE = re.compile(r"base64_chars=(\d+)")


def as_payload(value: object) -> dict:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return value if isinstance(value, dict) else {}


def as_datetime(value: object) -> datetime | None:
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return value if isinstance(value, datetime) else None


def bj_ts(value: datetime | None) -> str:
    if value is None:
        return "?"
    return (value + TZ_OFFSET).strftime("%Y-%m-%d %H:%M:%S")


def bj_hms(value: datetime | None) -> str:
    if value is None:
        return "?"
    return (value + TZ_OFFSET).strftime("%H:%M:%S")


@dataclass
class OutboundShape:
    """一个 span 的出站请求形态——图片成本的唯一可信来源。"""

    image_count: int = 0
    image_bytes: int = 0
    real_chars: int = 0

    @property
    def has_image(self) -> bool:
        return self.image_count > 0


def outbound_shape(payload: dict) -> OutboundShape:
    """从 ``request_messages`` 还原真实出站体量与图片张数。

    为什么不能只读 ``payload_chars``：那个值算在脱敏之后的 payload 上，
    图片被换成占位符，体量少报数十倍（实测 3,839 vs 真实 142,156）。

    image_bytes 的取法：占位符里带 ``base64_chars=N``，N 就是原始的 base64
    字符数；没被脱敏的（旧 span 或直接内联）就退回量真实 url 长度。
    """

    shape = OutboundShape()
    messages = payload.get("request_messages")
    if not isinstance(messages, list):
        return shape
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str):
            shape.real_chars += len(content)
            for match in _BASE64_CHARS_RE.finditer(content):
                shape.image_count += 1
                shape.image_bytes += int(match.group(1))
            continue
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            text_value = part.get("text")
            if isinstance(text_value, str):
                shape.real_chars += len(text_value)
            if part.get("type") != "image_url":
                continue
            shape.image_count += 1
            url = str((part.get("image_url") or {}).get("url") or "")
            match = _BASE64_CHARS_RE.search(url)
            shape.image_bytes += int(match.group(1)) if match else len(url)
    return shape


@dataclass
class SpanRow:
    operation: str
    created_at: datetime | None
    duration_ms: float
    payload: dict
    shape: OutboundShape
    thinking_mode: str
    iteration: int | None
    json_attempt: int | None
    json_max_attempts: int | None

    @property
    def payload_chars(self) -> int | None:
        value = self.payload.get("payload_chars")
        return int(value) if isinstance(value, (int, float)) else None


@dataclass
class TurnGroup:
    turn_id: str
    session_id: str
    created_at: datetime | None
    message: str
    spans: list[SpanRow] = field(default_factory=list)
    # 两套 ID 体系并存，归因必须同时认：
    #   user_message_received.turn_id      = msg_xxx（数据库消息主键）
    #   user_message_received.client_turn_id = turn_xxx（前端生成，span 里用这个）
    # 只按 msg_xxx 匹配会把所有 span 判成「0 次调用」——旧脚本正是因为这个才
    # 退化成时间窗口兜底，而窗口兜底会把上一轮的后台任务也算进来。
    client_turn_id: str = ""

    def of(self, *operations: str) -> list[SpanRow]:
        return [span for span in self.spans if span.operation in operations]

    @property
    def image_sends(self) -> int:
        return sum(span.shape.image_count for span in self.spans)


def _load_spans(limit: int) -> list[SpanRow]:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT payload_json, created_at
                FROM agent_events
                WHERE event_type = 'llm_call_finished'
                ORDER BY created_at DESC
                LIMIT :limit
                """
            ),
            {"limit": limit},
        ).fetchall()
    spans: list[SpanRow] = []
    for raw, created in rows:
        payload = as_payload(raw)
        spans.append(
            SpanRow(
                operation=str(payload.get("operation") or "?"),
                created_at=as_datetime(created),
                duration_ms=float(payload.get("duration_ms") or 0),
                payload=payload,
                shape=outbound_shape(payload),
                thinking_mode=str(payload.get("thinking_mode") or "?"),
                iteration=(
                    int(payload["iteration"])
                    if isinstance(payload.get("iteration"), (int, float))
                    else None
                ),
                json_attempt=(
                    int(payload["json_attempt"])
                    if isinstance(payload.get("json_attempt"), (int, float))
                    else None
                ),
                json_max_attempts=(
                    int(payload["json_max_attempts"])
                    if isinstance(payload.get("json_max_attempts"), (int, float))
                    else None
                ),
            )
        )
    return spans


def _load_turns(limit: int) -> list[TurnGroup]:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT session_id, payload_json, created_at
                FROM agent_events
                WHERE event_type = 'user_message_received'
                ORDER BY created_at DESC
                LIMIT :limit
                """
            ),
            {"limit": limit},
        ).fetchall()
    turns: list[TurnGroup] = []
    for session_id, raw, created in rows:
        payload = as_payload(raw)
        turns.append(
            TurnGroup(
                turn_id=str(payload.get("turn_id") or payload.get("message_id") or ""),
                session_id=str(session_id or ""),
                created_at=as_datetime(created),
                message=str(payload.get("message") or "")[:60],
                client_turn_id=str(payload.get("client_turn_id") or ""),
            )
        )
    return turns


def _attach_spans(turn: TurnGroup, spans: list[SpanRow]) -> None:
    """按 turn 归因，两套 ID 都要认。

    ``user_message_received`` 里同时有两个标识：
      - ``turn_id`` / ``message_id`` = ``msg_xxx``（数据库消息主键）
      - ``client_turn_id`` = ``turn_xxx``（前端生成，**span 里用的是这个**）

    所以只比对 ``msg_xxx`` 会全部落空。两者都作为精确匹配的候选；只有既没
    turn_id 也没 user_message_id 的老 span 才退回时间窗口兜底。
    """

    candidates = {item for item in (turn.turn_id, turn.client_turn_id) if item}
    matched: list[SpanRow] = []
    for span in spans:
        span_turns = {
            str(value)
            for value in (
                span.payload.get("turn_id"),
                span.payload.get("user_message_id"),
                span.payload.get("client_turn_id"),
            )
            if value
        }
        if span_turns:
            if span_turns & candidates:
                matched.append(span)
            continue
        # 完全没有 turn 标识的老 span：只能靠时间窗口，且要求 session 对得上
        if turn.created_at is None or span.created_at is None:
            continue
        if turn.created_at <= span.created_at <= turn.created_at + timedelta(minutes=10):
            span_session = span.payload.get("session_id")
            if span_session and turn.session_id and str(span_session) != turn.session_id:
                continue
            matched.append(span)
    matched.sort(key=lambda item: str(item.payload.get("started_at") or ""))
    turn.spans = matched


def _print_turn(turn: TurnGroup) -> None:
    if not turn.spans:
        print(f"\n[{bj_ts(turn.created_at)}] turn {turn.turn_id[:18]}…")
        print("  0 次模型调用（本轮可能全走了确定性直通，或 span 未落库）")
        return

    exact = [
        span
        for span in turn.spans
        if span.payload.get("turn_id") or span.payload.get("user_message_id")
    ]
    window = [span for span in turn.spans if span not in exact]

    print(f"\n[{bj_ts(turn.created_at)}] turn {turn.turn_id[:18]}…  msg={turn.message!r}")
    print(
        f"  共 {len(turn.spans)} 次模型调用"
        + (f"（精确 {len(exact)} / 窗口兜底 {len(window)}）" if window else "")
    )
    print(
        f"  {'时间':<9} {'operation':<26} {'dur':>8} {'img':>4} {'图片字节':>10} "
        f"{'真实出站':>10} {'记录体量':>10}"
    )
    for span in turn.spans:
        payload_chars = span.payload_chars
        # 只在「本来该以文本为主」的调用上标少报：转写/看图这类请求本来就只有
        # 一张图 + 一句话，真实体量与 payload_chars 的倍数没有诊断意义（会印出
        # 198× 这种噪音，反而掩盖真正的问题）。
        drift = ""
        if (
            payload_chars is not None
            and span.shape.image_count == 0
            and span.shape.real_chars > max(payload_chars, 1) * 2
        ):
            drift = f"  ← 少报 {span.shape.real_chars / max(payload_chars, 1):.0f}×"
        print(
            f"  {bj_hms(span.created_at):<9} {span.operation[:26]:<26} "
            f"{span.duration_ms / 1000:>7.2f}s {span.shape.image_count:>4} "
            f"{span.shape.image_bytes:>10,} {span.shape.real_chars:>10,} "
            f"{(payload_chars if payload_chars is not None else -1):>10,}{drift}"
        )

    total_ms = sum(span.duration_ms for span in turn.spans)
    print(f"  合计 {total_ms / 1000:.2f}s，其中带图请求 {turn.image_sends} 次")

    plan_spans = turn.of("turn_planner.plan")
    if plan_spans:
        image_plans = [span for span in plan_spans if span.shape.has_image]
        if image_plans:
            print(
                f"  [!] planner 重发了 {len(image_plans)} 次图片"
                " → `_planner_context_without_images` 未生效（意图识别不需要看图）"
            )
        else:
            print("  [OK] planner 未发送图片")

    transcribe = turn.of("harness.image_transcribe")
    if len(transcribe) > 1:
        print(
            f"  [!] 本轮转写 {len(transcribe)} 次（应只读一次图）"
            " → 检查 step_loop 是否在循环体内重复调用 transcribe_images_once"
        )

    action_spans = [span for span in turn.of("harness.task_action") if span.iteration]
    if action_spans:
        modes = defaultdict(int)
        for span in action_spans:
            modes[span.thinking_mode] += 1
        detail = "，".join(f"{mode}×{count}" for mode, count in sorted(modes.items()))
        print(f"  决策轮思考模式：{detail}")
        first = next((s for s in action_spans if s.iteration == 1), None)
        later = [s for s in action_spans if (s.iteration or 0) >= 2]
        if later and all(s.thinking_mode == "disabled" for s in later):
            opening = first.thinking_mode if first else "无第 1 轮调用"
            print(f"  [OK] 第 2 轮起已关思考（第 1 轮：{opening}）")
        elif later:
            stray = [s.iteration for s in later if s.thinking_mode != "disabled"]
            print(f"  [!] 第 {stray} 轮仍是思考模式 → _decision_thinking_scope 未生效")


def _print_operation_summary(turns: list[TurnGroup]) -> None:
    """按 operation 汇总：耗时、图片重发次数、真实体量 vs 记录体量。"""

    stats: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"count": 0, "ms": 0.0, "img": 0, "real": 0, "logged": 0, "logged_n": 0}
    )
    for turn in turns:
        for span in turn.spans:
            entry = stats[span.operation]
            entry["count"] += 1
            entry["ms"] += span.duration_ms
            entry["img"] += span.shape.image_count
            entry["real"] += span.shape.real_chars
            if span.payload_chars is not None:
                entry["logged"] += span.payload_chars
                entry["logged_n"] += 1

    if not stats:
        return
    print("\n" + "=" * 78)
    print("按 operation 汇总（图片成本视角）")
    print("=" * 78)
    print(f"  {'operation':<26} {'次数':>4} {'均耗时':>8} {'图片':>5} {'真实体量':>12} {'记录体量':>12}")
    for operation, entry in sorted(stats.items(), key=lambda kv: -kv[1]["ms"]):
        avg = entry["ms"] / entry["count"] / 1000
        logged = (
            f"{entry['logged']:,}" if entry["logged_n"] else "-"
        )
        print(
            f"  {operation[:26]:<26} {entry['count']:>4} {avg:>7.2f}s "
            f"{entry['img']:>5} {entry['real']:>12,} {logged:>12}"
        )

    planner = stats.get("turn_planner.plan")
    if planner and planner["img"]:
        print(
            f"\n  [!] turn_planner.plan 累计重发图片 {planner['img']} 张"
            f"（{planner['real']:,} 字符）→ 意图识别阶段仍在为图片付费"
        )


def _check_runtime_support() -> None:
    """部署自检：Redis、路由缓存、output_policy 收紧、确定性执行器生效率。"""

    print("=" * 78)
    print("部署自检")
    print("=" * 78)

    try:
        from app.redis_client import get_redis

        client = get_redis()
        if client is None:
            print("  [!] Redis：不可用（REDIS_HOST 未配置或连接失败）→ 路由缓存静默禁用")
        else:
            try:
                info = client.info("server")
                print(
                    f"  [OK] Redis 已连通：{info.get('redis_version', '?')} / keys≈{client.dbsize()}"
                )
            except Exception as exc:  # noqa: BLE001
                print(f"  [!] Redis client 存在但 info 失败：{exc}")
    except Exception as exc:  # noqa: BLE001
        print(f"  [!] Redis 检查异常：{exc}")

    timeout_cap = OPERATION_TIMEOUT_SECONDS.get("harness.task_action")
    if timeout_cap:
        print(f"  [i] harness.task_action 单次上限 {timeout_cap:.0f}s")


def _check_deterministic_paths() -> None:
    """确定性执行器生效率：这些节点跳过 LLM 决策轮，是「降耗」的另一条腿。"""

    try:
        with engine.connect() as conn:
            prefill_rows = conn.execute(
                text(
                    """
                    SELECT payload_json, created_at
                    FROM agent_events
                    WHERE event_type = 'sop_prefill_planned'
                    ORDER BY created_at DESC
                    LIMIT 100
                    """
                )
            ).fetchall()
        scenes: dict[str, int] = defaultdict(int)
        details: list[tuple[str, str]] = []
        for raw, created in prefill_rows:
            payload = as_payload(raw)
            scene = str(payload.get("scene") or "?")
            scenes[scene] += 1
            details.append((bj_hms(as_datetime(created)), scene))
        if prefill_rows:
            summary = "，".join(f"{k} ×{v}" for k, v in sorted(scenes.items()))
            print(f"\n  SOP 确定性执行器：sop_prefill_planned ×{len(prefill_rows)}（{summary}）")
            print("    → 这些节点跳过了 LLM 决策轮")
        else:
            print("\n  SOP 确定性执行器：无 sop_prefill_planned 事件（未部署 / 未触发）")
    except Exception as exc:  # noqa: BLE001
        print(f"  [!] 确定性执行器观测失败：{exc}")

    try:
        with engine.connect() as conn:
            ext_rows = conn.execute(
                text(
                    """
                    SELECT payload_json, created_at
                    FROM agent_events
                    WHERE event_type = 'sop_slot_extraction'
                    ORDER BY created_at DESC
                    LIMIT 100
                    """
                )
            ).fetchall()
        if ext_rows:
            full = partial = empty = 0
            durations: list[float] = []
            for raw, _created in ext_rows:
                payload = as_payload(raw)
                extracted = payload.get("extracted")
                extracted_n = len(extracted) if isinstance(extracted, dict) else 0
                fields_n = len(payload.get("fields") or [])
                if fields_n and extracted_n >= fields_n:
                    full += 1
                elif extracted_n:
                    partial += 1
                else:
                    empty += 1
                durations.append(float(payload.get("duration_ms") or 0))
            avg_ms = sum(durations) / len(durations) if durations else 0
            print(
                f"  槽位抽取：sop_slot_extraction ×{len(ext_rows)}"
                f"（抽齐直通 ×{full}，部分 ×{partial}，未抽到 ×{empty}）均 {avg_ms:.0f}ms"
            )
        else:
            print("  槽位抽取：无 sop_slot_extraction 事件（未部署 / 未触发）")
    except Exception as exc:  # noqa: BLE001
        print(f"  [!] 槽位抽取观测失败：{exc}")


def main() -> None:
    parser = argparse.ArgumentParser(description="planner/决策链耗时与图片成本诊断")
    parser.add_argument("--turn", help="只看指定 turn_id")
    parser.add_argument("--limit", type=int, default=4, help="分析最近几个 turn（默认 4）")
    parser.add_argument("--spans", type=int, default=400, help="扫描多少个 span（默认 400）")
    parser.add_argument(
        "--all", action="store_true", help="额外打印部署自检与确定性执行器生效率"
    )
    args = parser.parse_args()

    if args.all:
        _check_runtime_support()
        _check_deterministic_paths()
        print()

    spans = _load_spans(args.spans)
    if not spans:
        print("没有 llm_call_finished 事件。检查 trace_sink 是否落库。")
        return

    print("=" * 78)
    print("最近对话的模型调用明细")
    print("=" * 78)
    print(
        "  说明：`真实出站` 是从 request_messages 还原的字符数（含图片占位符里的原始\n"
        "        base64 长度）；`payload_chars` 是脱敏后记录的值，图片场景会严重少报。"
    )

    if args.turn:
        # 指定 turn：turn_id / user_message_id / client_turn_id 任一对上都算，
        # 因为用户手上拿到的可能是其中任意一种形态。
        target = TurnGroup(
            turn_id=args.turn, session_id="", created_at=None, message="(指定)"
        )
        exact = [
            span
            for span in spans
            if args.turn
            in {
                str(value)
                for value in (
                    span.payload.get("turn_id"),
                    span.payload.get("user_message_id"),
                    span.payload.get("client_turn_id"),
                )
                if value
            }
        ]
        target.spans = exact
        if not exact:
            print(f"\n未找到 turn_id={args.turn} 的 span（可能超出 --spans 窗口）")
            return
        _print_turn(target)
        _print_operation_summary([target])
        return

    turns = _load_turns(args.limit)
    if not turns:
        print("没有 user_message_received 事件，无法按轮次归因。可用 --turn 指定。")
        return

    for turn in turns:
        _attach_spans(turn, spans)
        _print_turn(turn)

    _print_operation_summary(turns)


if __name__ == "__main__":
    main()