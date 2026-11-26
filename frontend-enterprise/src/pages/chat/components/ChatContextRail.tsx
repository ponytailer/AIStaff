import { type ReactNode, useMemo } from 'react';
import { ArrowUpRight, Check, Loader2, X } from 'lucide-react';

import EmployeeAvatar from '@/components/EmployeeAvatar';
import StaffdeckIcon from '@/components/StaffdeckIcon';
import { agentResourceCount, employeeDisplayName } from '@/employee';
import { EnterpriseRoute } from '@/enums/routes';
import { useAgentFaqCount } from '@/lib/agentFaq';
import { persistSharedAgentScope } from '@/lib/agent-scope-storage';
import { formatClientMonthDayClock } from '@/lib/timezone';
import { cn } from '@/lib/utils';

import {
  CHAT_RAIL_BODY_CLASS,
  CHAT_RAIL_BODY_GROW_CLASS,
  CHAT_RAIL_CARD_CLASS,
  CHAT_RAIL_CARD_GROW_CLASS,
  CHAT_RAIL_CARD_HEAD_CLASS,
  CHAT_RAIL_CARD_ICON_CLASS,
  CHAT_RAIL_CARD_META_CLASS,
  CHAT_RAIL_CARD_TONE_CLASS,
  CHAT_RAIL_CARD_TITLE_CLASS,
  CHAT_RAIL_CLASS,
  CHAT_RAIL_EMPTY_CLASS,
  CHAT_RAIL_HEAD_ACTION_CLASS,
  CHAT_RAIL_HEAD_CLASS,
  CHAT_RAIL_HEAD_META_CLASS,
  CHAT_RAIL_HEAD_NAME_CLASS,
  CHAT_RAIL_ICON_CLASS,
  CHAT_RAIL_ROW_CLASS,
  CHAT_RAIL_ROW_TEXT_CLASS,
  CHAT_RAIL_ROW_VALUE_CLASS,
  CHAT_RAIL_ROW_VALUE_ON_CLASS,
  CHAT_RAIL_STEP_TEXT_CLASS,
  CHAT_RAIL_STEP_TEXT_FAILED_CLASS,
} from '../chatPageStyles';
import {
  formatTraceDuration,
  modelDisplayName,
  traceDetails,
  traceLineAllowed,
} from '../chatHelpers';
import type { TraceLine, TurnTrace } from '../chatTypes';
import type { UseChatSession } from '../useChatSession';

/** 右栏最多展示最近几条执行步骤——再多就变成把执行记录抄一遍。 */
const RAIL_STEP_LIMIT = 5;

function RailCard({
  title,
  icon,
  meta,
  grow = false,
  tone = 'teal',
  children,
}: {
  title: string;
  icon: ReactNode;
  meta?: ReactNode;
  /** 最后一张传 true：吃掉剩余高度，右栏底部与左侧输入卡齐平。 */
  grow?: boolean;
  /** 卡头图标色相：动作=琥珀、环境=靛蓝、知识/能力=青绿。 */
  tone?: 'teal' | 'indigo' | 'amber';
  children: ReactNode;
}) {
  return (
    <section className={cn(CHAT_RAIL_CARD_CLASS, grow && CHAT_RAIL_CARD_GROW_CLASS)}>
      <div className={CHAT_RAIL_CARD_HEAD_CLASS}>
        <span className={cn(CHAT_RAIL_CARD_ICON_CLASS, CHAT_RAIL_CARD_TONE_CLASS[tone])}>{icon}</span>
        <span className={CHAT_RAIL_CARD_TITLE_CLASS}>{title}</span>
        {meta}
      </div>
      <div className={cn(CHAT_RAIL_BODY_CLASS, grow && CHAT_RAIL_BODY_GROW_CLASS)}>{children}</div>
    </section>
  );
}

function RailRow({
  icon,
  text,
  value,
  valueOn,
  title,
}: {
  icon?: ReactNode;
  text: string;
  value?: string;
  valueOn?: boolean;
  title?: string;
}) {
  return (
    <div className={CHAT_RAIL_ROW_CLASS} title={title}>
      {icon ? <span className={CHAT_RAIL_ICON_CLASS}>{icon}</span> : null}
      <span className={CHAT_RAIL_ROW_TEXT_CLASS}>{text}</span>
      {value ? (
        <span className={valueOn ? CHAT_RAIL_ROW_VALUE_ON_CLASS : CHAT_RAIL_ROW_VALUE_CLASS}>
          {value}
        </span>
      ) : null}
    </div>
  );
}

function StepMark({ state }: { state: TraceLine['state'] }) {
  if (state === 'failed') {
    return (
      <span className="grid w-[16px] shrink-0 place-items-center text-[#d20b0b]">
        <X className="size-[11px]" strokeWidth={3} />
      </span>
    );
  }
  if (state === 'running') {
    return (
      <span className="grid w-[16px] shrink-0 place-items-center text-[#0f766e]">
        <Loader2 className="size-[11px] animate-spin" strokeWidth={2.6} />
      </span>
    );
  }
  return (
    <span className="grid w-[16px] shrink-0 place-items-center text-[#0f766e]">
      <Check className="size-[11px]" strokeWidth={3} />
    </span>
  );
}

function stepDuration(line: TraceLine): string {
  const ms = line.durationMs
    ?? (line.startedAt && line.completedAt ? line.completedAt - line.startedAt : 0);
  return ms > 0 ? formatTraceDuration(ms) : '';
}

/** 右栏用的紧凑时间：11月16日 13:05。取不到就返回空串，行内直接不显示。 */
function railTime(iso: string | undefined | null): string {
  return formatClientMonthDayClock(iso);
}

/**
 * 把「文档名 / 第 6 页」拆成主体和尾缀。
 *
 * 右栏一行只有 200px 出头，长文件名一定会被 `truncate` 截掉尾部的页码 —— 而页码
 * 恰恰是用户最想知道的「引用了哪一段」。所以尾缀单独占一格、不参与省略：
 * 文件名按需截断，`第 6 页` 永远完整可见。
 */
function splitCitationTitle(title: string): { lead: string; page: string } {
  const match = title.match(/^(.*?)\s*\/\s*(第\s*\d+\s*页(?:\s*[-–~]\s*\d+\s*页)?)$/);
  if (!match) return { lead: title, page: '' };
  return { lead: match[1].trim(), page: match[2].replace(/\s+/g, '') };
}

/**
 * 取最近一条带 trace 的助手消息。
 *
 * 直接读 `turnTraceRef` 而不是另存一份 state：流式过程中父级每次收到事件都会
 * 重渲染，这里跟着读 ref 就能拿到最新步骤，不用再造一个同步通道。
 */
function lastTrace(messages: UseChatSession['displayedMessages'], store: UseChatSession['turnTraceRef']): TurnTrace | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item.role !== 'assistant') continue;
    const trace = store.current.get(item.turnId || item.turn_id || item.id);
    if (trace && trace.lines.length > 0) return trace;
  }
  return null;
}

export default function ChatContextRail({ chat }: { chat: UseChatSession }) {
  const {
    displayedAgent,
    displayedProfile,
    displayedAgentIsDispatcher,
    displayedMessages,
    turnTraceRef,
    uiConfig,
    selectedModelConfig,
    webSearchEnabled,
    currentSessionRunning,
  } = chat;

  const name = displayedAgent ? employeeDisplayName(displayedAgent) : '未选择员工';
  const roleName = displayedProfile?.roleName || '';
  const agentId = displayedAgent?.id || '';

  /**
   * 打开员工档案页（新标签页）。
   *
   * 档案页（`/enterprise/dashboard`）自己从 localStorage 读「当前员工」作用域，
   * 所以先把这位员工落盘再开窗。这里**不广播** scope-change 事件 —— 那个事件
   * 的语义是「切换当前员工」，会把本标签页正在进行的对话切走。
   */
  function openEmployeeProfile() {
    if (!agentId) return;
    persistSharedAgentScope(agentId);
    window.open(EnterpriseRoute.Dashboard, '_blank', 'noopener,noreferrer');
  }

  const trace = useMemo(
    () => lastTrace(displayedMessages, turnTraceRef),
    [displayedMessages, turnTraceRef, currentSessionRunning],
  );

  const steps = useMemo(() => {
    if (!trace) return [];
    return traceDetails(trace.lines.filter((line) => traceLineAllowed(line, uiConfig)))
      .slice(-RAIL_STEP_LIMIT);
  }, [trace, uiConfig]);

  const running = Boolean(trace && !trace.completedAt);
  const totalDuration = trace
    ? (trace.durationMs ?? (trace.completedAt ? trace.completedAt - trace.startedAt : 0))
    : 0;

  /**
   * 有执行记录、但明细被租户配置全部过滤掉了。
   *
   * `traceLineAllowed` 按 `show_skill_trace / show_tool_trace / show_thinking_trace`
   * 过滤，三档都关时（tenant_demo 就是这样）steps 必然为空。此时右上角明明显示
   * 了耗时、卡片里却说「这一轮还没有执行记录」——同一张卡片自相矛盾，用户会当成
   * 功能坏了（2026-11-26 反馈「本轮执行一直没有信息显示」）。
   *
   * 这两种情况必须分开说：没执行 != 执行了但不给你看明细。
   */
  const stepsFiltered = Boolean(trace) && steps.length === 0;

  // FAQ 不是资源绑定（agent_resource_bindings），单独按员工数：命中即短路回答，
  // 用户要知道这个员工到底沉淀了多少条标准答案。
  const faqCount = useAgentFaqCount(displayedAgent?.id);
  const capabilities = displayedAgent
    ? [
      { icon: <StaffdeckIcon name="branch" size={13} />, label: 'SOP', value: agentResourceCount(displayedAgent, 'skill') },
      { icon: <StaffdeckIcon name="spark" size={13} />, label: '技能', value: agentResourceCount(displayedAgent, 'general_skill') },
      { icon: <StaffdeckIcon name="database" size={13} />, label: '资料', value: agentResourceCount(displayedAgent, 'knowledge_base') },
      { icon: <StaffdeckIcon name="tool" size={13} />, label: '工具', value: agentResourceCount(displayedAgent, 'tool') },
      // 无权限（非 owner/管理员）时 faqCount 为 null：整行不出现，而不是显示「未配置」。
      ...(faqCount ? [{ icon: <StaffdeckIcon name="chat" size={13} />, label: 'FAQ', value: faqCount.faq_active }] : []),
    ]
    : [];

  const updatedAt = railTime(displayedMessages[displayedMessages.length - 1]?.created_at);

  /**
   * 本会话引用过的资料（企业知识库 + 互联网来源）。
   *
   * 右栏只有「执行 / 会话 / 能力」三段时，一次普通对话上方只占半屏，下面空一截。
   * 引用是这个会话**真实产生过**的东西，按消息聚合去重后铺出来，既补上密度，
   * 也回答了「它到底读了哪些资料」。
   */
  const citations = useMemo(() => {
    const seen = new Map<string, { key: string; title: string; web: boolean }>();
    for (const message of displayedMessages) {
      for (const citation of message.metadata?.knowledge_citations ?? []) {
        const key = citation.document_id || citation.id;
        if (!key || seen.has(key)) continue;
        seen.set(key, {
          key,
          title: citation.title || citation.label || '未命名资料',
          web: Boolean(citation.url) || citation.kind === 'web',
        });
      }
    }
    return [...seen.values()];
  }, [displayedMessages]);
  const CITATION_LIMIT = 6;
  const shownCitations = citations.slice(0, CITATION_LIMIT);

  return (
    <aside className={CHAT_RAIL_CLASS} aria-label="会话上下文">
      {/* 员工卡：头像 + 姓名 + 岗位，右上角直达档案页（原底部整行按钮）。 */}
      <div className={CHAT_RAIL_CARD_CLASS}>
        <div className={CHAT_RAIL_HEAD_CLASS}>
          <EmployeeAvatar agent={displayedAgent} size={34} radius={11} />
          <div className="min-w-0 flex-1">
            <div className={CHAT_RAIL_HEAD_NAME_CLASS}>{name}</div>
            <div className={CHAT_RAIL_HEAD_META_CLASS}>
              {roleName ? `${roleName} · 本次会话` : '本次会话'}
            </div>
          </div>
          <button
            type="button"
            className={CHAT_RAIL_HEAD_ACTION_CLASS}
            onClick={openEmployeeProfile}
            disabled={!agentId}
            aria-label="打开员工档案"
            title={agentId ? '在新标签页打开员工档案' : '还没有选中员工'}
          >
            <ArrowUpRight className="size-[13px]" strokeWidth={2.4} />
          </button>
        </div>
      </div>

      <RailCard
        title="本轮执行"
        tone="amber"
        icon={<StaffdeckIcon name="tool" size={12} />}
        meta={
          trace ? (
            <span className={cn(CHAT_RAIL_CARD_META_CLASS, running && 'text-[#0f766e]')}>
              {running ? '进行中' : (totalDuration > 0 ? formatTraceDuration(totalDuration) : '')}
            </span>
          ) : undefined
        }
      >
        {steps.length === 0 ? (
          <div className={CHAT_RAIL_EMPTY_CLASS}>
            {stepsFiltered ? (
              <>
                <p>
                  本轮已执行
                  {totalDuration > 0 ? `，耗时 ${formatTraceDuration(totalDuration)}` : ''}。
                </p>
                <p className="mt-[3px] text-[#a3a3a8]">
                  调用明细已在「界面配置」里关闭，开启后可查看每一步。
                </p>
              </>
            ) : (
              <>
                <p>这一轮还没有执行记录。</p>
                <p className="mt-[3px] text-[#a3a3a8]">答复开始后会列出调用的技能与资料。</p>
              </>
            )}
          </div>
        ) : (
          steps.map((line) => {
            const duration = stepDuration(line);
            return (
              <div className={CHAT_RAIL_ROW_CLASS} key={line.id} title={line.detail || line.text}>
                <StepMark state={line.state} />
                <span className={line.state === 'failed' ? CHAT_RAIL_STEP_TEXT_FAILED_CLASS : CHAT_RAIL_STEP_TEXT_CLASS}>
                  {line.text}
                </span>
                {duration ? <span className={CHAT_RAIL_ROW_VALUE_CLASS}>{duration}</span> : null}
              </div>
            );
          })
        )}
      </RailCard>

      <RailCard
        title="会话"
        tone="indigo"
        icon={<StaffdeckIcon name="chat" size={12} />}
        meta={<span className={CHAT_RAIL_CARD_META_CLASS}>{displayedMessages.length} 条</span>}
      >
        <RailRow
          icon={<StaffdeckIcon name="model" size={12} />}
          text="模型"
          value={selectedModelConfig ? modelDisplayName(selectedModelConfig) : '默认模型'}
          title={selectedModelConfig ? modelDisplayName(selectedModelConfig) : undefined}
        />
        <RailRow
          icon={<StaffdeckIcon name="globe" size={12} />}
          text="互联网检索"
          value={webSearchEnabled ? '已开启' : '已关闭'}
          valueOn={webSearchEnabled}
        />
        {updatedAt ? (
          <RailRow
            icon={<StaffdeckIcon name="refresh" size={12} />}
            text="最近更新"
            value={updatedAt}
          />
        ) : null}
      </RailCard>

      <RailCard
        title="引用资料"
        icon={<StaffdeckIcon name="file" size={12} />}
        meta={
          citations.length > 0 ? (
            <span className={CHAT_RAIL_CARD_META_CLASS}>{citations.length} 份</span>
          ) : undefined
        }
      >
        {shownCitations.length === 0 ? (
          <p className={CHAT_RAIL_EMPTY_CLASS}>本次会话还没有引用资料。</p>
        ) : (
          shownCitations.map((item) => {
            const { lead, page } = splitCitationTitle(item.title);
            return (
              <div className={CHAT_RAIL_ROW_CLASS} key={item.key} title={item.title}>
                {/* 与消息里的引用标签同色：企业知识青绿、互联网靛蓝，右栏和正文对得上号 */}
                <span className={cn(CHAT_RAIL_ICON_CLASS, item.web ? 'text-[#4453c4]' : 'text-[#0f766e]')}>
                  <StaffdeckIcon name={item.web ? 'globe' : 'file'} size={12} />
                </span>
                <span className={CHAT_RAIL_ROW_TEXT_CLASS}>{lead}</span>
                {/* 页码不参与省略：文件名再长也要让人看见「第几页」 */}
                {page ? <span className="shrink-0 tabular-nums text-[#9a9a9f]">{page}</span> : null}
              </div>
            );
          })
        )}
        {citations.length > CITATION_LIMIT ? (
          <p className={CHAT_RAIL_EMPTY_CLASS}>另有 {citations.length - CITATION_LIMIT} 份未展示</p>
        ) : null}
      </RailCard>

      <RailCard
        title="员工能力"
        grow
        icon={<StaffdeckIcon name="spark" size={12} />}
        meta={
          capabilities.length > 0 ? (
            <span className={CHAT_RAIL_CARD_META_CLASS}>
              {displayedAgentIsDispatcher ? '协作小队' : '已加载'}
            </span>
          ) : undefined
        }
      >
        {capabilities.length === 0 ? (
          <p className={CHAT_RAIL_EMPTY_CLASS}>还没有配置能力。</p>
        ) : (
          capabilities.map((item) => (
            <RailRow
              key={item.label}
              icon={item.icon}
              text={item.label}
              value={item.value > 0 ? `${item.value}` : '未配置'}
            />
          ))
        )}
      </RailCard>
    </aside>
  );
}
