import { useState } from 'react';
import type { ReactNode } from 'react';

import EmployeeAvatar from '@/components/EmployeeAvatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { employeeDisplayNameWithCreator, employeeProfile } from '@/employee';
import type { EmployeeProfile } from '@/employee';
import type { AgentProfileRead, HandoffBrief, HumanHandoffRead } from '@/types';

import {
  CHAT_HANDOFF_ACTIONS_CLASS,
  CHAT_HANDOFF_ASK_CLASS,
  CHAT_HANDOFF_ASK_LABEL_CLASS,
  CHAT_HANDOFF_ASK_TEXT_CLASS,
  CHAT_HANDOFF_ATTACHMENTS_CLASS,
  CHAT_HANDOFF_ATTACHMENT_TILE_CLASS,
  CHAT_HANDOFF_BADGE_AMBER_CLASS,
  CHAT_HANDOFF_BADGE_DANGER_CLASS,
  CHAT_HANDOFF_BADGE_TEAL_CLASS,
  CHAT_HANDOFF_BADGES_CLASS,
  CHAT_HANDOFF_BODY_CLASS,
  CHAT_HANDOFF_CARD_CLASS,
  CHAT_HANDOFF_CHIPS_CLASS,
  CHAT_HANDOFF_CHIP_CLASS,
  CHAT_HANDOFF_CHIP_ICON_CLASS,
  CHAT_HANDOFF_DEPT_CLASS,
  CHAT_HANDOFF_FINDING_CHECK_CLASS,
  CHAT_HANDOFF_FINDING_CLASS,
  CHAT_HANDOFF_FINDING_EMPTY_CLASS,
  CHAT_HANDOFF_FINDING_EMPTY_ICON_CLASS,
  CHAT_HANDOFF_FINDINGS_CLASS,
  CHAT_HANDOFF_FOLD_CLASS,
  CHAT_HANDOFF_META_CLASS,
  CHAT_HANDOFF_META_DOT_CLASS,
  CHAT_HANDOFF_MORE_CLASS,
  CHAT_HANDOFF_NAME_CLASS,
  CHAT_HANDOFF_RIGHT_CLASS,
  CHAT_HANDOFF_SECTION_CLASS,
  CHAT_HANDOFF_SECTION_HEAD_CLASS,
  CHAT_HANDOFF_SECTION_LINE_CLASS,
  CHAT_HANDOFF_SECTION_NO_CLASS,
  CHAT_HANDOFF_SECTION_TITLE_CLASS,
  CHAT_HANDOFF_SLOT_CLASS,
  CHAT_HANDOFF_SLOT_KEY_CLASS,
  CHAT_HANDOFF_SLOT_VALUE_CLASS,
  CHAT_HANDOFF_SLOTS_CLASS,
  CHAT_HANDOFF_TOP_CLASS,
  CHAT_HANDOFF_TOPIC_CLASS,
  CHAT_HANDOFF_TURN_CLASS,
  CHAT_HANDOFF_TURN_COUNT_CLASS,
  CHAT_HANDOFF_TURN_FOOT_CLASS,
  CHAT_HANDOFF_TURN_ROLE_CLASS,
  CHAT_HANDOFF_TURN_TEXT_CLASS,
  CHAT_HANDOFF_TURN_TEXT_HUMAN_CLASS,
  CHAT_HANDOFF_TURN_TEXT_USER_CLASS,
  CHAT_HANDOFF_WAIT_CLASS,
  CHAT_HANDOFF_WAIT_URGENT_CLASS,
  CHAT_HANDOFF_WHO_CLASS,
} from '../chatPageStyles';
import type { ComposerAttachment } from '../chatTypes';

/** 等待多久算紧急（砖红）。4 小时是客服排队的常规升级线。 */
const URGENT_WAITING_SECONDS = 4 * 60 * 60;

/** 折叠态默认露几条结论 */
const COLLAPSED_FINDINGS = 2;
/** 对话经过默认露几条（首问已在「用户在问什么」区块，不重复占位） */
const COLLAPSED_TRANSCRIPT = 3;

const REASON_BADGE: Record<string, { label: string; className: string }> = {
  user_requested: { label: '用户主动转人工', className: CHAT_HANDOFF_BADGE_AMBER_CLASS },
  sop_step: { label: 'SOP 卡点', className: CHAT_HANDOFF_BADGE_TEAL_CLASS },
  bot_escalated: { label: 'AI 判定转人工', className: CHAT_HANDOFF_BADGE_AMBER_CLASS },
};

const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  assistant: 'AI',
  human_reply: '人工',
};

/**
 * 把秒数转成「2 小时 15 分」这种人话。
 *
 * 不写「2h15m」是因为 owner 扫一眼要的是尺度感，不是精确值；
 * 超过一天也只给到天，因为那种单基本已经该升级了。
 */
export function formatWaiting(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '刚刚';
  const total = Math.floor(seconds);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时`;
}

function SectionHead({ no, title, count }: { no: string; title: string; count?: string }) {
  return (
    <div className={CHAT_HANDOFF_SECTION_HEAD_CLASS}>
      <span className={CHAT_HANDOFF_SECTION_NO_CLASS}>{no}</span>
      <span className={CHAT_HANDOFF_SECTION_TITLE_CLASS}>
        {title}
        {count ? ` · ${count}` : ''}
      </span>
      <span className={CHAT_HANDOFF_SECTION_LINE_CLASS} />
    </div>
  );
}

function HandoffAttachmentTray({
  attachments,
  onPick,
  onRemove,
}: {
  attachments: ComposerAttachment[];
  onPick: (files: File[]) => void;
  onRemove: (uploadKey: string) => void;
}) {
  return (
    <div className={CHAT_HANDOFF_ATTACHMENTS_CLASS}>
      {attachments.map((attachment) => (
        <div className={CHAT_HANDOFF_ATTACHMENT_TILE_CLASS} key={attachment.uploadKey} title={attachment.filename}>
          {attachment.data_url ? (
            <img src={attachment.data_url} alt={attachment.filename} className="size-full object-cover" />
          ) : (
            <span className="font-mono text-[9.5px] tracking-[0.04em]">
              {(attachment.filename.split('.').pop() || 'FILE').toUpperCase().slice(0, 4)}
            </span>
          )}
          <button
            type="button"
            onClick={() => onRemove(attachment.uploadKey)}
            className="absolute right-0 top-0 grid size-[15px] place-items-center rounded-bl-[6px] bg-[rgba(24,24,26,0.7)] text-[10px] leading-none text-white"
            aria-label={`移除 ${attachment.filename}`}
          >
            ×
          </button>
        </div>
      ))}
      <label className="grid size-[48px] shrink-0 cursor-pointer place-items-center rounded-[10px] border border-dashed border-[rgba(24,24,26,0.14)] text-[16px] text-[#6d6d72] hover:border-[#0f766e] hover:text-[#0f766e]">
        <input
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            if (files.length) onPick(files);
            event.target.value = '';
          }}
        />
        +
      </label>
      {attachments.length === 0 ? (
        <span className="text-[11px] text-[#6d6d72]">支持图片与附件，会随回复一起投递到会话</span>
      ) : null}
    </div>
  );
}

/** 默认托盘；上层可注入自己的实现（带上传进度、错误态的那版）。 */
export type HandoffAttachmentTrayRenderer = (props: {
  attachments: ComposerAttachment[];
  onPick: (files: File[]) => void;
  onRemove: (uploadKey: string) => void;
}) => ReactNode;

export type HandoffCardProps = {
  handoff: HumanHandoffRead;
  agent: AgentProfileRead | null;
  fallbackProfile: EmployeeProfile | null;
  reply: string;
  attachments: ComposerAttachment[];
  onReplyChange: (value: string) => void;
  onPasteFiles: (files: File[]) => void;
  onPickFiles: (files: File[]) => void;
  onRemoveAttachment: (uploadKey: string) => void;
  onOpenSession: () => void;
  onDismiss: () => void;
  onSubmit: () => void;
  /** 上层可注入带进度/错误态的托盘；缺省用本文件的简版 */
  renderAttachmentTray?: HandoffAttachmentTrayRenderer;
  /** 列表首条默认展开，其余折叠，避免一次滚三屏 */
  defaultOpen?: boolean;
};

export default function HandoffCard({
  handoff,
  agent,
  fallbackProfile,
  reply,
  attachments,
  onReplyChange,
  onPasteFiles,
  onPickFiles,
  onRemoveAttachment,
  onOpenSession,
  onDismiss,
  onSubmit,
  renderAttachmentTray,
  defaultOpen = false,
}: HandoffCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  const brief: HandoffBrief | null = handoff.brief || null;
  const profile = agent ? employeeProfile(agent) : fallbackProfile;
  // 没有 brief 的老单，我们并不知道它是怎么转人工的，不能凭空断言成
  // 「AI 判定转人工」——那时候还没有这个判定。缺 brief 就不出徽标。
  const badge = brief ? REASON_BADGE[brief.reason] || REASON_BADGE.bot_escalated : null;
  const urgent = (brief?.waiting_seconds || 0) >= URGENT_WAITING_SECONDS;
  const findings = brief?.findings || [];
  const slots = brief?.slots || [];
  const transcript = brief?.transcript || [];
  const citations = brief?.citations || [];

  // ask 缺失（老数据没有 brief）时退回既有字段，保证不出现空白的待办区。
  const askText =
    brief?.ask ||
    handoff.pending_question ||
    '请根据当前会话补充人工回复。';

  const visibleFindings = open ? findings : findings.slice(0, COLLAPSED_FINDINGS);
  const visibleTranscript = open ? transcript : transcript.slice(-COLLAPSED_TRANSCRIPT);
  const hasMoreContent =
    findings.length > COLLAPSED_FINDINGS ||
    transcript.length > COLLAPSED_TRANSCRIPT ||
    slots.length > 0 ||
    citations.length > 0;

  // 区块编号按「实际渲染出来的顺序」递增。写死 01/02/03/04/05 会在没有
  // slots（绝大多数单）时从 02 直接跳到 04，看起来像漏了一块。
  let sectionNo = 1;
  const nextNo = () => String(sectionNo++).padStart(2, '0');

  return (
    <article className={CHAT_HANDOFF_CARD_CLASS} data-testid={`handoff-card-${handoff.id}`}>
      <div className={CHAT_HANDOFF_TOP_CLASS}>
        {profile ? <EmployeeAvatar profile={profile} size={34} radius={17} /> : null}
        <div className={CHAT_HANDOFF_WHO_CLASS}>
          <div className={CHAT_HANDOFF_NAME_CLASS}>
            <span>{agent ? employeeDisplayNameWithCreator(agent) : '数字员工'}</span>
            {brief?.topic ? <span className={CHAT_HANDOFF_DEPT_CLASS}>{brief.topic}</span> : null}
          </div>
          <div className={CHAT_HANDOFF_META_CLASS}>
            {handoff.requester_display_name ? <span>{handoff.requester_display_name} 发起</span> : null}
            {brief?.rounds ? (
              <>
                <span className={CHAT_HANDOFF_META_DOT_CLASS} />
                <span>{brief.rounds} 轮对话</span>
              </>
            ) : null}
            {handoff.created_at ? (
              <>
                <span className={CHAT_HANDOFF_META_DOT_CLASS} />
                <span>{new Date(handoff.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className={CHAT_HANDOFF_RIGHT_CLASS}>
          <div className={CHAT_HANDOFF_BADGES_CLASS}>
            {badge ? <span className={badge.className}>{badge.label}</span> : null}
            {/* 同一会话反复转人工值得优先看：线上 17 条里有 4 个会话各 2 单 */}
            {brief && brief.attempt_index > 1 ? (
              <span className={CHAT_HANDOFF_BADGE_DANGER_CLASS}>本会话第 {brief.attempt_index} 次</span>
            ) : null}
          </div>
          {brief ? (
            <span className={urgent ? CHAT_HANDOFF_WAIT_URGENT_CLASS : CHAT_HANDOFF_WAIT_CLASS}>
              已等待 {formatWaiting(brief.waiting_seconds)}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className={CHAT_HANDOFF_FOLD_CLASS}
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-label={open ? '收起详情' : '展开详情'}
        >
          {/* 用 SVG 而不是 ▾/▸：这两个字符在 Geist 下被渲染成 11px 的小点，
              实际截图里几乎看不见，等于把展开入口藏起来了。 */}
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
          >
            <path
              d="M2.2 3.6 L5 6.4 L7.8 3.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className={CHAT_HANDOFF_ASK_CLASS}>
        <span className={CHAT_HANDOFF_ASK_LABEL_CLASS}>需要你处理</span>
        <p className={CHAT_HANDOFF_ASK_TEXT_CLASS}>{askText}</p>
      </div>

      {/* 折叠态也保留「AI 已经排查过」的前 2 条：那是 owner 最需要的一眼信息 */}
      {findings.length > 0 ? (
        <div className={cn(CHAT_HANDOFF_BODY_CLASS, open ? '' : 'mt-[13px]')}>
          <div className={CHAT_HANDOFF_SECTION_CLASS}>
            <SectionHead
              no={nextNo()}
              title={brief?.reason === 'sop_step' ? 'SOP 已经走到哪一步' : 'AI 已经排查过 · 可直接沿用'}
            />
            <ul className={CHAT_HANDOFF_FINDINGS_CLASS}>
              {visibleFindings.map((finding, index) => (
                <li className={CHAT_HANDOFF_FINDING_CLASS} key={`${finding.text}-${index}`}>
                  <span className={CHAT_HANDOFF_FINDING_CHECK_CLASS}>✓</span>
                  <span>{finding.text}</span>
                </li>
              ))}
            </ul>
            {!open && hasMoreContent ? (
              <button type="button" className={CHAT_HANDOFF_MORE_CLASS} onClick={() => setOpen(true)}>
                展开全部 {findings.length} 条结论与对话经过 →
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={cn(CHAT_HANDOFF_BODY_CLASS, open ? '' : 'mt-[13px]')}>
          <div className={CHAT_HANDOFF_SECTION_CLASS}>
            <SectionHead no={nextNo()} title="AI 没有给出明确结论" />
            <div className={CHAT_HANDOFF_FINDING_EMPTY_CLASS}>
              <span className={CHAT_HANDOFF_FINDING_EMPTY_ICON_CLASS}>!</span>
              <span>
                这一轮没有产生可复用的排查结论——AI 的回复只是转接话术。请以下方「对话经过」为准，
                必要时先向用户追问一句。
              </span>
            </div>
            {!open && hasMoreContent ? (
              <button type="button" className={CHAT_HANDOFF_MORE_CLASS} onClick={() => setOpen(true)}>
                展开对话经过 →
              </button>
            ) : null}
          </div>
        </div>
      )}

      {open ? (
        <div className={CHAT_HANDOFF_BODY_CLASS}>
          {brief?.topic ? (
            <div className={CHAT_HANDOFF_SECTION_CLASS}>
              <SectionHead no={nextNo()} title="用户在问什么" />
              <div className={CHAT_HANDOFF_TOPIC_CLASS}>{brief.topic}</div>
            </div>
          ) : null}

          {slots.length > 0 ? (
            <div className={CHAT_HANDOFF_SECTION_CLASS}>
              <SectionHead no={nextNo()} title="已收集信息 · 不必再问一遍" />
              <div className={CHAT_HANDOFF_SLOTS_CLASS}>
                {slots.map((slot) => (
                  <div className={CHAT_HANDOFF_SLOT_CLASS} key={`${slot.key}-${slot.label}`}>
                    <span className={CHAT_HANDOFF_SLOT_KEY_CLASS}>{slot.label}</span>
                    <span className={CHAT_HANDOFF_SLOT_VALUE_CLASS}>{slot.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {transcript.length > 0 ? (
            <div className={CHAT_HANDOFF_SECTION_CLASS}>
              <SectionHead no={nextNo()} title="对话经过" count={`${transcript.length} 条`} />
              <div>
                {visibleTranscript.map((turn, index) => (
                  <div className={CHAT_HANDOFF_TURN_CLASS} key={`${turn.created_at}-${index}`}>
                    <span className={CHAT_HANDOFF_TURN_ROLE_CLASS}>
                      {ROLE_LABEL[turn.role] || turn.role}
                    </span>
                    <span
                      className={cn(
                        CHAT_HANDOFF_TURN_TEXT_CLASS,
                        turn.role === 'user' && CHAT_HANDOFF_TURN_TEXT_USER_CLASS,
                        turn.role === 'human_reply' && CHAT_HANDOFF_TURN_TEXT_HUMAN_CLASS,
                      )}
                    >
                      {turn.text}
                    </span>
                  </div>
                ))}
              </div>
              {/* 计数文案要跟实际列出的条数一致：展开后再说「显示最近 3 / 5 条」
                  就是自相矛盾，所以展开态改说「共 N 条，已全部列出」。 */}
              {brief?.transcript_truncated || transcript.length > COLLAPSED_TRANSCRIPT ? (
                <div className={CHAT_HANDOFF_TURN_FOOT_CLASS}>
                  <span className={CHAT_HANDOFF_TURN_COUNT_CLASS}>
                    {brief?.transcript_truncated
                      ? `共 ${brief.total_messages} 条，显示最近 ${transcript.length} 条`
                      : open
                        ? `共 ${transcript.length} 条，已全部列出`
                        : `显示最近 ${COLLAPSED_TRANSCRIPT} / ${transcript.length} 条`}
                  </span>
                  <button
                    type="button"
                    className={CHAT_HANDOFF_MORE_CLASS}
                    onClick={onOpenSession}
                  >
                    打开原会话查看全部 →
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {citations.length > 0 ? (
            <div className={CHAT_HANDOFF_SECTION_CLASS}>
              <SectionHead no={nextNo()} title={`AI 引用了 ${citations.length} 处知识`} />
              <div className={CHAT_HANDOFF_CHIPS_CLASS}>
                {citations.map((citation) => (
                  <span className={CHAT_HANDOFF_CHIP_CLASS} key={citation.title}>
                    <span className={CHAT_HANDOFF_CHIP_ICON_CLASS}>▤</span>
                    {citation.title}
                    {citation.count > 1 ? <span className="font-mono text-[10.5px]">×{citation.count}</span> : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <Textarea
        rows={3}
        value={reply}
        placeholder={
          handoff.trigger_skill_id || handoff.trigger_step_id
            ? '以当前数字员工的口吻回复。提交后，原会话会继续推进 SOP 流程。'
            : '以当前数字员工的口吻回复。提交后，用户会直接在会话中看到这条答复。'
        }
        onChange={(event) => onReplyChange(event.target.value)}
        // 直接粘贴图片/截图也是常见动作（PDF 报错截图、界面截图），
        // 和对话输入框的行为保持一致。
        onPaste={(event) => {
          const files = Array.from(event.clipboardData?.files || []);
          if (!files.length) return;
          event.preventDefault();
          onPasteFiles(files);
        }}
      />
      {/* 上层注入的那版托盘带上传进度与错误态，必须优先使用；
          本文件的简版只在没有注入时兜底（例如独立渲染/测试）。 */}
      {renderAttachmentTray
        ? renderAttachmentTray({
            attachments,
            onPick: onPickFiles,
            onRemove: onRemoveAttachment,
          })
        : (
          <HandoffAttachmentTray
            attachments={attachments}
            onPick={onPickFiles}
            onRemove={onRemoveAttachment}
          />
        )}
      <div className={CHAT_HANDOFF_ACTIONS_CLASS}>
        <Button variant="outline" onClick={onOpenSession}>
          打开原会话
        </Button>
        <Button variant="ghost" className="text-[#6d6d72] hover:text-[#18181a]" onClick={onDismiss}>
          无需回答
        </Button>
        <Button onClick={onSubmit}>回复并恢复</Button>
      </div>
    </article>
  );
}