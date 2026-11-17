import { Fragment } from 'react';

import {
  CHAT_DAY_DIVIDER_CLASS,
  CHAT_DAY_DIVIDER_PILL_CLASS,
  CHAT_DEBUG_PANEL_CLASS,
  CHAT_MESSAGES_CLASS,
  CHAT_MESSAGE_STACK_CLASS,
} from '../chatPageStyles';
import {
  CHAT_TRACE_RECOVERY_WINDOW_MS,
  a2uiFormForMessage,
  buildTurnAliasMap,
  canonicalMessageTurnId,
  createdScheduledTaskForMessage,
  harnessWorkspaceArtifacts,
  isDispatchNotice,
  isScheduledTaskPrompt,
  knowledgeCitations,
  messageAttachments,
  messageVisibleContent,
  normalizeMessageText,
  placeQueuedMessagesLast,
  scheduledDraftForMessage,
  traceDetails,
  traceLineAllowed,
  traceSummary,
} from '../chatHelpers';
import { staffdeckDisplayText } from '@/employee';
import type { ChatMessage } from '@/types';
import type { UseChatSession } from '../useChatSession';
import ChatEmptyState from './ChatEmptyState';
import MessageBubble, { dispatchAnswerInfo, type MessageRender } from './MessageBubble';
import ScheduledDraftCard from './ScheduledDraftCard';

/** 同一侧连续发言在这个窗口内算「一组」，共享一个组头（tuffui chat-thread 同款）。 */
const TURN_GROUP_MS = 5 * 60_000;

/** 两条消息是否属于同一组发言（同侧、同日、间隔 < 5 分钟）。 */
function sameTurn(a: ChatMessage | undefined, b: ChatMessage | undefined): boolean {
  if (!a || !b) return false;
  if (a.role !== b.role) return false;
  const day = dayKey(a.created_at);
  if (!day || day !== dayKey(b.created_at)) return false;
  const delta = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  return delta >= 0 && delta < TURN_GROUP_MS;
}

function dayKey(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** 日期分隔文案：今天 / 昨天 / 11月8日 / 2025年11月8日（跨年才带年份）。 */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diffDays = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  const stamp = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === today.getFullYear()
    ? stamp
    : `${date.getFullYear()}年${stamp}`;
}

export default function MessageList({
  chat,
  emptyState,
}: {
  chat: UseChatSession;
  emptyState?: ReactNode;
}) {
  const {
    displayedMessages,
    turnTraceRef,
    uiConfig,
    currentStream,
    runningTurn,
    expandedTraceIds,
    collapsedTraceIds,
    isCurrentStreamingTrace,
    dismissedDraftMessageIds,
    createdScheduledTasks,
    activeConversationId,
    currentScheduledDraft,
    hasVisibleMessageScheduledDraft,
    confirmScheduledTask,
    dismissScheduledTaskDraft,
    chatMessagesRef,
    handleChatMessagesScroll,
    SHOW_DEBUG,
    lastTurn,
    hideKnowledgeCitations = false,
  } = chat;
  const renderMessages = placeQueuedMessagesLast(displayedMessages);
  // 同一轮里已经出现过「路由 · 已转交给 X」气泡时，答案气泡不再重复挂
  // 「由 X 回答」chip —— 两者表达的是同一件事（谁、为什么），并存会让用户
  // 误读成「有两条转接记录」（用户截图反馈）。
  // 只在**同轮**抑制：没有转接气泡的轮次（历史会话、普通员工）chip 依旧保留。
  // 注意必须走 alias 映射：SSE 那条可能是本地 `turn_xxx`，回放那条是服务端
  // `msg_xxx`，直接比 id 认不出同一轮。
  const aliasMap = buildTurnAliasMap(renderMessages);
  const turnsWithDispatchNotice = new Set<string>();
  renderMessages.forEach((messageItem) => {
    if (!isDispatchNotice(messageItem)) return;
    const turnId = canonicalMessageTurnId(messageItem, aliasMap);
    if (turnId) turnsWithDispatchNotice.add(turnId);
  });
  const dispatchInfoFor = (messageItem: (typeof renderMessages)[number]) => {
    if (messageItem.role !== 'assistant') return null;
    if (turnsWithDispatchNotice.size > 0) {
      const turnId = canonicalMessageTurnId(messageItem, aliasMap);
      if (turnId && turnsWithDispatchNotice.has(turnId)) return null;
    }
    return dispatchAnswerInfo(messageItem);
  };

  return (
    <div className={CHAT_MESSAGES_CLASS} ref={chatMessagesRef} onScroll={handleChatMessagesScroll}>
      {renderMessages.length === 0 && (
        // 空态在窗口内垂直居中（下方多留 4vh 让视觉重心略偏上），而不是贴顶。
        <div className="flex min-h-full flex-col justify-center pb-[4vh]">
          {emptyState ?? <ChatEmptyState chat={chat} />}
        </div>
      )}

      <div className={CHAT_MESSAGE_STACK_CLASS}>
        {renderMessages.map((item, itemIndex) => {
          const previous = itemIndex > 0 ? renderMessages[itemIndex - 1] : undefined;
          const currentDay = dayKey(item.created_at);
          const newDay = !previous || dayKey(previous.created_at) !== currentDay;
          // 同一侧、同一天、5 分钟内的连续消息并成一组：只出一份头像与姓名。
          const withinGroup = !newDay && sameTurn(previous, item);
          const turn = {
            first: !withinGroup,
            // 换日时由日期分隔自己撑开间距，不再叠 18px。
            spaced: Boolean(previous) && !withinGroup && !newDay,
            // 组尾：下一条不是同一侧的连续消息。点评/耗时只挂在组尾。
            last: !sameTurn(item, renderMessages[itemIndex + 1]),
          };
          const dividerLabel = newDay ? dayLabel(item.created_at) : '';
          const turnId = item.turnId || item.id;
          const fallbackTraceId = item.role === 'assistant' && item.isStreaming
            ? (currentStream.turnId || runningTurn?.turnId || '')
            : '';
          const primaryTrace = item.role === 'assistant' ? turnTraceRef.current.get(turnId) : undefined;
          const fallbackTrace = fallbackTraceId ? turnTraceRef.current.get(fallbackTraceId) : undefined;
          const trace = primaryTrace || fallbackTrace;
          const traceTurnId = primaryTrace ? turnId : (fallbackTrace ? fallbackTraceId : turnId);
          const traceLines = trace?.lines || [];
          const allowedTrace = traceLines.filter((line) => traceLineAllowed(line, uiConfig));
          const forceRunningTrace = Boolean(
            item.role === 'assistant'
            && item.isStreaming
            && allowedTrace.length === 0
            && traceLines.some((line) => line.state === 'running'),
          );
          const visibleTrace = forceRunningTrace ? traceLines : allowedTrace;
          const summary = trace && visibleTrace.length > 0 ? traceSummary(trace, visibleTrace) : null;
          const details = traceDetails(visibleTrace);
          const traceActive = isCurrentStreamingTrace(traceTurnId, item);
          const summaryForRender = summary && traceActive && !trace?.completedAt
            ? { ...summary, state: 'running' as const }
            : summary;
          const traceOnlyMessage = Boolean(
            item.role === 'assistant' && !normalizeMessageText(item.content) && details.length > 0,
          );
          const latestAssistantTrace = Boolean(
            item.role === 'assistant'
            && details.length > 0
            && !renderMessages.slice(itemIndex + 1).some((later) => (
              later.role === 'assistant'
              && Boolean(turnTraceRef.current.get(later.turnId || later.id)?.lines.length)
            )),
          );
          const recentlyStartedTrace = Boolean(
            trace?.startedAt && Date.now() - trace.startedAt <= CHAT_TRACE_RECOVERY_WINDOW_MS,
          );
          const defaultExpanded = Boolean(
            traceActive
            || summaryForRender?.state === 'running'
            || traceOnlyMessage
            || (latestAssistantTrace && recentlyStartedTrace),
          );
          const manuallyCollapsed = collapsedTraceIds.includes(traceTurnId);
          const expanded = Boolean(
            !manuallyCollapsed
            && (expandedTraceIds.includes(traceTurnId) || defaultExpanded),
          );
          const rawVisibleContent = staffdeckDisplayText(
            item.role === 'assistant'
              ? messageVisibleContent(item.content, { hideCitations: hideKnowledgeCitations })
              : item.content,
          );
          const visibleContent = normalizeMessageText(rawVisibleContent) ? rawVisibleContent : '';
          const citations = item.role === 'assistant' && !hideKnowledgeCitations
            ? knowledgeCitations(item, visibleContent)
            : [];
          const scheduledTaskPrompt = isScheduledTaskPrompt(item);
          const scheduledDraft = item.role === 'assistant' && !dismissedDraftMessageIds.includes(item.id)
            ? scheduledDraftForMessage(item)
            : null;
          const persistedCreatedTask = item.role === 'assistant'
            ? createdScheduledTaskForMessage(item)
            : undefined;
          const stoppedStatusOnly = Boolean(
            item.role === 'system'
            && item.id.startsWith('local_interrupt_')
            && visibleContent === '已停止生成',
          );
          const attachments = messageAttachments(item);
          const harnessArtifacts = item.role === 'assistant'
            ? harnessWorkspaceArtifacts(item)
            : [];
          // A2UI 表单只挂最新一条助手消息：历史轮次的表单早已被提交过，
          // 重新渲染出来只会诱导用户重复提交（后端也认不出旧步骤）。
          // 另外，一旦后续出现了带 ``slot_submission`` 的用户消息，说明这张
          // 表单已经提交过——刷新页面后不能再渲染出可编辑态。
          const laterMessages = renderMessages.slice(itemIndex + 1);
          const slotForm = item.role === 'assistant'
            && !laterMessages.some((later) => later.role === 'assistant')
            && !laterMessages.some((later) => Boolean(later.metadata?.slot_submission))
            ? a2uiFormForMessage(item)
            : null;
          const statusOnly = stoppedStatusOnly;
          const showInlineTrace = Boolean(summaryForRender && !stoppedStatusOnly);

          if (
            item.role === 'assistant'
            && !visibleContent
            && !showInlineTrace
            && !statusOnly
            && !scheduledDraft
            && !persistedCreatedTask
            && citations.length === 0
            && attachments.length === 0
            && harnessArtifacts.length === 0
            && !slotForm
          ) {
            return null;
          }

          /**
           * 「总耗时」只在有可靠计时数据时挂到答案气泡上。
           *
           * 一条**已经定稿**的答案气泡如果只拿到本地新建的空 trace
           * （`startedAt` 是页面加载/首帧时刻、没有 completedAt），
           * `TurnDurationNote` 会把它当成「本轮仍在执行」，每 250ms 往上跳 ——
           * 真实反馈「3s 左右就有答案了，但是时间计时仍然在增加」。
           * 常见触发：刷新后 `/trace` 投影还没回来、或 turn id 别名让
           * finishTrace 落在另一个 trace 上。此时正确做法是**不显示**计时，
           * 等服务端投影带 completed_at / duration_ms 回来再一次性显示权威值，
           * 而不是拿一个没有终态的 trace 假装在计时。
           * 仍在流式的气泡保留本地实时计时（`finishTrace` 会在 stream_end 定格）。
           */
          const hasTraceTerminal = Boolean(
            trace && (trace.completedAt !== undefined || trace.durationMs !== undefined),
          );
          const traceTiming = item.role === 'assistant' && trace
            && (hasTraceTerminal || item.isStreaming)
            ? {
              startedAt: trace.startedAt,
              completedAt: trace.completedAt,
              durationMs: trace.durationMs,
              firstTokenMs: trace.firstTokenMs,
            }
            : undefined;

          const render: MessageRender = {
            traceTurnId,
            summary: summaryForRender,
            details,
            expanded,
            showInlineTrace,
            visibleContent,
            citations,
            scheduledDraft,
            createdTask: createdScheduledTasks[item.id] || persistedCreatedTask,
            scheduledTaskPrompt,
            attachments,
            harnessArtifacts,
            statusOnly,
            slotForm,
            dispatchInfo: dispatchInfoFor(item),
            traceTiming,
          };

          return (
            <Fragment key={`${item.id}:turn`}>
              {dividerLabel && (
                <div
                  className={CHAT_DAY_DIVIDER_CLASS}
                  role="separator"
                  aria-label={dividerLabel}
                >
                  <span className={CHAT_DAY_DIVIDER_PILL_CLASS}>{dividerLabel}</span>
                </div>
              )}
              <MessageBubble chat={chat} item={item} render={render} turn={turn} />
            </Fragment>
          );
        })}
      </div>

      {currentScheduledDraft && !hasVisibleMessageScheduledDraft && (
        <div className={CHAT_MESSAGE_STACK_CLASS}>
          <ScheduledDraftCard
            draft={currentScheduledDraft}
            createdTask={activeConversationId ? createdScheduledTasks[`session:${activeConversationId}`] : undefined}
            onConfirm={(nextDraft) => void confirmScheduledTask(nextDraft)}
            onDismiss={() => dismissScheduledTaskDraft()}
          />
        </div>
      )}

      {SHOW_DEBUG && lastTurn && (
        <pre className={CHAT_DEBUG_PANEL_CLASS}>{JSON.stringify(lastTurn.session_state, null, 2)}</pre>
      )}
    </div>
  );
}
import type { ReactNode } from 'react';
