import { useEffect, useState, type ReactNode } from 'react';

import EmployeeAvatar from '@/components/EmployeeAvatar';
import { notify } from '@/components/ui/app-toast';
import { api } from '@/api/client';
import StaffdeckIcon from '@/components/StaffdeckIcon';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import IconThumbUp from '@/assets/icons/thumb-up.svg?react';
import IconThumbDown from '@/assets/icons/thumb-down.svg?react';
import { employeeDisplayName } from '@/employee';
import { formatClientClock } from '@/lib/timezone';
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
  CHAT_FILE_CHIP_BUTTON_CLASS,
  CHAT_FILE_CHIP_CLASS,
  CHAT_FILE_CHIP_ERROR_CLASS,
  CHAT_FILE_CHIP_GLYPH_CLASS,
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
  CHAT_HUMAN_REPLY_TAG_CLASS,
  CHAT_MESSAGE_ITEM_CLASS,
  CHAT_MESSAGE_MODE_CHIP_CLASS,
  CHAT_PLAIN_ANSWER_CLASS,
  CHAT_SLASH_COMMAND_MESSAGE_CLASS,
  CHAT_SLASH_COMMAND_REQUEST_CLASS,
  CHAT_QUEUED_BUBBLE_CLASS,
  CHAT_QUEUED_DELETE_BTN_CLASS,
  CHAT_QUEUED_MESSAGE_ITEM_CLASS,
  CHAT_STREAM_CURSOR_CLASS,
  CHAT_SUGGESTED_ACTIONS_CLASS,
  CHAT_SUGGESTED_ACTION_BTN_CLASS,
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
  parseA2UIForm,
  suggestedActionsOf,
  uiBlocksForMessage,
} from '../chatHelpers';
import type { A2UIBlock, TraceLine } from '../chatTypes';
import type { A2UIForm } from '../chatTypes';
import {
  formPayloadOf,
  normalizeFormData,
  sceneParamsOf,
  sceneIdOf,
  splitBlocksByMountSlot,
  tailSegments,
} from '../messageBlockSlots';
import type { UseChatSession } from '../useChatSession';
import ExecutionRecord from './ExecutionRecord';
import HarnessArtifactDownloads from './HarnessArtifactDownloads';
import KnowledgeCitationList from './KnowledgeCitationList';
import ScheduledDraftCard from './ScheduledDraftCard';
import SlashCommandChip from './SlashCommandChip';
import SlotFormCard from './SlotFormCard';
import { slashCommandMessage } from '../slashCommands';
import SceneBlockList from '@/scenes/SceneBlockList';
import type { SceneUiBlock } from '@/scenes/types';

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
  /**
   * 这条消息的全部 UI 块（**有序**，由 `uiBlocksForMessage` 解析）。
   *
   * `MessageBubble` 只按 `kind` 决定把它放在哪个挂载位（见
   * `messageBlockSlots.ts` 的四格表），不再自己判断「有没有引用」「有没有表单」。
   *
   * 可选：现有测试直接构造 `MessageRender` 时不传它，此时组件回落到自己解析
   * （`render.blocks ?? uiBlocksForMessage(item, ...)`），既有用例一行不用改。
   */
  blocks?: A2UIBlock[];
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

/**
 * 消息时间：24 小时制 HH:mm；解析不了就不显示（历史脏数据不占位）。
 *
 * 走 `formatClientClock`（内部 `parseBackendDateTime`）而不是裸 `new Date`：
 * 后端落库是 naive UTC，`new Date('...T01:01:00')` 在东八区会被当成本地时间，
 * 整条会话的时间戳都早 8 小时。
 */
function messageClock(iso: string | undefined): string {
  return formatClientClock(iso);
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

/**
 * 一条消息携带的附件清单：图片进 72px 瓷砖网格，其它文件进胶囊（两类不混排，
 * 与 tuff 的 attachment tray 一致）。
 *
 * 为什么单独成组件：它有两个宿主 —— 普通气泡与「人工回复」气泡。人工回复走的是
 * early-return 分支，只渲染了 MarkdownMessage，于是**纯附件的人工回复**
 * （`content === ""`，只发了图/文件不写字）会渲成一个空气泡、附件完全不可见。
 * 大图预览的 Dialog 也收进组件内部：谁渲染附件谁负责预览，两个宿主不必各自
 * 维护一份 previewImage 状态。
 *
 * 下载：文件胶囊可点。消息 metadata 只有描述符，字节在服务端，必须走接口取
 * （`/api/chat/sessions/{id}/attachments/{attachment_id}`）。没有下载入口时，
 * 人工回复带的附件对用户来说等于不存在——线上就是这个症状。
 */
function MessageAttachments({
  attachments,
  flush = false,
  sessionId,
  tenantId,
}: {
  attachments: ChatAttachmentRead[];
  /** 上方没有正文时去掉 10px 顶间距，避免「空气泡里飘着一块缩略图」。 */
  flush?: boolean;
  /** 下载附件需要会话与租户；缺省时文件胶囊降级成不可点（旧调用方兼容）。 */
  sessionId?: string;
  tenantId?: string;
}) {
  // data: URL 不能新标签打开（浏览器禁止顶层导航到 data URL），所以走弹窗。
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const [downloadingId, setDownloadingId] = useState('');
  if (attachments.length === 0) return null;

  const canDownload = Boolean(sessionId && tenantId);

  async function downloadAttachment(attachment: ChatAttachmentRead) {
    if (!canDownload || downloadingId) return;
    setDownloadingId(attachment.id);
    try {
      const blob = await api.blob(
        `/api/chat/sessions/${encodeURIComponent(sessionId as string)}/attachments/`
          + `${encodeURIComponent(attachment.id)}?tenant_id=${encodeURIComponent(tenantId as string)}`,
      );
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = attachment.filename || 'attachment';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '附件下载失败');
    } finally {
      setDownloadingId('');
    }
  }

  const imageAttachments = attachments.filter(hasImagePreview);
  const fileAttachments = attachments.filter((attachment) => !hasImagePreview(attachment));
  return (
    <>
      <div className={cn(CHAT_ATTACHMENT_LIST_CLASS, flush && 'mt-0')}>
        {imageAttachments.length > 0 && (
          <div className={CHAT_ATTACHMENT_GRID_CLASS}>
            {imageAttachments.map((attachment) => (
              <button
                type="button"
                className={cn(
                  CHAT_ATTACHMENT_TILE_CLASS,
                  attachment.error && CHAT_ATTACHMENT_TILE_ERROR_CLASS,
                )}
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
        {fileAttachments.length > 0 && (
          <div className={CHAT_ATTACHMENT_GRID_CLASS}>
            {fileAttachments.map((attachment) => {
              const isDownloading = downloadingId === attachment.id;
              const chipClassName = cn(
                CHAT_FILE_CHIP_CLASS,
                attachment.error && CHAT_FILE_CHIP_ERROR_CLASS,
                canDownload && !attachment.error && CHAT_FILE_CHIP_BUTTON_CLASS,
                canDownload && attachment.error && 'cursor-not-allowed',
              );
              const body = (
                <>
                  <span className={CHAT_FILE_CHIP_BODY_CLASS}>
                    <span className={CHAT_FILE_CHIP_ICON_CLASS}>
                      <StaffdeckIcon name={attachment.kind === 'pdf' ? 'file' : 'folder'} size={14} />
                    </span>
                    <span className={CHAT_FILE_CHIP_NAME_CLASS} data-i18n-ignore>
                      {attachment.filename}
                    </span>
                    <span className={CHAT_FILE_CHIP_META_CLASS} data-i18n-ignore>
                      {isDownloading ? '下载中' : (attachment.error || attachmentTypeLabel(attachment))}
                    </span>
                  </span>
                  {canDownload && !attachment.error ? (
                    <span className={CHAT_FILE_CHIP_GLYPH_CLASS} aria-hidden="true">
                      <StaffdeckIcon name="download" size={12} />
                    </span>
                  ) : null}
                </>
              );
              // 有会话上下文才渲染成按钮：缺省时保持原来的静态胶囊，
              // 避免在分享页 / 旧调用方里出现点了没反应的可点样式。
              if (!canDownload || attachment.error) {
                return (
                  <span className={chipClassName} key={attachment.id} title={attachment.filename}>
                    {body}
                  </span>
                );
              }
              return (
                <button
                  type="button"
                  className={chipClassName}
                  key={attachment.id}
                  disabled={isDownloading}
                  aria-busy={isDownloading}
                  aria-label={`下载附件 ${attachment.filename}`}
                  title={`${attachment.filename}（点击下载）`}
                  onClick={() => void downloadAttachment(attachment)}
                >
                  {body}
                </button>
              );
            })}
          </div>
        )}
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
    </>
  );
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

/**
 * 场景块提交时用的表单描述。
 *
 * ## 为什么要容得下「没有 form 块」
 *
 * 原先这里直接 `if (!form) return;` —— 对表单块是对的，但**空结果卡的
 * 建议按钮也走这个入口**，而那一轮没有 form 块。后果是点了按钮什么都不
 * 发生，且不报错：用户只会觉得按钮坏了。这是线上真实故障。
 *
 * 空卡的按钮不需要 form 的元信息（它是「改槽重跑」，不是「填表提交」）：
 * `slotSubmissionText` 只用 `fields` 拼一句可读文本，真正被后端消费的是
 * `slot_submission` 里的结构化取值。所以这里按本次改动项合成一份最小表单，
 * 让「改槽 → 重跑」与「填表 → 提交」走**完全相同的通路**。
 *
 * `slot_labels` 给合成表单一副中文标签（后端随空卡下发 `empty.slot_labels`）：
 * 不给的话用户气泡里会出现 `people：4；days：6` 这种英文键名。
 *
 * @returns `null` 表示这次提交没法进行（既没有 form，`values` 也是空的）。
 */
export function sceneFormForSubmit(
  blocks: A2UIBlock[],
  values: Record<string, unknown>,
): A2UIForm | null {
  const form = blocks
    .map((block) => formPayloadOf(block))
    .map((payload) => (payload ? parseA2UIForm(payload) : null))
    .find((candidate) => candidate !== null);
  if (form) return form;

  const labels: Record<string, string> = {};
  for (const block of blocks) {
    const raw = block.data?.slot_labels;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) labels[key] = value.trim();
    }
  }
  const fields = Object.keys(values).map((name) => ({
    name,
    label: labels[name] || name,
    // 类型只影响 `slotSubmissionText` 的格式化（数值/布尔有特殊分支），
    // 提交载荷用的是 `values` 原值，不受这里影响。
    type: (typeof values[name] === 'boolean' ? 'boolean' : 'number') as A2UIForm['fields'][number]['type'],
    required: true,
  }));
  if (fields.length === 0) return null;
  return { kind: 'slot_form', fields };
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
  // 调度入口的「转接通知」：由路由自己说「已转交给 X」，成员答案在它后面一条。
  // 它不是答案，所以不参与点赞、不显示 trace、也不走普通答案气泡的排版。
  const noticeInfo = item.role === 'assistant' && isDispatchNotice(item)
    ? dispatchNoticeInfo(item)
    : null;
  const isDispatchNoticeMessage = item.role === 'assistant' && isDispatchNotice(item);
  // 人工接管回复（owner 从待回答收件箱回复）：落库是 user 角色，展示走员工一侧。
  const isHumanReply = item.role === 'user' && Boolean(item.metadata?.human_reply);
  const quickActions = suggestedActionsOf(item);
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
  const clock = item.role === 'assistant' || isHumanReply ? messageClock(item.created_at) : '';
  const teamProgress = item.role === 'assistant' ? activeTeamProgress(item) : null;
  // 用户署名（参考 Claude 风格 thread）：姓名 + 首字符头像，右对齐坐在气泡上方。
  const authUser = chat.authUser;
  const senderName = (authUser?.display_name || authUser?.username || '你').trim() || '你';
  const senderInitial = senderName.charAt(0);

  /**
   * 这条消息的块数组 —— **渲染的唯一输入**。
   *
   * - `render.blocks` 存在就用它（`MessageList` 已经算过，含「已忽略的草案」过滤
   *   与按正文算好的引用编号）；
   * - 不存在时（单测直接构造 `MessageRender`）就用上面那几个具名字段**就地合成**
   *   同样形状的块。
   *
   * 为什么合成而不是「重新从 item 解析一遍」：`citations` / `harnessArtifacts` /
   * `slotForm` / `scheduledDraft` 已经是**调用方判定过的结果**（比如「只有最新一条
   * 助手消息才挂表单」），重新解析会绕过那些判定 —— 那是行为变更，不是重构。
   * 合成保证两条路径渲染出完全一样的 DOM。
   */
  const synthesizedBlocks: A2UIBlock[] = [];
  if (dispatchInfo) {
    // 挂载位 A。`MessageList` 会连同同轮去重一起算好并直接给 `blocks`；
    // 这里是为了「测试/其它容器只传 `dispatchInfo`」时也不丢这个 chip。
    synthesizedBlocks.push({
      kind: 'dispatch',
      data: {
        memberName: dispatchInfo.memberName,
        memberAgentId: dispatchInfo.memberAgentId,
        intent: dispatchInfo.intent,
      },
    });
  }
  if (teamProgress) {
    synthesizedBlocks.push({ kind: 'team_progress', data: { ...teamProgress } });
  }
  if (harnessArtifacts.length > 0) {
    synthesizedBlocks.push({ kind: 'harness_artifacts', data: { artifacts: harnessArtifacts } });
  }
  if (citations.length > 0) {
    synthesizedBlocks.push({ kind: 'knowledge_citations', data: { citations } });
  }
  if (slotForm) {
    synthesizedBlocks.push({ kind: 'slot_form', data: { form: slotForm } });
  }
  if (scheduledDraft) {
    synthesizedBlocks.push({ kind: 'scheduled_task_draft', data: { draft: scheduledDraft } });
  }
  if (quickActions.length > 0) {
    synthesizedBlocks.push({ kind: 'suggested_actions', data: { actions: quickActions } });
  }
  const blocks: A2UIBlock[] = render.blocks ?? synthesizedBlocks;
  const { head: headBlocks, body: bodyBlocks, below: belowBlocks, tail: tailBlocks }
    = splitBlocksByMountSlot(blocks);
  const tailGroups = tailSegments(tailBlocks);

  /**
   * 平台内置渲染器（注入给场景 module 用，见 `SceneBlockList` 的 render prop 说明）。
   *
   * `form` 块落回 `SlotFormCard`：后端 `form` 块的 `data` 就是
   * `build_slot_form()` 的输出，与 legacy `metadata.a2ui` 同形，走同一份解析
   * （`parseA2UIForm`）与同一个提交入口（`chat.submitSlotForm`）。
   * 返回 `null` 表示「我不管这块」，`SceneBlockList` 会继续往下兜底
   * （`text`/`handoff` 走平台默认渲染器，其余走兜底文本）。
   *
   * ## 为什么必须带 `sceneIdOf(item)`
   *
   * 这里曾经漏传第三个参数，后果是**同一个表单因类型不同走了两条不一样的路**：
   *
   * | 场景类型 | 表单从哪出 | 提交时带 forced_scene_id |
   * |---|---|---|
   * | 行程规划（table_match） | `result` 块里的 `slot_form` → `onSubmitSlots` | 带了 ✅ |
   * | 客房送物（tool_submit） | `form` 块 → **本函数** | **没带** ❌ |
   *
   * 表单提交轮发出的文本是「房间号：8302；需要送的物品：矿泉水」——**不含任何
   * 触发关键词**。不带 `forced_scene_id`，后端 `resolve_scene_hit` 匹配不到场景，
   * 于是落回通用问答：模型拿着这句话自由发挥，回一句「已记录，会尽快安排送达」，
   * 既不调接口、也没有回执卡。用户看到的就是「填完表走了普通对话」。
   *
   * 这才是「表单提交类型的流程和行程规划明显不一样」的真正原因 —— 不在后端
   * 通道里，而在前端表单提交这一个参数上。
   */
  const renderFormForScene = (data: Record<string, unknown>): ReactNode => {
    // 必须走 `normalizeFormData` 而不是直接 `parseA2UIForm(data)`：
    // 表单描述可能平铺在 `data` 上（后端 `form` 块），也可能嵌在 `data.form`
    // 里（前端合成的 `slot_form` 块）。曾经这里少了这一层剥壳，导致
    // 「slot_form 块能填、form 块整块不渲染」—— 同一份数据两个入口两种表现。
    const form = parseA2UIForm(normalizeFormData(data));
    if (!form) return null;
    return (
      <SlotFormCard
        form={form}
        disabled={Boolean(teamProgress)}
        onSubmit={(values) => chat.submitSlotForm(form, values, sceneIdOf(item))}
      />
    );
  };

  const renderBuiltinForScene = (block: SceneUiBlock): ReactNode => {
    // 目前只有 `form` 类内置块需要平台接管；其余（定时任务草案 / 可点动作）
    // 都是聊天页自己的块，不会出现在场景块的 data 里。
    if (block.kind === 'form') return renderFormForScene(block.data ?? {});
    return null;
  };

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

  // 人工接管回复：owner 在「待回答」收件箱里替员工答的话。落库是 user 角色
  // （agent loop 的输入），但展示必须站在员工一侧 —— owner 恰好是会话提问者
  // 时，按普通用户气泡渲染会变成「自己回答自己」。员工头像 + 琥珀色
  // 「人工回复」标签，让它和 AI 答案一眼区分。
  if (isHumanReply) {
    return (
      <div className={cn(CHAT_MESSAGE_ITEM_CLASS, turn.spaced && CHAT_TURN_SPACED_CLASS)}>
        <div className={cn(chatRowClass('assistant'), CHAT_GROUP_MESSAGE_ROW_CLASS)}>
          <EmployeeAvatar
            agent={chat.displayedAgent}
            size={28}
            radius={14}
            className={CHAT_GROUP_MESSAGE_AVATAR_CLASS}
          />
          <div className={CHAT_GROUP_MESSAGE_CONTENT_CLASS}>
            <div className={CHAT_TURN_HEAD_CLASS}>
              <span className={CHAT_TURN_AUTHOR_CLASS} data-i18n-ignore>
                <span className="truncate">{agentHeaderName}</span>
              </span>
              <span className={CHAT_HUMAN_REPLY_TAG_CLASS} data-i18n-ignore>
                <StaffdeckIcon name="user" size={11} />
                人工回复
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
            <div className={chatBubbleClass('assistant', item.isError)}>
              {visibleContent ? <MarkdownMessage content={visibleContent} /> : null}
              {/* 人工回复允许只发图片/附件不写字：此时 content 为空，附件是这条
                  消息的全部内容，去掉顶间距免得气泡里空出一截。 */}
              <MessageAttachments
                attachments={attachments}
                flush={!visibleContent}
                sessionId={chat.activeConversationId}
                tenantId={chat.tenantId}
              />
            </div>
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
          {/* ── 挂载位 A：气泡头部 ───────────────────────────────────────
              调度入口的答案来自某位同事：明确标出来，否则用户会以为入口自己在答。
              放在正文上方而不是下面——读者要先知道「谁在说话」。
              **同轮去重由 MessageList 负责**：一轮里已经渲染过「路由 · 已转交给 X」
              气泡时，MessageList 不会产出这个 dispatch 块（用户反馈：两者并存看起来
              像「有两段转接记录」）。本组件只负责渲染，不做跨组件判断。 */}
          {!statusOnly && headBlocks.map((block, index) => {
            if (block.kind !== 'dispatch') return null;
            const data = block.data ?? {};
            const memberName = typeof data.memberName === 'string' ? data.memberName : '';
            const intent = typeof data.intent === 'string' ? data.intent : '';
            if (!memberName) return null;
            return (
              <div
                key={`head:${index}`}
                className="mb-[7px] flex flex-wrap items-center gap-[5px] text-[11.5px]"
              >
                <span className="inline-flex items-center gap-[4px] rounded-[6px] bg-[#dceee9] px-[6px] py-[2px] text-[#0f766e]">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  由 {memberName} 回答
                </span>
                {intent && <span className="truncate text-[#9a9a9f]">{intent}</span>}
              </div>
            );
          })}
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
              <div aria-live={bodyBlocks.length > 0 ? 'polite' : undefined} data-i18n-ignore>
                <MarkdownMessage content={visibleContent} />
                {item.isStreaming && (
                  <span className={CHAT_STREAM_CURSOR_CLASS} aria-hidden="true" />
                )}
                {/* ── 挂载位 B：正文内状态行 ──────────────────────────
                    必须留在正文里（而不是尾部）：它是「这轮还在跑」的实时状态，
                    挂在正文下方会和「已完成」的成果块混在一起。 */}
                {bodyBlocks.map((block, index) => {
                  if (block.kind !== 'team_progress') return null;
                  const statusText = typeof block.data?.statusText === 'string'
                    ? block.data.statusText
                    : '';
                  if (!statusText) return null;
                  return (
                    <div
                      key={`body:${index}`}
                      role="status"
                      aria-label={statusText}
                      className="mt-[8px] flex items-center gap-[7px] text-[12px] text-[#6d7791]"
                    >
                      <span className="relative flex size-[7px]">
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#1a71ff] opacity-40" />
                        <span className="relative inline-flex size-[7px] rounded-full bg-[#1a71ff]" />
                      </span>
                      <span>{statusText}</span>
                    </div>
                  );
                })}
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

          {!statusOnly && (
            <MessageAttachments
                attachments={attachments}
                flush={!visibleContent}
                sessionId={chat.activeConversationId}
                tenantId={chat.tenantId}
              />
          )}

          {/* ── 挂载位 C：正文下方 ─────────────────────────────────────
              harness 产物与知识引用都留在这里（**不要**挪进尾列）：
              它们是「答案的依据」，紧跟正文才读得通；挪到按钮之后会变成
              「先看按钮再看依据」。看起来更整齐，但改掉了现有视觉。 */}
          {belowBlocks.map((block, index) => {
            if (block.kind === 'harness_artifacts') {
              const artifacts = Array.isArray(block.data?.artifacts)
                ? block.data.artifacts as typeof harnessArtifacts
                : [];
              if (artifacts.length === 0) return null;
              return (
                <HarnessArtifactDownloads
                  key={`below:artifacts:${index}`}
                  artifacts={artifacts}
                  tenantId={chat.tenantId}
                  sessionId={chat.activeConversationId}
                />
              );
            }
            if (block.kind === 'knowledge_citations') {
              const items = Array.isArray(block.data?.citations)
                ? block.data.citations as typeof citations
                : [];
              if (items.length === 0) return null;
              return (
                <KnowledgeCitationList
                  key={`below:citations:${index}`}
                  citations={items}
                  onOpen={setActiveCitation}
                />
              );
            }
            return null;
          })}

          {/* ── 挂载位 D：尾部 ─────────────────────────────────────
              场景块 / 表单 / 定时任务草案 / 可点动作。
              顺序即块数组的顺序（后端逐帧累加的顺序就是渲染顺序）。

              分两种渲染路径：
              - `scene` 段 → 交给 `SceneBlockList`（有 module_key 查注册表，没有走
                内置渲染器，再没有走兜底文本）；
              - `builtin` 段 → 聊天页自己的组件（表单 / 草案 / 可点动作）。

              为什么要分段而不是逐块：见 `tailSegments()` 的注释
              （`SceneBlockList` 自带 `gap-[9px]`，插入它的块会被改掉间距）。 */}
          {tailGroups.map((group, groupIndex) => {
            if (group.type === 'scene') {
              return (
                <SceneBlockList
                  key={`tail:scene:${groupIndex}`}
                  blocks={group.blocks}
                  params={sceneParamsOf(item)}
                  onSendText={(text) => chat.sendQuickText(text)}
                  onSubmitSlots={(values) => {
                    const form = sceneFormForSubmit(group.blocks, values);
                    if (!form) return;
                    // scene id 必须一路带下去：提交文本无关键词，不带
                    // `forced_scene_id` 后端必然落回普通对话（用户填的表白填）。
                    void chat.submitSlotForm(form, values, sceneIdOf(item));
                  }}
                  onOpenExternal={(url) => {
                    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
                  }}
                  disabled={Boolean(teamProgress)}
                  renderBuiltin={renderBuiltinForScene}
                  renderForm={renderFormForScene}
                />
              );
            }
            const block = group.block;
            if (block.kind === 'slot_form') {
              // 灰度期兜底：老数据只写 `metadata.a2ui`，或 v3 的 `form` 块还没带
              // `module_key`（走不到注册表）——两种都落回同一个 `SlotFormCard`。
              const form = parseA2UIForm(formPayloadOf(block));
              if (!form) return null;
              return (
                <SlotFormCard
                  key={`tail:form:${groupIndex}`}
                  form={form}
                  disabled={Boolean(teamProgress)}
                  onSubmit={(values) => chat.submitSlotForm(form, values, sceneIdOf(item))}
                />
              );
            }
            if (block.kind === 'scheduled_task_draft') {
              const draft = block.data?.draft as typeof scheduledDraft | undefined;
              if (!draft) return null;
              return (
                <ScheduledDraftCard
                  key={`tail:draft:${groupIndex}`}
                  draft={draft}
                  createdTask={createdTask}
                  onConfirm={(nextDraft) => void confirmScheduledTask(nextDraft, item.id)}
                  onDismiss={() => dismissScheduledTaskDraft(item.id)}
                />
              );
            }
            if (block.kind === 'suggested_actions') {
              const actions = Array.isArray(block.data?.actions)
                ? block.data.actions as ReturnType<typeof suggestedActionsOf>
                : [];
              if (actions.length === 0) return null;
              // 可点动作贴正文，不走点评行的组尾判定：它就是答案的一部分
              // （「要不要我帮你转人工」），分开会出现「按钮跟着点赞走」的错位。
              return (
                <div key={`tail:actions:${groupIndex}`} className={CHAT_SUGGESTED_ACTIONS_CLASS}>
                  {actions.map((action) => (
                    <button
                      key={`${action.type}:${action.text}`}
                      type="button"
                      className={CHAT_SUGGESTED_ACTION_BTN_CLASS}
                      onClick={() => chat.sendQuickText(action.text)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              );
            }
            return null;
          })}

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
      {/* 排队态**不再显示「排队中」文案**（用户明确要求）：上一条答案还在流式
          输出时，界面本身就在动，用户知道还没轮到这条；挂一行「排队中」只会在
          队列卡住时误导用户以为在正常等待。虚线边框 + 删除按钮已经足够表达
          「这条还没发出去」。 */}
    </div>
  );
}
