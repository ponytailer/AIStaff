import { useEffect, useState } from 'react';

import EmployeeAvatar from '@/components/EmployeeAvatar';
import StaffdeckIcon from '@/components/StaffdeckIcon';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import IconThumbUp from '@/assets/icons/thumb-up.svg?react';
import IconThumbDown from '@/assets/icons/thumb-down.svg?react';
import { employeeDisplayName } from '@/employee';
import { cn } from '@/lib/utils';
import type {
  ChatAttachmentRead,
  ChatMessage,
  HarnessWorkspaceArtifact,
  KnowledgeCitation,
  ScheduledTaskDraftRead,
  ScheduledTaskRead,
} from '@/types';

import {
  CHAT_ARTIFACT_ZIP_CLASS,
  CHAT_ATTACHMENT_GRID_CLASS,
  CHAT_ATTACHMENT_LIST_CLASS,
  CHAT_ATTACHMENT_TILE_CLASS,
  CHAT_ATTACHMENT_TILE_ERROR_CLASS,
  CHAT_ATTACHMENT_TILE_IMG_CLASS,
  CHAT_FILE_CHIP_BODY_CLASS,
  CHAT_FILE_CHIP_CLASS,
  CHAT_FILE_CHIP_ERROR_CLASS,
  CHAT_FILE_CHIP_ICON_CLASS,
  CHAT_FILE_CHIP_META_CLASS,
  CHAT_FILE_CHIP_NAME_CLASS,
  CHAT_DISPATCH_NOTICE_CLASS,
  CHAT_DISPATCH_NOTICE_INTENT_CLASS,
  CHAT_DISPATCH_NOTICE_ROUTE_BADGE_CLASS,
  CHAT_DISPATCH_NOTICE_ROW_CLASS,
  CHAT_DISPATCH_NOTICE_TARGET_CLASS,
  CHAT_FEEDBACK_BTN_ACTIVE_CLASS,
  CHAT_FEEDBACK_BTN_CLASS,
  CHAT_FEEDBACK_BTN_DISLIKE_ACTIVE_CLASS,
  CHAT_FEEDBACK_CLASS,
  CHAT_GROUP_MESSAGE_AVATAR_CLASS,
  CHAT_GROUP_MESSAGE_CONTENT_CLASS,
  CHAT_GROUP_MESSAGE_LEADER_BADGE_CLASS,
  CHAT_GROUP_MESSAGE_ROW_CLASS,
  CHAT_MESSAGE_ITEM_CLASS,
  CHAT_MESSAGE_MODE_CHIP_CLASS,
  CHAT_PLAIN_ANSWER_CLASS,
  CHAT_SLASH_COMMAND_MESSAGE_CLASS,
  CHAT_SLASH_COMMAND_REQUEST_CLASS,
  CHAT_QUEUED_BUBBLE_CLASS,
  CHAT_QUEUED_DELETE_BTN_CLASS,
  CHAT_QUEUED_MESSAGE_ITEM_CLASS,
  CHAT_STREAM_CURSOR_CLASS,
  CHAT_TRACE_FLOW_TEXT_CLASS,
  CHAT_TRACE_TOTAL_DURATION_CLASS,
  CHAT_TURN_AUTHOR_CLASS,
  CHAT_TURN_HEAD_CLASS,
  CHAT_TURN_SPACED_CLASS,
  CHAT_TURN_SPACER_CLASS,
  CHAT_TURN_TIME_CLASS,
  CHAT_USER_AVATAR_CLASS,
  CHAT_USER_CONTENT_COLUMN_CLASS,
  CHAT_USER_HEADER_ROW_CLASS,
  chatBubbleClass,
  chatRowClass,
} from '../chatPageStyles';
import {
  MarkdownMessage,
  attachmentTypeLabel,
  canRateMessage,
  dispatchNoticeInfo,
  formatTraceDuration,
  isDispatchNotice,
} from '../chatHelpers';
import type { TraceLine } from '../chatTypes';
import type { A2UIForm } from '../chatTypes';
import type { UseChatSession } from '../useChatSession';
import ExecutionRecord from './ExecutionRecord';
import HarnessArtifactDownloads from './HarnessArtifactDownloads';
import KnowledgeCitationList from './KnowledgeCitationList';
import ScheduledDraftCard from './ScheduledDraftCard';
import SlashCommandChip from './SlashCommandChip';
import SlotFormCard from './SlotFormCard';
import { slashCommandMessage } from '../slashCommands';

export type TurnTraceTiming = {
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  /** 首 token 耗时（毫秒）。缺失时只显示总耗时（如兜底回复 / 非流式）。 */
  firstTokenMs?: number;
};

export type MessageRender = {
  traceTurnId: string;
  summary: { text: string; state: TraceLine['state'] } | null;
  details: TraceLine[];
  expanded: boolean;
  showInlineTrace: boolean;
  visibleContent: string;
  citations: KnowledgeCitation[];
  scheduledDraft: ScheduledTaskDraftRead | null;
  createdTask?: ScheduledTaskRead;
  scheduledTaskPrompt: boolean;
  attachments: ChatAttachmentRead[];
  harnessArtifacts: HarnessWorkspaceArtifact[];
  statusOnly: boolean;
  traceTiming?: TurnTraceTiming;
  /** A2UI：缺槽询问附带的表单（只有最新一条助手消息才挂，避免过期表单被重复提交）。 */
  slotForm?: A2UIForm | null;
  /** 调度入口：这条答案是哪位同事答的（`metadata.dispatch`）。 */
  dispatchInfo?: DispatchAnswerInfo | null;
};

/** 答案归属：调度入口透传回来的成员信息，用于在气泡上方标「由 小王 回答」。 */
export type DispatchAnswerInfo = {
  memberName: string;
  memberAgentId?: string;
  intent?: string | null;
  confidence?: number | null;
};

/** 从消息 metadata 里取调度归属。没有就是普通员工自己答的，不显示 chip。 */
export function dispatchAnswerInfo(item: ChatMessage): DispatchAnswerInfo | null {
  const raw = item.metadata?.dispatch;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const memberName = typeof record.member_name === 'string' ? record.member_name.trim() : '';
  if (!memberName) return null;
  return {
    memberName,
    memberAgentId:
      typeof record.member_agent_id === 'string' ? record.member_agent_id : undefined,
    intent: typeof record.intent === 'string' ? record.intent : null,
    confidence: typeof record.confidence === 'number' ? record.confidence : null,
  };
}

type MessageBubbleProps = {
  chat: UseChatSession;
  item: ChatMessage;
  render: MessageRender;
  /**
   * 分组信息（tuffui ai-chat 的 thread 语义）：
   * - `first`：是不是这一组的组首。只有组首出头像与「谁 + 几点」，同组后续消息
   *   在头像列宽处留白，读者看到的是「一个人连着说了几句」而不是几条独立卡片。
   * - `spaced`：是不是换组的第一条。换组时上抬 18px 呼吸，同组内只隔 4px。
   * - `last`：是不是这一组的最后一条。点赞/耗时只挂在组尾 —— 挂到中间的补充
   *   消息上，会把同一轮答复用一行按钮劈成两半。
   */
  turn?: { first: boolean; spaced: boolean; last: boolean };
};

/** 消息时间：24 小时制 HH:mm；解析不了就不显示（历史脏数据不占位）。 */
function messageClock(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * 图片附件：有 data_url 才进瓷砖网格，否则回落到文件胶囊（tuff 的 tray 也是
 * image 进网格、file 进胶囊，两类不混排）。
 */
function hasImagePreview(
  attachment: ChatAttachmentRead,
): attachment is ChatAttachmentRead & { data_url: string } {
  return attachment.kind === 'image' && Boolean(attachment.data_url);
}

function activeTeamProgress(item: ChatMessage): { phase: string; statusText: string } | null {
  const progress = item.metadata?.team_progress;
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return null;
  const progressRecord = progress as Record<string, unknown>;
  const phase = typeof progressRecord.phase === 'string' ? progressRecord.phase : '';
  if (phase !== 'collecting' && phase !== 'synthesizing') return null;
  const statusText = typeof progressRecord.status_text === 'string'
    ? progressRecord.status_text.trim()
    : '';
  return statusText ? { phase, statusText } : null;
}

/**
 * 本轮耗时：未完成时实时跳动，完成后定格。
 *
 * 有首 token 数据时拆成「首 token X · 总耗时 Y」：
 * - 首 token = 消息发出 → 第一个答案字符出现（用户真正感知的「开始答应」）
 * - 总耗时  = 消息发出 → 答案落库（含路由/检索/工具/落库，口径更宽）
 * 两者差距大时，用户一眼能看出慢在「等第一个字」还是「收尾」。
 */
function TurnDurationNote({ timing }: { timing: TurnTraceTiming }) {
  const running = timing.completedAt === undefined && timing.durationMs === undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);
  const durationMs = timing.durationMs
    ?? (timing.completedAt !== undefined
      ? Math.max(0, timing.completedAt - timing.startedAt)
      : Math.max(0, now - timing.startedAt));
  const label = formatTraceDuration(durationMs);
  if (!label) return null;
  // 只有服务端投影带回真实首包时间时才显示（流式中途还没有，兜底回复没有）。
  const firstTokenLabel = !running && timing.firstTokenMs !== undefined && timing.firstTokenMs >= 0
    ? formatTraceDuration(timing.firstTokenMs)
    : '';
  return (
    <span
      className={cn(CHAT_TRACE_TOTAL_DURATION_CLASS, running && CHAT_TRACE_FLOW_TEXT_CLASS)}
      data-i18n-ignore
      title={running
        ? '本轮仍在执行，计时进行中'
        // 「3s 就有答案，却显示 8.9s」多数是口径差：这一轮还包含路由决策、
        // 知识检索与答案落库，不只是模型出字的那几秒 —— 拆出首 token 后
        // 用户能直接看出「等第一个字」与「收尾」各占多少。
        : firstTokenLabel
          ? `首 token ${firstTokenLabel}：消息发出到第一个字出现；总耗时 ${label}：消息发出到答案落库`
          : '本轮总耗时：从消息发出到答案落库，含路由/检索/工具与模型调用'}
    >
      {firstTokenLabel && (
        <>
          首 token {firstTokenLabel}
          <span aria-hidden> · </span>
        </>
      )}
      总耗时 {label}
    </span>
  );
}

export default function MessageBubble({
  chat,
  item,
  render,
  turn = { first: true, spaced: false, last: true },
}: MessageBubbleProps) {
  const {
    toggleTrace,
    rateMessage,
    setActiveCitation,
    confirmScheduledTask,
    dismissScheduledTaskDraft,
    removeQueuedTurn,
  } = chat;
  const {
    traceTurnId,
    summary,
    details,
    expanded,
    showInlineTrace,
    visibleContent,
    citations,
    scheduledDraft,
    createdTask,
    scheduledTaskPrompt,
    attachments,
    harnessArtifacts,
    statusOnly,
    traceTiming,
    slotForm,
    dispatchInfo,
  } = render;
  const queuedMessage = item.role === 'user' && item.metadata?.queued === true;
  // 附件图片点开看大图。data: URL 不能新标签打开（浏览器禁止顶层导航到 data URL），
  // 所以走弹窗而不是 <a target="_blank">。
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  // 调度入口的「转接通知」：由路由自己说「已转交给 X」，成员答案在它后面一条。
  // 它不是答案，所以不参与点赞、不显示 trace、也不走普通答案气泡的排版。
  const noticeInfo = item.role === 'assistant' && isDispatchNotice(item)
    ? dispatchNoticeInfo(item)
    : null;
  const isDispatchNoticeMessage = item.role === 'assistant' && isDispatchNotice(item);
  const sentSlashCommand = item.role === 'user'
    ? slashCommandMessage(visibleContent, chat.slashCommands)
    : null;
  const groupAssistantMessage = item.role === 'assistant' && Boolean(chat.currentSession?.team_id);
  /**
   * 所有助手消息都带头像（demo 的 a-avatar）：员工是对话的主体，读者要一眼看出
   * 「这句话是谁说的」。多智能体（team）额外多一行署名 + 项目领导徽标。
   */
  const assistantWithAvatar = item.role === 'assistant';
  const groupSenderName = chat.displayedAgent
    ? employeeDisplayName(chat.displayedAgent)
    : '项目领导';
  // 组头姓名：普通员工用自己的名字；多智能体会话在名字后面补「项目领导」徽标。
  const agentHeaderName = chat.displayedAgent
    ? employeeDisplayName(chat.displayedAgent)
    : '数字员工';
  const clock = item.role === 'assistant' ? messageClock(item.created_at) : '';
  const teamProgress = item.role === 'assistant' ? activeTeamProgress(item) : null;
  // 用户署名（参考 Claude 风格 thread）：姓名 + 首字符头像，右对齐坐在气泡上方。
  const authUser = chat.authUser;
  const senderName = (authUser?.display_name || authUser?.username || '你').trim() || '你';
  const senderInitial = senderName.charAt(0);

  // 转接通知单独成一块：只显示「路由 → 转给了谁（+ 判定意图）」，
  // 不渲染 trace、点赞、引用卡片——它不是答案，成员答案在紧跟的下一条气泡里。
  if (isDispatchNoticeMessage) {
    return (
      <div className={cn(CHAT_MESSAGE_ITEM_CLASS, 'my-[2px]', turn.spaced && CHAT_TURN_SPACED_CLASS)}>
        <div className={CHAT_DISPATCH_NOTICE_ROW_CLASS}>
          <div className={CHAT_DISPATCH_NOTICE_CLASS} role="status">
            <span className={CHAT_DISPATCH_NOTICE_ROUTE_BADGE_CLASS}>
              <StaffdeckIcon name="branch" size={11} />
              路由
            </span>
            <span data-i18n-ignore>
              已转交给
              <span className={CHAT_DISPATCH_NOTICE_TARGET_CLASS}>
                {noticeInfo?.memberName || '对应同事'}
              </span>
            </span>
            {noticeInfo?.intent && (
              <span className={CHAT_DISPATCH_NOTICE_INTENT_CLASS} data-i18n-ignore>
                {noticeInfo.intent}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      CHAT_MESSAGE_ITEM_CLASS,
      turn.spaced && CHAT_TURN_SPACED_CLASS,
      queuedMessage && CHAT_QUEUED_MESSAGE_ITEM_CLASS,
    )}>
      <div className={cn(chatRowClass(item.role), assistantWithAvatar && CHAT_GROUP_MESSAGE_ROW_CLASS)}>
        {assistantWithAvatar && (turn.first ? (
          <EmployeeAvatar
            agent={chat.displayedAgent}
            size={28}
            radius={14}
            className={CHAT_GROUP_MESSAGE_AVATAR_CLASS}
          />
        ) : (
          // 同组后续消息：占住头像那一列，内容仍在同一条竖线上。
          <span className={CHAT_TURN_SPACER_CLASS} aria-hidden="true" />
        ))}
        {/* 用户消息：姓名 + 头像的署名行在气泡上方右对齐（组首才出，同组后续贴住气泡）。 */}
        <div
          className={
            assistantWithAvatar
              ? CHAT_GROUP_MESSAGE_CONTENT_CLASS
              : item.role === 'user'
                ? CHAT_USER_CONTENT_COLUMN_CLASS
                : 'contents'
          }
        >
          {item.role === 'user' && turn.first && (
            <div className={CHAT_USER_HEADER_ROW_CLASS}>
              <span className={CHAT_TURN_AUTHOR_CLASS} data-i18n-ignore>
                <span className="truncate">{senderName}</span>
              </span>
              <span className={CHAT_USER_AVATAR_CLASS} aria-hidden="true">
                {senderInitial}
              </span>
            </div>
          )}
          {/* 组头：谁在说 + 几点说（时间默认隐身，hover 这条才浮现）。 */}
          {assistantWithAvatar && turn.first && (
            <div className={CHAT_TURN_HEAD_CLASS}>
              <span className={CHAT_TURN_AUTHOR_CLASS} data-i18n-ignore>
                <span className="truncate">
                  {groupAssistantMessage ? groupSenderName : agentHeaderName}
                </span>
                {groupAssistantMessage && (
                  <span className={CHAT_GROUP_MESSAGE_LEADER_BADGE_CLASS}>项目领导</span>
                )}
              </span>
              {clock && (
                <time
                  className={CHAT_TURN_TIME_CLASS}
                  dateTime={item.created_at}
                  suppressHydrationWarning
                >
                  {clock}
                </time>
              )}
            </div>
          )}
          <div
            className={cn(
              chatBubbleClass(item.role, item.isError, statusOnly || Boolean(item.isError)),
              queuedMessage && CHAT_QUEUED_BUBBLE_CLASS,
            )}
          >
          {queuedMessage && (
            <button
              type="button"
              className={CHAT_QUEUED_DELETE_BTN_CLASS}
              aria-label="删除排队消息"
              title="删除排队消息"
              onClick={() => removeQueuedTurn(item.turnId || '')}
            >
              <StaffdeckIcon name="trash" size={14} />
            </button>
          )}
          {/* 调度入口的答案来自某位同事：明确标出来，否则用户会以为入口自己在答。
              放在正文上方而不是下面——读者要先知道「谁在说话」。
              **同轮去重由 MessageList 负责**：一轮里已经渲染过「路由 · 已转交给 X」
              气泡时，MessageList 会把 dispatchInfo 置空、不再挂这个 chip（用户反馈：
              两者并存看起来像「有两段转接记录」）。本组件只负责渲染，不做跨组件判断。 */}
          {item.role === 'assistant' && dispatchInfo && !statusOnly && (
            <div className="mb-[7px] flex flex-wrap items-center gap-[5px] text-[11.5px]">
              <span className="inline-flex items-center gap-[4px] rounded-[6px] bg-[#dceee9] px-[6px] py-[2px] text-[#0f766e]">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                由 {dispatchInfo.memberName} 回答
              </span>
              {dispatchInfo.intent && (
                <span className="truncate text-[#9a9a9f]">{dispatchInfo.intent}</span>
              )}
            </div>
          )}
          {statusOnly ? (
            <div className="text-[13px] text-[#6d6d72]">{visibleContent}</div>
          ) : showInlineTrace && summary ? (
            <ExecutionRecord
              traceTurnId={traceTurnId}
              summary={summary}
              details={details}
              expanded={expanded}
              onToggle={toggleTrace}
            />
          ) : null}

          {!statusOnly && visibleContent ? (
            item.role === 'assistant' ? (
              <div aria-live={teamProgress ? 'polite' : undefined} data-i18n-ignore>
                <MarkdownMessage content={visibleContent} />
                {item.isStreaming && (
                  <span className={CHAT_STREAM_CURSOR_CLASS} aria-hidden="true" />
                )}
                {teamProgress && (
                  <div
                    role="status"
                    aria-label={teamProgress.statusText}
                    className="mt-[8px] flex items-center gap-[7px] text-[12px] text-[#6d7791]"
                  >
                    <span className="relative flex size-[7px]">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#1a71ff] opacity-40" />
                      <span className="relative inline-flex size-[7px] rounded-full bg-[#1a71ff]" />
                    </span>
                    <span>{teamProgress.statusText}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className={cn(
                CHAT_PLAIN_ANSWER_CLASS,
                sentSlashCommand && CHAT_SLASH_COMMAND_MESSAGE_CLASS,
              )}
              >
                {scheduledTaskPrompt && (
                  <span className={CHAT_MESSAGE_MODE_CHIP_CLASS}>
                    <StaffdeckIcon name="clock" size={13} />
                    定时任务
                  </span>
                )}
                {sentSlashCommand ? (
                  <>
                    <SlashCommandChip command={sentSlashCommand.command} />
                    {sentSlashCommand.requestText && (
                      <span className={CHAT_SLASH_COMMAND_REQUEST_CLASS} data-i18n-ignore>
                        {sentSlashCommand.requestText}
                      </span>
                    )}
                  </>
                ) : (
                  <span data-i18n-ignore>{visibleContent}</span>
                )}
              </div>
            )
          ) : null}

          {!statusOnly && attachments.length > 0 && (
            <div className={CHAT_ATTACHMENT_LIST_CLASS}>
              {attachments.some((attachment) => hasImagePreview(attachment)) && (
                <div className={CHAT_ATTACHMENT_GRID_CLASS}>
                  {attachments.filter(hasImagePreview).map((attachment) => (
                    <button
                      type="button"
                      className={CHAT_ATTACHMENT_TILE_CLASS}
                      key={attachment.id}
                      title={attachment.filename}
                      aria-label={`查看附件图片 ${attachment.filename}`}
                      onClick={() => setPreviewImage({ src: attachment.data_url, name: attachment.filename })}
                    >
                      <img
                        className={CHAT_ATTACHMENT_TILE_IMG_CLASS}
                        src={attachment.data_url}
                        alt={attachment.filename}
                        loading="lazy"
                        decoding="async"
                      />
                    </button>
                  ))}
                </div>
              )}
              {attachments.some((attachment) => !hasImagePreview(attachment)) && (
                <div className={CHAT_ATTACHMENT_GRID_CLASS}>
                  {attachments.filter((attachment) => !hasImagePreview(attachment)).map((attachment) => (
                    <span
                      className={cn(
                        CHAT_FILE_CHIP_CLASS,
                        attachment.error && CHAT_FILE_CHIP_ERROR_CLASS,
                      )}
                      key={attachment.id}
                      title={attachment.filename}
                    >
                      <span className={CHAT_FILE_CHIP_BODY_CLASS}>
                        <span className={CHAT_FILE_CHIP_ICON_CLASS}>
                          <StaffdeckIcon name={attachment.kind === 'pdf' ? 'file' : 'folder'} size={14} />
                        </span>
                        <span className={CHAT_FILE_CHIP_NAME_CLASS} data-i18n-ignore>
                          {attachment.filename}
                        </span>
                        <span className={CHAT_FILE_CHIP_META_CLASS} data-i18n-ignore>
                          {attachment.error || attachmentTypeLabel(attachment)}
                        </span>
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {item.role === 'assistant' && harnessArtifacts.length > 0 && (
            <HarnessArtifactDownloads
              artifacts={harnessArtifacts}
              tenantId={chat.tenantId}
              sessionId={chat.activeConversationId}
            />
          )}

          {item.role === 'assistant' && (
            <KnowledgeCitationList citations={citations} onOpen={setActiveCitation} />
          )}

          {slotForm && (
            <SlotFormCard
              form={slotForm}
              disabled={Boolean(teamProgress)}
              onSubmit={(values) => chat.submitSlotForm(slotForm, values)}
            />
          )}

          {scheduledDraft && (
            <ScheduledDraftCard
              draft={scheduledDraft}
              createdTask={createdTask}
              onConfirm={(nextDraft) => void confirmScheduledTask(nextDraft, item.id)}
              onDismiss={() => dismissScheduledTaskDraft(item.id)}
            />
          )}

          {/* 点评与耗时只挂在组尾：同组中间的补充说明不挂，否则一行按钮
              会把「一轮答复」从中间劈开，也把组间距撑得比换组还大。 */}
          {canRateMessage(item) && !teamProgress && (!assistantWithAvatar || turn.last) && (
            <div className={CHAT_FEEDBACK_CLASS}>
              <button
                type="button"
                className={cn(CHAT_FEEDBACK_BTN_CLASS, item.feedback_rating === 'up' && CHAT_FEEDBACK_BTN_ACTIVE_CLASS)}
                aria-label="点赞"
                onClick={() => rateMessage(item, 'up')}
              >
                <IconThumbUp width={15} height={15} />
              </button>
              <button
                type="button"
                className={cn(
                  CHAT_FEEDBACK_BTN_CLASS,
                  item.feedback_rating === 'down' && CHAT_FEEDBACK_BTN_DISLIKE_ACTIVE_CLASS,
                )}
                aria-label="点踩"
                onClick={() => rateMessage(item, 'down')}
              >
                <IconThumbDown width={15} height={15} />
              </button>
              {traceTiming && <TurnDurationNote timing={traceTiming} />}
            </div>
          )}
          </div>
        </div>
      </div>
      <Dialog
        open={Boolean(previewImage)}
        onOpenChange={(open) => {
          if (!open) setPreviewImage(null);
        }}
      >
        <DialogContent
          className="max-w-[min(960px,94vw)] gap-0 rounded-[16px] bg-white p-[10px] ring-[0.5px] ring-[rgba(24,24,26,0.16)]"
          showCloseButton={false}
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">{previewImage?.name ?? '附件图片'}</DialogTitle>
          {previewImage && (
            <>
              <img
                className="block max-h-[78vh] w-full rounded-[10px] object-contain"
                src={previewImage.src}
                alt={previewImage.name}
              />
              {/* 自带的关闭钮是绝对定位，会压在图片右上角；这里放到图片下方，
                  顺便把文件名露出来（缩略图 72px 时看不出是哪张）。 */}
              <div className="mt-[8px] flex items-center justify-between gap-[10px]">
                <span className="min-w-0 truncate text-[12px] text-[#4b4b50]" data-i18n-ignore>
                  {previewImage.name}
                </span>
                <DialogClose asChild>
                  <button type="button" className={CHAT_ARTIFACT_ZIP_CLASS}>
                    关闭
                  </button>
                </DialogClose>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      {/* 排队态**不再显示「排队中」文案**（用户明确要求）：上一条答案还在流式
          输出时，界面本身就在动，用户知道还没轮到这条；挂一行「排队中」只会在
          队列卡住时误导用户以为在正常等待。虚线边框 + 删除按钮已经足够表达
          「这条还没发出去」。 */}
    </div>
  );
}
