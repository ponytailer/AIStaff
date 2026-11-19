import EmployeeAvatar from '@/components/EmployeeAvatar';
import { employeeDisplayName, greetingPreviewText } from '@/employee';

import {
  CHAT_EMPTY_CARD_CLASS,
  CHAT_EMPTY_CLASS,
  CHAT_EMPTY_GREETING_AUTHOR_CLASS,
  CHAT_EMPTY_GREETING_BODY_CLASS,
  CHAT_EMPTY_GREETING_CARD_CLASS,
  CHAT_EMPTY_GREETING_LINE_CLASS,
  CHAT_EMPTY_ROLE_CLASS,
  CHAT_EMPTY_STAT_CELL_CLASS,
  CHAT_EMPTY_SUBTITLE_CLASS,
  CHAT_EMPTY_TAGS_CLASS,
  CHAT_EMPTY_TITLE_CLASS,
} from '../chatPageStyles';
import type { UseChatSession } from '../useChatSession';
import ChatPromptSuggestions from './ChatPromptSuggestions';

function greetingFontSize(displayName: string): number {
  const length = Array.from(displayName).length;
  // 问候语不再是海报字：demo 的欢迎区是一句正常大小的标题（18-20px），
  // 过大字号会把「员工主体」压成营销页。
  return length > 20 ? 18 : length > 12 ? 20 : length > 6 ? 24 : 26;
}

export default function ChatEmptyState({ chat }: { chat: UseChatSession }) {
  // 多智能体不是普通员工：不套「#角色 / 资料 / 技能 / SOP」那套话术，
  // 改为展示它自己表单里的「入口说明」与「成员有谁」。
  if (chat.displayedAgentIsDispatcher) {
    return <DispatcherEmptyCard chat={chat} />;
  }
  return <EmployeeEmptyCard chat={chat} />;
}

/** 统计格里既可以放数字（同事数），也可以放短文案（兜底方式 / 模型名）。 */
function EmptyStatCell({
  label,
  value,
  weight = 1,
}: {
  label: string;
  value: string | number;
  /** 相对宽度权重。文案格（兜底方式 / 模型名）比数字格更需要横向空间。 */
  weight?: number;
}) {
  const isText = typeof value === 'string';
  return (
    // flex / padding 走行内 style：CHAT_EMPTY_STAT_CELL_CLASS 自带 flex-1 与
    // px-[20px]，再叠 flex-/px- 工具类时谁生效取决于样式表生成顺序，不可控。
    // min-w-0 必须有：flex 项默认 min-width:auto，长模型名会把相邻格压扁
    // （「无法匹配」曾被压成一字一行）。
    <div
      className={`${CHAT_EMPTY_STAT_CELL_CLASS} min-w-0`}
      style={{ flex: `${weight} 1 0%`, paddingInline: isText ? 10 : 14 }}
    >
      <span
        className={
          isText
            // 最多两行 + title 兜底：模型名（如 deepseek-v4.1-flash-1017）
            // 单行放不下，截断会把关键信息藏掉，允许折到第二行。
            ? 'line-clamp-2 block w-full text-[11.5px] font-medium leading-[1.35] text-[#18181a] [overflow-wrap:anywhere]'
            : 'block w-full text-[18px] font-medium leading-none capitalize'
        }
        // text-transform 走行内 style：外层 CHAT_EMPTY_CARD_CLASS 链上有 capitalize，
        // 模型名会被改写成 Deepseek-V4.1-Flash-1017（后端原名是小写），
        // 用 class 覆盖的优先级不可控，直接写 style 最稳。
        style={isText ? { textTransform: 'none' } : undefined}
        title={isText ? String(value) : undefined}
      >
        {value}
      </span>
      <span className="whitespace-nowrap text-[10px] leading-none">{label}</span>
    </div>
  );
}

function DispatcherEmptyCard({ chat }: { chat: UseChatSession }) {
  const {
    displayedAgent,
    displayedDispatcher,
    displayedDispatcherLoaded,
    emptyDispatcherSummary,
    emptyDispatcherStats,
    agents,
  } = chat;
  const displayName = displayedAgent ? employeeDisplayName(displayedAgent) : '';
  const members = displayedDispatcher?.members || [];
  const agentById = (agentId: string) => agents.find((agent) => agent.id === agentId) || null;
  // 头像叠放；成员不在当前花名册里时 EmployeeAvatar 自己回落预设头像
  const avatarMembers = members.slice(0, 3);
  // 成员名 chips：routing_rule 挂在 title 上，鼠标停一下能看到「什么情况转给他」。
  // 详情还没回来时不要谎称「没有成员」——配置好的入口一进来就会看到这句话。
  const tags = members.length
    ? members.map((member) => ({ name: member.agent_name, hint: member.routing_rule }))
    : displayedDispatcherLoaded === false
      ? [{ name: '成员加载中', hint: '' }]
      : [{ name: '还没有成员', hint: '' }];

  return (
    <div className={CHAT_EMPTY_CLASS}>
      <div className={CHAT_EMPTY_GREETING_CARD_CLASS}>
        <div className="flex min-h-[102px] w-full gap-[10px]">
          <div className="relative h-[102px] w-[136px] shrink-0 self-end">
            {avatarMembers.length > 0 ? (
              <div className="absolute inset-x-0 bottom-[14px] flex items-center justify-center">
                {avatarMembers.map((member) => (
                  <EmployeeAvatar
                    key={member.member_agent_id}
                    agent={agentById(member.member_agent_id)}
                    size={56}
                    className="-ml-[14px] shrink-0 rounded-full ring-4 ring-[#e5e4e0] first:ml-0"
                  />
                ))}
              </div>
            ) : (
              <div className="absolute inset-x-0 bottom-[14px] flex items-center justify-center">
                <span className="grid size-[56px] place-items-center rounded-full bg-[#dceee9] text-[#0f766e] ring-4 ring-[#e5e4e0]">
                  <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <circle cx="8" cy="3.2" r="1.9" />
                    <circle cx="3.4" cy="12.4" r="1.9" />
                    <circle cx="12.6" cy="12.4" r="1.9" />
                    <path d="M7 4.8 4.2 10.9M9 4.8l2.8 6.1" />
                  </svg>
                </span>
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-[8px] py-[12px] capitalize">
            <strong
              className={`${CHAT_EMPTY_TITLE_CLASS} max-w-full [overflow-wrap:anywhere]`}
              style={{ fontSize: `${greetingFontSize(displayName)}px` }}
              title={displayName}
            >
              Hello 我是{displayName}！
            </strong>
            <span className={CHAT_EMPTY_SUBTITLE_CLASS}>我们来做什么？</span>
          </div>
        </div>
      </div>

      <div className={CHAT_EMPTY_CARD_CLASS}>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-[8px] px-[4px]">
          <p className={CHAT_EMPTY_ROLE_CLASS} title={emptyDispatcherSummary}>
            {emptyDispatcherSummary}
          </p>
          <div className={CHAT_EMPTY_TAGS_CLASS}>
            {tags.map((tag, index) => (
              <span key={`${tag.name}-${index}`} title={tag.hint || undefined}>
                {tag.name}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-1 items-stretch">
          {emptyDispatcherStats.map((item) => (
            <EmptyStatCell
              key={item.label}
              label={item.label}
              value={item.value}
              weight={typeof item.value === 'number' ? 0.75 : 1.35}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function EmployeeEmptyCard({ chat }: { chat: UseChatSession }) {
  const {
    displayedAgent,
    displayedProfile,
    emptyRoleSummary,
    currentSessionRunning,
    shareMode,
    sendQuickText,
    authUser,
  } = chat;
  const displayName = displayedAgent ? employeeDisplayName(displayedAgent) : '';
  // 岗位描述是员工在档案里自己写的，可能是空白（没填）。空白时整行不渲染，
  // 不要在问候语下面留一条空隙或一个占位符。
  const hasRoleSummary = Boolean(emptyRoleSummary && emptyRoleSummary.trim());
  // 只从 profile 取：配置端的规整（去空/限长/最多 3 条）都在
  // `employeeProfile()` 与 `normalizeSuggestedPrompts()` 里做过一次，
  // 这里再过滤会让「配了 3 条只显示 2 条」这类问题无从排查。
  const suggestedPrompts = displayedProfile?.suggestedPrompts || [];
  // 员工配了开场白就在空态里先显示出来。文案由 `greetingPreviewText` 拼，
  // 与后端落库的正文同格式；首轮发出去之后这条预览随空态一起消失，
  // 由消息列表里的真实消息接管（不会出现两条）。
  const greetingPreview = greetingPreviewText(
    displayedProfile?.greetingMessage || '',
    authUser?.display_name || authUser?.username,
  );

  return (
    <div className={CHAT_EMPTY_CLASS}>
      <div className={CHAT_EMPTY_GREETING_CARD_CLASS}>
        <div className="flex min-h-[102px] w-full gap-[10px]">
          <div className="relative h-[102px] w-[136px] shrink-0 self-end">
            <div className="absolute bottom-0 left-0 h-[160px] w-[136px]">
            <EmployeeAvatar
              profile={displayedProfile ?? undefined}
              agent={displayedAgent ?? undefined}
              width={136}
              height={160}
              radius={0}
              fit="cover"
              objectPosition="bottom"
              className="bg-transparent!"
            />
            </div>
          </div>
          {/*
            岗位描述：直接展示员工档案里填的那段话，不再拼「一名经验丰富的X」。
            那段话是员工在配置端认真写的岗位边界与执行重点，正是「我是谁」的
            正文；空态没理由另造一句缩写。两行 + 省略号处理超长，title 给全文。
          */}
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-[8px] py-[12px] capitalize">
            <strong
              className={`${CHAT_EMPTY_TITLE_CLASS} max-w-full [overflow-wrap:anywhere]`}
              style={{ fontSize: `${greetingFontSize(displayName)}px` }}
              title={displayName}
            >
              Hello 我是{displayName}！
            </strong>
            {hasRoleSummary && (
              <p className={CHAT_EMPTY_ROLE_CLASS} title={emptyRoleSummary}>
                {emptyRoleSummary}
              </p>
            )}
          </div>
        </div>
      </div>

      {/*
        开场白：员工在档案里配了 greeting_message 才会出现。
        这里渲染的是**草稿态预览**——会话还没建，没有 message 行可读；等首轮
        发出去、后端把真实开场白落库，这条随空态一起消失，由消息列表接管。
      */}
      {greetingPreview && (
        <div className={CHAT_EMPTY_GREETING_LINE_CLASS}>
          <div className={CHAT_EMPTY_GREETING_AUTHOR_CLASS}>
            <EmployeeAvatar
              profile={displayedProfile ?? undefined}
              agent={displayedAgent ?? undefined}
              size={16}
              radius={8}
              className="shrink-0"
            />
            <span className="truncate">{displayName}</span>
          </div>
          <p className={CHAT_EMPTY_GREETING_BODY_CLASS}>{greetingPreview}</p>
        </div>
      )}

      {/*
        快捷提问：员工在「编辑数字员工档案 → 快捷提问」里配的 1-3 句话。
        点在统计卡下方的空白带上——这是空态里唯一一块「提示用户能做什么」
        的位置，上方两张灰卡讲的是「我是谁 / 我有什么」，这里紧接着给动作。
        没配就整块不渲染（组件内部返回 null），不留空档。
      */}
      <ChatPromptSuggestions
        prompts={suggestedPrompts}
        // 正在跑的一轮里再发会被推进队列，点了没反馈等于失灵；分享页只读。
        disabled={Boolean(shareMode) || Boolean(currentSessionRunning)}
        onSelect={(prompt) => sendQuickText(prompt)}
      />
    </div>
  );
}
