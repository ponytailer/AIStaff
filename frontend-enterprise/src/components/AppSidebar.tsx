import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ComponentType, SVGProps } from 'react';
import { cn } from '@/lib/utils';
import EmployeeAvatar from './EmployeeAvatar';
import BrandLogo from './BrandLogo';
import StaffdeckIcon from './StaffdeckIcon';
import DispatcherAvatar from './dispatcher/DispatcherAvatar';
import {
  agentResourceCount,
  employeeDisplayName,
  employeeDisplayNameWithCreator,
  employeeProfile,
  staffdeckDisplayText,
} from '../employee';
import { EnterpriseRoute } from '../enums/routes';
import { persistSharedAgentScope } from '../lib/agent-scope-storage';
import { MAX_DISPATCH_MEMBERS, dispatchFallbackLabel, type DispatcherRead } from '../lib/dispatcher';
import type { AgentProfileRead, ChatSession } from '../types';
import IconPlatform from '../assets/icons/nav-platform.svg?react';
import IconAgents from '../assets/icons/nav-agents.svg?react';
import IconSquads from '../assets/icons/nav-squads.svg?react';
import IconFile from '../assets/icons/profile-file.svg?react';
import IconAlarm from '../assets/icons/profile-alarm.svg?react';
import IconHistory from '../assets/icons/profile-history.svg?react';
import IconCalendar from '../assets/icons/profile-calendar.svg?react';
import IconFolder from '../assets/icons/cap-folder.svg?react';
import IconMagicWand from '../assets/icons/cap-magicwand.svg?react';
import IconClipboard from '../assets/icons/cap-clipboard.svg?react';
import IconBriefcase from '../assets/icons/cap-briefcase.svg?react';
import IconChat from '../assets/icons/action-chat.svg?react';
import IconToggle from '../assets/icons/action-toggle.svg?react';
import IconHeaderCollapse from '../assets/icons/header-collapse.svg?react';
import IconModels from '../assets/icons/sys-models.svg?react';
import IconListBulleted from '../assets/icons/list-bulleted.svg?react';
import IconSettings from '../assets/icons/action-toggle.svg?react';
import IconChevronDown from '../assets/icons/chevron-down.svg?react';
import IconAdd from '../assets/icons/add.svg?react';
import IconSort from '../assets/icons/sort.svg?react';
import IconGlobe from '../assets/icons/globe.svg?react';
import IconViewMasonry from '../assets/icons/view-masonry.svg?react';
import IconChatBubble from '../assets/icons/chat.svg?react';
import IconEdit from '../assets/icons/edit.svg?react';
import IconTrash from '../assets/icons/trash.svg?react';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

type NavItem = {
  route: EnterpriseRoute;
  label: string;
  Icon: IconComponent;
  /** 挂一枚「火热」火苗角标（新上线 / 主推功能）。 */
  hot?: boolean;
  /** 仅管理员可见（页面路由也会挡一层，这里只管入口展示）。 */
  adminOnly?: boolean;
  /**
   * 同路由下的页面内 tab 深链（如 `/enterprise/agents#dispatchers`）。
   * 多智能体独立成页内 tab 后，「成员与路由规则」若只跳 /agents 会落到数字员工列表，
   * 名不副实 —— 带上 hash 让 AgentsPage 直接切到目标 tab。
   */
  hash?: string;
};

/** 带 tab 深链的导航目标：`/enterprise/agents#dispatchers`。 */
function navTarget(item: NavItem): string {
  return item.hash ? `${item.route}#${item.hash}` : item.route;
}

// 主菜单分组：组间以细分隔线区隔（与系统组的分隔样式一致）
const WORKSPACE_NAV: NavItem[] = [
  // 站点首页已下线（2026-10-13）：开放广场「全部」tab 成为默认落地（热门总览/快捷访问/新闻并入）
  { route: EnterpriseRoute.Platform, label: '开放广场平台', Icon: IconPlatform, hot: true },
  { route: EnterpriseRoute.Agents, label: '我的数字员工', Icon: IconAgents },
  // 员工小队已从「我的数字员工」的页内 tab 升为一级菜单（2026-11-08）
  { route: EnterpriseRoute.Squads, label: '我的小队', Icon: IconSquads },
];

const PLATFORM_NAV: NavItem[] = [
  // 决策助手 / AI CodeReviewer 已移入「Agent 广场」清单（agent-catalog.json），
  // 入口随广场走（CodeReviewer 为 adminOnly 条目，仅管理员视角可见），侧边栏不再单列
  { route: EnterpriseRoute.Models, label: '模型配置', Icon: IconModels },
  // 平台更新内容：渲染仓库根目录的 changelog.md，全体成员可见
  { route: EnterpriseRoute.PlatformUpdates, label: '平台更新内容', Icon: IconListBulleted },
];

const PROFILE_NAV: NavItem[] = [
  { route: EnterpriseRoute.Dashboard, label: '员工档案', Icon: IconFile },
  { route: EnterpriseRoute.ScheduledTasks, label: '定时任务', Icon: IconAlarm },
  { route: EnterpriseRoute.Memories, label: '记忆', Icon: IconHistory },
  { route: EnterpriseRoute.Feedback, label: '对话日志', Icon: IconCalendar },
];

const CAPABILITY_NAV: NavItem[] = [
  { route: EnterpriseRoute.Knowledge, label: '知识库', Icon: IconFolder },
  { route: EnterpriseRoute.GeneralSkills, label: '技能', Icon: IconMagicWand },
  { route: EnterpriseRoute.Skills, label: 'SOP', Icon: IconClipboard },
  { route: EnterpriseRoute.Tools, label: '工具', Icon: IconBriefcase },
];

/**
 * 多智能体作用域下的左下块（2026-11-07）。
 *
 * 它不配知识库/技能/SOP/工具，那四项目录对它永远为空 —— 挂着只会让人以为「配置丢了」。
 * 换成它真正成立的三个落点：档案（成员/规则/兜底/模型）、对话日志、定时任务。
 * 注意这里没有新增路由：三者都复用 DashboardPage 的不同 tab。
 */
const DISPATCHER_PROFILE_NAV: NavItem[] = [
  { route: EnterpriseRoute.Dashboard, label: '员工小队档案', Icon: IconFile },
  { route: EnterpriseRoute.ScheduledTasks, label: '定时任务', Icon: IconAlarm },
  { route: EnterpriseRoute.Feedback, label: '对话日志', Icon: IconCalendar },
];

/**
 * 员工小队作用域下的「结构」块。
 *
 * 小队已升为一级菜单「我的小队」（`/enterprise/squads`），不再挂在「我的数字员工」
 * 的页内 tab 上；这里直接给一级页面的落点，不再用 `#dispatchers` 深链
 * （旧深链仍由 AgentsPage 重定向兼容）。
 */
const DISPATCHER_STRUCTURE_NAV: NavItem[] = [
  { route: EnterpriseRoute.Squads, label: '成员与路由规则', Icon: IconSquads },
];

const SYSTEM_NAV: NavItem[] = [
  // 账号管理已并入「API Key 审批」页的用户管理 tab，侧边栏不再单列
  { route: EnterpriseRoute.ApiKeyApprovals, label: 'API Key 审批', Icon: IconApiKey },
  { route: EnterpriseRoute.RuntimeSettings, label: '超级管理员', Icon: IconSettings },
];

/** 「火热」火苗角标：双色实心，自带轻微呼吸动效（见 .sd1-hot-flame）。 */
function HotFlame({ className, decorative }: { className?: string; decorative?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : '热门'}
      data-testid="nav-hot-flame"
      className={cn('sd1-hot-flame shrink-0', className)}
    >
      <path
        d="M12 1.8c0 3.1-1.6 4.7-3.1 6.6C7.4 10.3 6 12.4 6 14.8a6 6 0 0 0 12 0c0-2.4-1.4-4.5-2.9-6.4-1.5-1.9-3.1-3.5-3.1-6.6Z"
        fill="#ff5a1f"
      />
      <path
        d="M12 21.6a3.3 3.3 0 0 0 3.3-3.3c0-1.35-.87-2.43-1.74-3.5-.6-.73-1.2-1.45-1.56-2.33-.36.88-.96 1.6-1.56 2.33-.87 1.07-1.74 2.15-1.74 3.5A3.3 3.3 0 0 0 12 21.6Z"
        fill="#ffc93c"
      />
    </svg>
  );
}

function IconApiKey({ className, ...props }: { className?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2" />
      <path d="M15.5 6.5 18.5 9.5" />
      <path d="M18 4 20.5 6.5" />
    </svg>
  );
}

function navGroups(isAdmin: boolean): NavItem[][] {
  // 工作区与平台项合为一组（模型配置/平台更新内容不与上边分隔）；
  // 仅管理员在末尾追加系统组，组间以分隔线区隔。
  const groups: NavItem[][] = [[...WORKSPACE_NAV, ...PLATFORM_NAV]];
  if (isAdmin) groups.push(SYSTEM_NAV);
  return groups;
}

/** 主菜单组间分隔线：与系统组那条同款（bg-sidebar-border 细线）。 */
function MenuDivider({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('h-px w-full bg-sidebar-border group-data-[collapsible=icon]:hidden', className)}
    />
  );
}

export type AppSidebarManagementProps = {
  variant?: 'management';
  selected: string;
  onNavigate: (route: string) => void;
  isAdmin: boolean;
  sidebarAgent?: AgentProfileRead;
  /**
   * 当前作用域是多智能体时，它的详情（含 members / config / model_name）。
   *
   * 为什么不是 AgentProfileRead：`/api/enterprise/agents` 按设计排除 dispatcher
   * （混进花名册会把员工总数算多，也会冒出一张没有知识库/SOP 的空卡），
   * 所以侧栏拿不到它，只能由 App 从 `/api/enterprise/dispatchers` 单独喂进来。
   */
  sidebarDispatcher?: DispatcherRead | null;
  /**
   * 可切换的多智能体清单（当前用户可用的）。与 `scopeAgents` 分开是因为
   * 后端 `/api/enterprise/agents` 按设计排除 dispatcher，两者不是同一份数据。
   */
  scopeDispatchers?: DispatcherRead[];
  scopeAgents: AgentProfileRead[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  onOpenChat: () => void;
  modelSetupAttention?: boolean;
  /**
   * 花名册是否还在加载。加载完成前 `sidebarAgent` / `sidebarDispatcher` 必然都是空，
   * 那时显示「未选择 / -」是误报（整页刷新到多智能体作用域时会闪一下）。
   */
  scopeLoading?: boolean;
};

export type ChatSessionFilterOption = { value: string; label: string };

export type AppSidebarChatProps = {
  variant: 'chat';
  /** Sessions already filtered for the sidebar list. */
  sessions: ChatSession[];
  /** Whether the initial session list is still loading. */
  sessionsLoading?: boolean;
  /** Full agent roster, used to resolve per-session avatars/roles. */
  agents: AgentProfileRead[];
  /**
   * 左栏员工卡展示的「当前员工」（页面上正在对话的那位）。
   *
   * 为什么不从 `agents` + `sessionFilter` 推：筛选是「全部员工」时推不出单个人，
   * 而员工卡必须始终有一个确定主体 —— 谁在跟我说话，左栏就该写谁。
   */
  currentAgent?: AgentProfileRead | null;
  /** 员工卡副标题里的岗位名（`employeeProfile(currentAgent).roleName`）。 */
  currentRoleName?: string;
  /** 当前会话是否在跑：员工卡的「在线」胶囊会切成「进行中」。 */
  running?: boolean;
  /** 员工卡下拉里可切换的员工清单（选中即对这位员工开一个新草稿）。 */
  switchAgents?: AgentProfileRead[];
  /** 同一份下拉里的「员工小队」段。 */
  switchDispatchers?: AgentProfileRead[];
  onSwitchAgent?: (agentId: string) => void;
  activeSessionId?: string;
  sessionFilter: string;
  onSessionFilterChange: (value: string) => void;
  sessionFilterOptions: ChatSessionFilterOption[];
  isSessionUnread: (session: ChatSession) => boolean;
  onOpenSession: (id: string) => void;
  onNewConversation?: () => void;
  /** Clicking the brand logo returns to the site landing page (开放广场「全部」). */
  onOpenHome: () => void;
  onOpenGallery: () => void;
  /** Highlights the 数字员工广场 entry as the active menu (chat gallery route). */
  galleryActive?: boolean;
  handoffCount?: number;
  onOpenHandoffs?: () => void;
  onRenameSession: (session: ChatSession) => void;
  onDeleteSession: (session: ChatSession) => void;
  onOpenAdmin: () => void;
};

export type AppSidebarProps = AppSidebarManagementProps | AppSidebarChatProps;

// Shared shell classes so the management + chat sidebars share the same chrome.
const SIDEBAR_SHELL_CLASS =
  'overflow-hidden border-sidebar-border bg-sidebar **:data-[slot=sidebar-inner]:bg-sidebar sd1-island-sidebar';

function PrimaryNavButton({
  item,
  selected,
  onNavigate,
  attention,
}: {
  item: NavItem;
  selected: string;
  onNavigate: (route: string) => void;
  attention?: boolean;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        data-guide-target={`route-${item.route}`}
        tooltip={item.label}
        isActive={selected === item.route}
        onClick={() => onNavigate(navTarget(item))}
        className={cn(
          'h-[34px] gap-[10px] rounded-[12px] px-[20px] py-[6px] text-[13px] text-[#55555a]',
          'hover:bg-sidebar-accent hover:text-[#18181a]',
          'data-active:bg-sidebar-accent data-active:text-[#18181a] data-active:font-medium',
          attention && selected !== item.route && 'bg-[#fff7e8] text-[#8a4b00] ring-1 ring-[#ffd58a]',
          'group-data-[collapsible=icon]:px-0!',
        )}
      >
        <item.Icon className="size-[16px]!" />
        <span className="flex min-w-0 items-center gap-[5px] text-[13px]">
          <span className="truncate">{item.label}</span>
          {item.hot && <HotFlame className="size-[13px]!" />}
        </span>
        {attention && (
          <span className="ml-auto size-[6px] rounded-full bg-[#f59e0b] group-data-[collapsible=icon]:hidden" />
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function CardNavButton({
  item,
  selected,
  onNavigate,
}: {
  item: NavItem;
  selected: string;
  onNavigate: (route: string) => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        data-guide-target={`route-${item.route}`}
        tooltip={item.label}
        isActive={selected === item.route}
        onClick={() => onNavigate(navTarget(item))}
        className={cn(
          'h-[32px] gap-[8px] rounded-[10px] px-[12px] py-[4px] text-[12px] text-[#6d6d72]',
          'hover:bg-sidebar-accent hover:text-[#18181a]',
          'data-active:bg-sidebar-accent data-active:text-[#18181a] data-active:font-medium',
          'group-data-[collapsible=icon]:px-0!',
        )}
      >
        <item.Icon className="size-[14px]!" />
        <span>{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function GroupLabel({ children }: { children: string }) {
  return (
    <span className="px-[8px] pt-[4px] pb-[2px] text-[10px] leading-none tracking-[0.12em] text-[#9a9a9f] group-data-[collapsible=icon]:hidden">
      {children}
    </span>
  );
}


function AgentSwitcher({
  sidebarAgent,
  sidebarDispatcher,
  scopeAgents,
  scopeDispatchers = [],
  selectedAgentId,
  onSelectAgent,
  scopeLoading = false,
}: Pick<
  AppSidebarManagementProps,
  | 'sidebarAgent'
  | 'sidebarDispatcher'
  | 'scopeAgents'
  | 'scopeDispatchers'
  | 'selectedAgentId'
  | 'onSelectAgent'
  | 'scopeLoading'
>) {
  const employeeAgents = scopeAgents.filter((agent) => !agent.is_overall);
  const currentAgent = sidebarAgent && !sidebarAgent.is_overall ? sidebarAgent : undefined;
  const currentDispatcher = sidebarDispatcher || undefined;
  const caption = currentDispatcher
    ? '员工小队'
    : currentAgent
      ? '当前员工'
      : scopeLoading
        ? '加载中'
        : '未选择';
  const nameLabel = currentDispatcher
    ? currentDispatcher.name
    : currentAgent
      ? employeeDisplayNameWithCreator(currentAgent)
      : scopeLoading
        ? '…'
        : '-';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <div
          aria-label="切换当前员工"
          className={cn(
            'flex w-full items-center gap-[12px] rounded-[18px] px-[8px] pt-[8px] pb-[4px] text-left transition-colors',
            'group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0',
          )}
        >
          {currentDispatcher ? (
            <div className="w-[60px] h-[30px] relative">
              <div className="absolute inset-0 flex items-end justify-center">
                <DispatcherAvatar preset={currentDispatcher.avatar_preset} size={54} radius={14} />
              </div>
            </div>
          ) : currentAgent ? (
            <div className="w-[60px] h-[30px] relative">
              <div className="absolute inset-0 flex items-end justify-center">
                <EmployeeAvatar agent={currentAgent} width={60} height={71} />
              </div>
            </div>
          ) : (
            <div className="w-[60px] h-[30px] relative">
              <div className="absolute inset-0 flex items-end justify-center">
                <span className="flex w-[60px] h-[71px] items-center justify-center rounded-[10px] border-[0.5px] border-[#e6e4df] bg-white text-sidebar-foreground">
                  <IconAdd className="size-[20px]" />
                </span>
              </div>
            </div>
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-[4px] group-data-[collapsible=icon]:hidden">
            <span className="truncate text-[10px] leading-none text-[#6d6d72]">{caption}</span>
            <span className="block truncate text-[12px] font-medium leading-none text-[#3d3d3f]">
              {nameLabel}
            </span>
          </span>
          <IconChevronDown className="size-[14px] shrink-0 text-sidebar-foreground group-data-[collapsible=icon]:hidden" />
        </div>
      </DropdownMenuTrigger>
      {/* 不能锁 `w-(--radix-dropdown-menu-trigger-width)`：触发块在侧栏里只有 ~163px，
          锁死后「数据分析 @Administrator」这类长名字被截断。给一个最小宽度 + 允许内容撑开。
          max-h 也要放宽：员工 7 位 + 小队后总高 ~435px，320px 会把「员工小队」
          这一组压到折叠线以下 —— 而小队作用域下当前选中项恰恰就在那组里。 */}
      <DropdownMenuContent
        align="start"
        className="flex max-h-[min(440px,70vh)] min-w-[240px] flex-col gap-[4px] overflow-y-auto"
      >
        {employeeAgents.map((agent) => (
          <DropdownMenuItem
            key={agent.id}
            data-active={agent.id === selectedAgentId}
            onSelect={() => onSelectAgent(agent.id)}
            className="shrink-0 gap-2 rounded-[14px] cursor-pointer focus:bg-[#f2f1ee] focus:[&_strong]:text-foreground! focus:[&_small]:text-muted-foreground! data-[active=true]:bg-[#f2f1ee] data-[active=true]:[&_strong]:text-foreground!"
          >
            <EmployeeAvatar agent={agent} size={28} />
            <span className="flex min-w-0 flex-col">
              <strong className="truncate text-[12px] font-medium">
                {employeeDisplayNameWithCreator(agent)}
              </strong>
              <small className="truncate text-[10px] text-muted-foreground">
                {employeeProfile(agent).roleName}
              </small>
            </span>
          </DropdownMenuItem>
        ))}
        <DispatcherScopeItems
          scopeDispatchers={scopeDispatchers}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 切换器下拉里的「多智能体」分组。
 *
 * 与员工项的区别是刻意的：副标题写「N 位同事」而不是岗位名（`employeeProfile()` 对
 * dispatcher 只会返回「待补充岗位」，因为它的 metadata 里没有岗位字段）。
 */
function DispatcherScopeItems({
  scopeDispatchers,
  selectedAgentId,
  onSelectAgent,
}: Pick<AppSidebarManagementProps, 'selectedAgentId' | 'onSelectAgent'> & {
  scopeDispatchers: DispatcherRead[];
}) {
  if (scopeDispatchers.length === 0) return null;
  return (
    <>
      <DropdownMenuLabel className="px-[8px] pt-[6px] pb-[2px] text-[10px] leading-none text-[#3d3d3f]">
        员工小队
      </DropdownMenuLabel>
      {scopeDispatchers.map((dispatcher) => (
        <DropdownMenuItem
          key={dispatcher.id}
          data-active={dispatcher.id === selectedAgentId}
          onSelect={() => onSelectAgent(dispatcher.id)}
          className="shrink-0 gap-2 rounded-[14px] cursor-pointer focus:bg-[#f2f1ee] focus:[&_strong]:text-foreground! focus:[&_small]:text-muted-foreground! data-[active=true]:bg-[#f2f1ee] data-[active=true]:[&_strong]:text-foreground!"
        >
          <DispatcherAvatar preset={dispatcher.avatar_preset} size={28} radius={8} />
          <span className="flex min-w-0 flex-col">
            <strong className="truncate text-[12px] font-medium">{dispatcher.name}</strong>
            <small className="truncate text-[10px] text-muted-foreground">
              {dispatcher.members.length}/{MAX_DISPATCH_MEMBERS} 位同事
            </small>
          </span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

function SidebarFooterActions({ onOpenChat }: { onOpenChat: () => void }) {
  return (
    <div
      className={cn(
        'flex items-center justify-center gap-[10px]',
        'group-data-[collapsible=icon]:flex-col',
      )}
    >
      <button
        type="button"
        data-guide-target="open-chat"
        onClick={onOpenChat}
        title="对话端"
        className={cn(
          'flex h-[40px] w-[130px] items-center justify-center gap-[6px] rounded-[10px] border-[0.5px] border-[#e6e4df] bg-[#f2f1ee] px-[20px] py-[4px] text-[14px] text-sidebar-accent-foreground transition-opacity hover:opacity-70',
          'group-data-[collapsible=icon]:size-[40px] group-data-[collapsible=icon]:w-[40px] group-data-[collapsible=icon]:px-0',
        )}
      >
        <IconChat className="size-[16px]!" />
        <span className="group-data-[collapsible=icon]:hidden">对话端</span>
      </button>
      <button
        type="button"
        onClick={onOpenChat}
        title="切换到对话端"
        aria-label="切换到对话端"
        className="flex size-[32px] shrink-0 items-center justify-center rounded-[8px] rotate-90 text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <IconToggle className="size-[16px]!" />
      </button>
    </div>
  );
}

function CollapsedGroupLabel({ children }: { children: string }) {
  return (
    <span className="text-[10px] leading-none tracking-[0.12em] text-[#9a9a9f]">
      {children}
    </span>
  );
}

function CollapsedNavButton({
  item,
  selected,
  onNavigate,
  radius,
  iconSize,
  attention,
}: {
  item: NavItem;
  selected: string;
  onNavigate: (route: string) => void;
  radius: number;
  iconSize: number;
  attention?: boolean;
}) {
  const active = selected === item.route;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={item.label}
          onClick={() => onNavigate(navTarget(item))}
          className={cn(
            'relative flex size-[32px] shrink-0 items-center justify-center text-sidebar-foreground transition-colors',
            'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            active && 'bg-sidebar-accent text-sidebar-accent-foreground',
            attention && !active && 'bg-[#fff7e8] text-[#8a4b00] ring-1 ring-[#ffd58a]',
          )}
          style={{ borderRadius: radius }}
        >
          <item.Icon style={{ width: iconSize, height: iconSize }} />
          {item.hot && <HotFlame decorative className="absolute mt-[-19px] ml-[19px] size-[11px]!" />}
          {attention && (
            <span className="absolute mt-[-22px] ml-[22px] size-[6px] rounded-full bg-[#f59e0b]" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="center">
        {item.label}
      </TooltipContent>
    </Tooltip>
  );
}

function CollapsedAgentSwitcher({
  sidebarAgent,
  sidebarDispatcher,
  scopeAgents,
  scopeDispatchers = [],
  selectedAgentId,
  onSelectAgent,
  nameLabel,
  scopeLoading = false,
}: Pick<
  AppSidebarManagementProps,
  | 'sidebarAgent'
  | 'sidebarDispatcher'
  | 'scopeAgents'
  | 'scopeDispatchers'
  | 'selectedAgentId'
  | 'onSelectAgent'
  | 'scopeLoading'
> & {
  nameLabel: string;
}) {
  const employeeAgents = scopeAgents.filter((agent) => !agent.is_overall);
  const currentAgent = sidebarAgent && !sidebarAgent.is_overall ? sidebarAgent : undefined;
  const currentDispatcher = sidebarDispatcher || undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="切换当前员工"
          className="flex flex-col items-center gap-[2px] pt-[8px]"
        >
          {currentDispatcher ? (
            <DispatcherAvatar preset={currentDispatcher.avatar_preset} size={34} radius={8} />
          ) : currentAgent ? (
            <EmployeeAvatar agent={currentAgent} width={32} height={38} radius={8} />
          ) : (
            <span className="flex h-[38px] w-[32px] items-center justify-center rounded-[8px] border-[0.5px] border-[#e6e4df] bg-white text-sidebar-foreground">
              <IconAdd className="size-[16px]" />
            </span>
          )}
          <span className="w-[34px] text-center text-[10px] font-medium leading-tight wrap-break-word text-[#18181a]">
            {nameLabel}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="flex max-h-[320px] min-w-[180px] flex-col gap-[4px] overflow-y-auto">
        {employeeAgents.map((agent) => (
          <DropdownMenuItem
            key={agent.id}
            data-active={agent.id === selectedAgentId}
            onSelect={() => onSelectAgent(agent.id)}
            className="shrink-0 gap-2 rounded-[14px] cursor-pointer focus:bg-[#f2f1ee] focus:[&_strong]:text-foreground! focus:[&_small]:text-muted-foreground! data-[active=true]:bg-[#f2f1ee] data-[active=true]:[&_strong]:text-foreground!"
          >
            <EmployeeAvatar agent={agent} size={28} />
            <span className="flex min-w-0 flex-col">
              <strong className="truncate text-[12px] font-medium">
                {employeeDisplayNameWithCreator(agent)}
              </strong>
              <small className="truncate text-[10px] text-muted-foreground">
                {employeeProfile(agent).roleName}
              </small>
            </span>
          </DropdownMenuItem>
        ))}
        <DispatcherScopeItems
          scopeDispatchers={scopeDispatchers}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CollapsedSidebar({
  selected,
  onNavigate,
  isAdmin,
  sidebarAgent,
  sidebarDispatcher,
  scopeAgents,
  scopeDispatchers = [],
  selectedAgentId,
  onSelectAgent,
  onOpenChat,
  onToggle,
  modelSetupAttention,
  scopeLoading = false,
}: Pick<
  AppSidebarManagementProps,
  | 'selected'
  | 'onNavigate'
  | 'isAdmin'
  | 'sidebarAgent'
  | 'sidebarDispatcher'
  | 'scopeAgents'
  | 'scopeDispatchers'
  | 'selectedAgentId'
  | 'onSelectAgent'
  | 'onOpenChat'
  | 'modelSetupAttention'
  | 'scopeLoading'
> & { onToggle: () => void }) {
  const nameLabel = sidebarDispatcher
    ? sidebarDispatcher.name
    : sidebarAgent
      ? sidebarAgent.is_overall
        ? '未选择'
        : employeeDisplayNameWithCreator(sidebarAgent)
      : scopeLoading
        ? '…'
        : '未选择';
  // 多智能体没有知识库/技能/SOP/工具，底部这组换成对它成立的入口
  const profileNav = sidebarDispatcher ? DISPATCHER_PROFILE_NAV : PROFILE_NAV;
  const capabilityNav = sidebarDispatcher ? DISPATCHER_STRUCTURE_NAV : CAPABILITY_NAV;
  const groups = navGroups(isAdmin);

  return (
    <div className="flex h-full w-(--sidebar-width-icon) shrink-0 flex-col items-center gap-[32px] px-[16px] pt-[42px] pb-[10px]">
      <div className="flex w-full flex-col items-center gap-[10px]">
        <button
          type="button"
          onClick={() => onNavigate(EnterpriseRoute.Platform)}
          title="返回首页"
          aria-label="返回首页"
          className="flex items-center justify-center p-[10px] transition-opacity hover:opacity-70"
        >
          <BrandLogo markOnly />
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggle}
              aria-label="展开边栏"
              className="flex size-[16px] items-center justify-center text-sidebar-foreground transition-colors hover:text-sidebar-accent-foreground"
            >
              <IconHeaderCollapse className="size-[16px]! -rotate-90" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            展开边栏
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex w-full flex-col items-center gap-[12px]">
        {groups.map((group, gi) => (
          <Fragment key={gi}>
            {gi > 0 && <div className="h-px w-full bg-sidebar-border" />}
            {group.map((item) => (
              <CollapsedNavButton
                key={item.route}
                item={item}
                selected={selected}
                onNavigate={onNavigate}
                radius={10}
                iconSize={16}
                attention={modelSetupAttention && item.route === EnterpriseRoute.Models}
              />
            ))}
          </Fragment>
        ))}
        <div className="h-px w-full bg-sidebar-border" />
      </div>

      <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-between">
        <div className="flex w-[38px] flex-col items-center gap-[8px] rounded-[10px] border-[0.5px] border-[#e6e4df] bg-white px-[2px] pt-[6px] pb-[8px]">
          <CollapsedAgentSwitcher
            sidebarAgent={sidebarAgent}
            sidebarDispatcher={sidebarDispatcher}
            scopeAgents={scopeAgents}
            scopeDispatchers={scopeDispatchers}
            selectedAgentId={selectedAgentId}
            onSelectAgent={onSelectAgent}
            nameLabel={nameLabel}
            scopeLoading={scopeLoading}
          />

          <div className="h-px w-[28px] bg-sidebar-border" />

          <div className="flex flex-col items-center gap-[4px]">
            <CollapsedGroupLabel>资料</CollapsedGroupLabel>
            {profileNav.map((item) => (
              <CollapsedNavButton
                key={item.route}
                item={item}
                selected={selected}
                onNavigate={onNavigate}
                radius={10}
                iconSize={14}
              />
            ))}

            <div className="my-[6px] h-px w-[28px] bg-sidebar-border" />

            <CollapsedGroupLabel>{sidebarDispatcher ? '配置' : '能力'}</CollapsedGroupLabel>
            {capabilityNav.map((item) => (
              <CollapsedNavButton
                key={item.route}
                item={item}
                selected={selected}
                onNavigate={onNavigate}
                radius={10}
                iconSize={14}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-center pb-[20px]">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onOpenChat}
                aria-label="切换到对话端"
                className="flex size-[32px] shrink-0 items-center justify-center rounded-[10px] border-[0.5px] border-[#e6e4df] bg-[#f2f1ee] text-sidebar-accent-foreground transition-opacity hover:opacity-70"
              >
                <IconChat className="size-[16px]!" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" align="center">
              切换到对话端
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function ManagementSidebar({
  selected,
  onNavigate,
  isAdmin,
  sidebarAgent,
  sidebarDispatcher,
  scopeAgents,
  scopeDispatchers = [],
  selectedAgentId,
  onSelectAgent,
  onOpenChat,
  modelSetupAttention,
  scopeLoading = false,
}: AppSidebarManagementProps) {
  const { toggleSidebar, state } = useSidebar();
  const brandCollapsed = useMemo(() => state === 'collapsed', [state]);
  const navGroupList = useMemo(() => navGroups(isAdmin), [isAdmin]);
  // 多智能体没有知识库/技能/SOP/工具：那组导航对它永远空，换成成员/路由规则与日志
  const profileNav = sidebarDispatcher ? DISPATCHER_PROFILE_NAV : PROFILE_NAV;
  const capabilityNav = sidebarDispatcher ? DISPATCHER_STRUCTURE_NAV : CAPABILITY_NAV;

  if (brandCollapsed) {
    return (
      <Sidebar collapsible="icon" className={SIDEBAR_SHELL_CLASS}>
        <CollapsedSidebar
          selected={selected}
          onNavigate={onNavigate}
          isAdmin={isAdmin}
          sidebarAgent={sidebarAgent}
          sidebarDispatcher={sidebarDispatcher}
          scopeAgents={scopeAgents}
          scopeDispatchers={scopeDispatchers}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
          onOpenChat={onOpenChat}
          onToggle={toggleSidebar}
          modelSetupAttention={modelSetupAttention}
          scopeLoading={scopeLoading}
        />
      </Sidebar>
    );
  }

  return (
    <Sidebar collapsible="icon" className={SIDEBAR_SHELL_CLASS}>
      <div className="flex h-full w-(--sidebar-width) shrink-0 flex-col">
      <SidebarHeader className="gap-[16px] px-[20px] pt-[32px] group-data-[collapsible=icon]:px-[20px]">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => onNavigate(EnterpriseRoute.Platform)}
            title="返回首页"
            aria-label="返回首页"
            className="flex flex-1 justify-center transition-opacity hover:opacity-70"
          >
            <BrandLogo wordmarkClassName="group-data-[collapsible=icon]:hidden" />
          </button>
          {!brandCollapsed && (
            <button
              type="button"
              onClick={toggleSidebar}
              title="收起边栏"
              aria-label="收起边栏"
              className="flex size-[28px] shrink-0 items-center justify-center rounded-[8px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <IconHeaderCollapse className="size-[14px]! -rotate-90" />
            </button>
          )}
        </div>

        <div className="flex flex-col gap-[10px]">
          {navGroupList.map((group, gi) => (
            <Fragment key={gi}>
              {gi > 0 && <MenuDivider className="my-[2px]" />}
              <SidebarMenu className="gap-[6px]">
                {group.map((item) => (
                  <PrimaryNavButton
                    key={item.route}
                    item={item}
                    selected={selected}
                    onNavigate={onNavigate}
                    attention={modelSetupAttention && item.route === EnterpriseRoute.Models}
                  />
                ))}
              </SidebarMenu>
            </Fragment>
          ))}
          <MenuDivider />
        </div>
      </SidebarHeader>

      <SidebarContent className="px-[20px] group-data-[collapsible=icon]:px-[20px]">
        <div
          className={cn(
            'mt-[20px] mb-[16px] flex flex-col gap-[6px] rounded-[20px] border-[0.5px] border-[#e6e4df] bg-sidebar px-[4px] pt-[6px] pb-[8px]',
            'group-data-[collapsible=icon]:mt-[24px] group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:shadow-none',
          )}
        >
          <AgentSwitcher
            sidebarAgent={sidebarAgent}
            sidebarDispatcher={sidebarDispatcher}
            scopeAgents={scopeAgents}
            scopeDispatchers={scopeDispatchers}
            selectedAgentId={selectedAgentId}
            onSelectAgent={onSelectAgent}
            scopeLoading={scopeLoading}
          />
          <div className="mx-[8px] h-px bg-sidebar-border group-data-[collapsible=icon]:hidden" />

          <div className="flex flex-col gap-[2px] px-[10px] group-data-[collapsible=icon]:px-0">
            <GroupLabel>{sidebarDispatcher ? '运营记录' : '基本资料'}</GroupLabel>
            <SidebarMenu className="gap-[2px]">
              {profileNav.map((item) => (
                <CardNavButton key={item.route} item={item} selected={selected} onNavigate={onNavigate} />
              ))}
            </SidebarMenu>

            <div className="mx-[2px] my-[8px] h-px bg-sidebar-border group-data-[collapsible=icon]:hidden" />

            <GroupLabel>{sidebarDispatcher ? '成员与规则' : '员工能力'}</GroupLabel>
            <SidebarMenu className="gap-[2px]">
              {capabilityNav.map((item) => (
                <CardNavButton key={item.route} item={item} selected={selected} onNavigate={onNavigate} />
              ))}
            </SidebarMenu>
          </div>
        </div>
      </SidebarContent>

      <SidebarFooter className="px-[20px] pb-[20px] group-data-[collapsible=icon]:px-[20px]">
        <SidebarFooterActions onOpenChat={onOpenChat} />
      </SidebarFooter>
      </div>
    </Sidebar>
  );
}

// ---------------------------------------------------------------------------
// Chat variant (Figma node 38:5767) — reuses the sidebar shell + brand chrome
// while swapping the body for the "员工会话" session list.
// ---------------------------------------------------------------------------

function sessionAgentFor(session: ChatSession, agents: AgentProfileRead[]): AgentProfileRead | null {
  if (!session.agent_id) return null;
  return agents.find((agent) => agent.id === session.agent_id) || null;
}

function sessionTitleFor(session: ChatSession, _agent: AgentProfileRead | null): string {
  if (session.title) return staffdeckDisplayText(session.title);
  return session.id || '新对话';
}

function sessionSubtitleFor(session: ChatSession, _agent: AgentProfileRead | null): string {
  const recent = (session.last_agent_question || session.summary || '').replace(/^最近回复[:：]\s*/, '');
  return recent ? staffdeckDisplayText(recent) : '新对话';
}


// ---------------------------------------------------------------------------
// Chat variant —— 对话端左栏（版式对齐 docs/redesign/chat-conversation-v3.html）
//
// 结构：员工卡（当前员工 + 能力资产）→ 搜索 → 按时间分组的会话列表面板 → 底部快捷键。
// 与旧版的关键差别不只是配色：会话行从「42px 头像大卡」收成 36px 文本行 —— 员工头像
// 在员工卡里已经出现过一次，列表里再画一遍会把左栏变成头像墙，标题反而被挤到看不见。
// ---------------------------------------------------------------------------

const CHAT_SIDEBAR_CLASS = cn(SIDEBAR_SHELL_CLASS, 'bg-white **:data-[slot=sidebar-inner]:bg-white');

const SESSION_GROUP_LABELS = ['今天', '昨天', '近 7 天', '更早'] as const;
type SessionGroupLabel = (typeof SESSION_GROUP_LABELS)[number];

/** 会话按 `updated_at` 落到「今天 / 昨天 / 近 7 天 / 更早」。 */
function sessionGroupLabel(updatedAt: string, now: Date = new Date()): SessionGroupLabel {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '更早';
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays <= 7) return '近 7 天';
  return '更早';
}

function groupSessionsByRecency(
  sessions: ChatSession[],
): { label: SessionGroupLabel; items: ChatSession[] }[] {
  const buckets = new Map<SessionGroupLabel, ChatSession[]>();
  sessions.forEach((session) => {
    const label = sessionGroupLabel(session.updated_at);
    const bucket = buckets.get(label);
    if (bucket) bucket.push(session);
    else buckets.set(label, [session]);
  });
  return SESSION_GROUP_LABELS.filter((label) => buckets.has(label)).map((label) => ({
    label,
    items: buckets.get(label) as ChatSession[],
  }));
}

/** 收起侧栏用的面板图标：矩形 + 左侧分栏线，不带箭头（带箭头在 15px 下会糊成字母）。 */
function PanelCollapseIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </svg>
  );
}

/** 左栏反复出现的图标按钮（新建对话 / 收起侧栏 / 更多）。 */
const CHAT_ICON_BUTTON_CLASS =
  'inline-grid size-[24px] shrink-0 place-items-center rounded-[8px] text-[#6d6d72] transition-colors hover:bg-[rgba(24,24,26,.06)] hover:text-[#18181a] disabled:opacity-50';

/**
 * 员工卡：左栏的第一主体是「当前员工」，不是平台导航。
 *
 * 名字整块可点 = 打开员工档案（新标签页）。资产 chips 同去档案页 —— 技能/资料/工具
 * 都是这位员工的配置，落到平台上层的能力目录反而要多选一次员工。
 */
function ChatEmployeeCard({
  agent,
  roleName,
  running,
  onOpenProfile,
  onNewConversation,
  onToggle,
  galleryActive = false,
  handoffCount = 0,
  onOpenGallery,
  onOpenHandoffs,
  onOpenHome,
  switchAgents = [],
  switchDispatchers = [],
  onSwitchAgent,
}: {
  agent: AgentProfileRead | null;
  roleName: string;
  running: boolean;
  onOpenProfile: () => void;
  onNewConversation?: () => void;
  onToggle: () => void;
  galleryActive?: boolean;
  handoffCount?: number;
  onOpenGallery?: () => void;
  onOpenHandoffs?: () => void;
  onOpenHome?: () => void;
  /** 可切换的员工清单（点名字那条下拉）。 */
  switchAgents?: AgentProfileRead[];
  /** 可切换的员工小队。单独一段让「小队」不混在员工里，也是它存在的意义。 */
  switchDispatchers?: AgentProfileRead[];
  onSwitchAgent?: (agentId: string) => void;
}) {
  const name = agent ? employeeDisplayName(agent) : '未选择员工';
  const isDispatcher = (agent?.kind || 'standard') === 'dispatcher';
  /*
   * 下拉分两段。
   * `switchDispatchers` 是专门拉的一份额外清单（/dispatchers），万一它没拿到，
   * 就退回从花名册里挑 kind=dispatcher 的行 —— 小队不能凭空消失。
   */
  const agentItems = switchAgents.filter(
    (item) => !item.is_overall && (item.kind || 'standard') !== 'dispatcher',
  );
  const dispatcherItems = switchDispatchers.length > 0
    ? switchDispatchers.filter((item) => !item.is_overall)
    : switchAgents.filter((item) => !item.is_overall && item.kind === 'dispatcher');
  const memberCount = Number(agent?.metadata?.dispatcher_members || 0);
  // 小队不配知识库/技能/工具（纯路由入口），所以资产条换成「同事」——原来的三个 0 是噪音。
  const assets = !agent
    ? []
    : isDispatcher
      ? [{ key: 'members', label: '同事', icon: <StaffdeckIcon name="user" size={12} />, value: memberCount }]
      : [
          { key: 'skill', label: '技能', icon: <StaffdeckIcon name="spark" size={12} />, value: agentResourceCount(agent, 'general_skill') },
          { key: 'knowledge', label: '资料', icon: <StaffdeckIcon name="database" size={12} />, value: agentResourceCount(agent, 'knowledge_base') },
          { key: 'tool', label: '工具', icon: <StaffdeckIcon name="tool" size={12} />, value: agentResourceCount(agent, 'tool') },
        ];

  return (
    <div className="flex flex-col gap-[10px] px-[14px] pt-[22px] pb-[10px]">
      <div className="flex items-start gap-[6px]">
        {/* 员工卡兼切换器：点名字出员工清单，「对其他员工发起对话」不用绕去广场。 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="切换当前员工"
              title="切换员工"
              className="flex min-w-0 flex-1 items-center gap-[10px] rounded-[12px] px-[2px] py-[2px] text-left transition-colors hover:bg-[rgba(24,24,26,.035)]"
            >
              {isDispatcher ? (
                <DispatcherAvatar
                  preset={String(agent?.metadata?.avatar_preset || '')}
                  size={38}
                  radius={12}
                />
              ) : (
                <EmployeeAvatar agent={agent} size={38} radius={12} />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
                <span className="flex min-w-0 items-center gap-[4px]">
                  <span className="truncate text-[15.5px] font-semibold leading-none tracking-[-0.01em] text-[#18181a]">
                    {name}
                  </span>
                  <IconChevronDown className="size-[13px]! shrink-0 text-[#9a9a9f]" />
                </span>
                <span className="flex min-w-0 items-center gap-[5px]">
                  <span className="truncate text-[12.5px] leading-none text-[#6d6d72]">
                    {isDispatcher
                      ? (memberCount > 0 ? `员工小队 · ${memberCount} 位同事` : '员工小队')
                      : (roleName || '你的数字员工')}
                  </span>
                  {agent && (
                    <span className="inline-flex shrink-0 items-center gap-[4px] rounded-full bg-[rgba(15,118,110,.12)] px-[6px] py-[1px] text-[10.5px] font-medium leading-[14px] text-[#0f766e]">
                      <span className={cn('size-[5px] rounded-full bg-[#0f766e]', running && 'motion-safe:animate-pulse')} />
                      {running ? '进行中' : '在线'}
                    </span>
                  )}
                </span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="flex max-h-[min(360px,60vh)] min-w-[228px] flex-col gap-[2px] overflow-y-auto rounded-[14px] p-[5px]"
          >
            <DropdownMenuLabel className="shrink-0 px-[8px] pt-[2px] pb-[3px] text-[10.5px] font-normal leading-none text-[#9a9a9f]">
              员工
            </DropdownMenuLabel>
            {agentItems.map((item) => (
              <DropdownMenuItem
                key={item.id}
                data-active={item.id === agent?.id}
                onSelect={() => onSwitchAgent?.(item.id)}
                className="shrink-0 cursor-pointer gap-[8px] rounded-[10px] data-[active=true]:bg-[rgba(24,24,26,.06)]"
              >
                <EmployeeAvatar agent={item} size={26} radius={8} />
                <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                  <span className="truncate text-[12.5px] font-medium leading-none text-[#18181a]">
                    {employeeDisplayName(item)}
                  </span>
                  <span className="truncate text-[10.5px] leading-none text-[#9a9a9f]">
                    {employeeProfile(item).roleName}
                  </span>
                </span>
                {item.id === agent?.id && <StaffdeckIcon name="check" size={13} className="ml-auto shrink-0 text-[#0f766e]" />}
              </DropdownMenuItem>
            ))}
            {dispatcherItems.length > 0 && (
              <>
                <DropdownMenuLabel className="mt-[4px] shrink-0 border-t border-[rgba(24,24,26,.07)] px-[8px] pt-[7px] pb-[3px] text-[10.5px] font-normal leading-none text-[#9a9a9f]">
                  员工小队
                </DropdownMenuLabel>
                {dispatcherItems.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    data-active={item.id === agent?.id}
                    onSelect={() => onSwitchAgent?.(item.id)}
                    className="shrink-0 cursor-pointer gap-[8px] rounded-[10px] data-[active=true]:bg-[rgba(24,24,26,.06)]"
                  >
                    <DispatcherAvatar
                      preset={String(item.metadata?.avatar_preset || '')}
                      size={26}
                      radius={8}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                      <span className="truncate text-[12.5px] font-medium leading-none text-[#18181a]">
                        {employeeDisplayName(item)}
                      </span>
                      <span className="truncate text-[10.5px] leading-none text-[#9a9a9f]">
                        员工小队 · {Number(item.metadata?.dispatcher_members || 0)} 位同事
                      </span>
                    </span>
                    {item.id === agent?.id && <StaffdeckIcon name="check" size={13} className="ml-auto shrink-0 text-[#0f766e]" />}
                  </DropdownMenuItem>
                ))}
              </>
            )}
            <DropdownMenuItem
              onSelect={onOpenProfile}
              disabled={!agent}
              className="mt-[2px] cursor-pointer gap-[8px] rounded-[10px] text-[12.5px]"
            >
              <StaffdeckIcon name={isDispatcher ? 'branch' : 'user'} size={14} />
              {isDispatcher ? '打开小队档案' : '打开员工档案'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex shrink-0 items-center gap-[2px] pt-[4px]">
          {onNewConversation && (
            <button
              type="button"
              onClick={onNewConversation}
              title="新建对话"
              aria-label="新建对话"
              className={CHAT_ICON_BUTTON_CLASS}
            >
              <IconAdd className="size-[15px]!" />
            </button>
          )}
          <button
            type="button"
            onClick={onToggle}
            title="收起边栏"
            aria-label="收起边栏"
            className={CHAT_ICON_BUTTON_CLASS}
          >
            <PanelCollapseIcon size={15} />
          </button>
        </div>
      </div>

      {/* 待回答提醒：不藏在下拉菜单里，员工卡上常驻一枚红标，owner 一眼看到。 */}
      {handoffCount > 0 && onOpenHandoffs && (
        <button
          type="button"
          onClick={onOpenHandoffs}
          className="flex h-[30px] w-full shrink-0 items-center gap-[7px] rounded-[10px] bg-[#fdecec] px-[10px] text-left text-[12.5px] font-medium text-[#d0342c] transition-colors hover:bg-[#fbdcdc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(211,26,26,0.3)]"
        >
          <span className="relative inline-flex size-[7px] shrink-0 rounded-full bg-[#e02b2b] motion-safe:animate-pulse" />
          <span className="truncate">
            {handoffCount > 99 ? '99+' : handoffCount} 条待回答 · 点击处理
          </span>
        </button>
      )}

      {/* 资产条一直渲染：没选员工时没有 chips，但「更多」里的导航（广场/回首页）不该跟着消失。 */}
      <div className="flex items-center gap-[5px]">
          {assets.map((asset) => (
            <button
              key={asset.key}
              type="button"
              onClick={onOpenProfile}
              title={isDispatcher
                ? `小队成员 ${asset.value} 位 · 打开小队档案`
                : `${asset.label} ${asset.value} 项 · 打开员工档案`}
              className="inline-flex h-[26px] shrink-0 items-center gap-[3px] rounded-[8px] bg-[rgba(24,24,26,.055)] px-[7px] text-[12px] text-[rgba(24,24,26,.8)] transition-colors hover:bg-[rgba(24,24,26,.09)]"
            >
              <span className="text-[#9a9a9f]">{asset.icon}</span>
              {asset.label}
              <b className="font-semibold tabular-nums">{asset.value}</b>
            </button>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title="更多"
                aria-label="更多"
                className="ml-auto inline-flex h-[26px] shrink-0 items-center gap-[3px] rounded-[8px] px-[5px] text-[12px] text-[#6d6d72] transition-colors hover:bg-[rgba(24,24,26,.06)] hover:text-[#18181a]"
              >
                <StaffdeckIcon name="more" size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[168px] rounded-[14px] p-[5px]">
              {onOpenGallery && (
                <DropdownMenuItem
                  onSelect={onOpenGallery}
                  className="cursor-pointer gap-[8px] rounded-[10px] text-[12.5px]"
                >
                  <StaffdeckIcon name="globe" size={14} />
                  数字员工广场
                  {galleryActive && <StaffdeckIcon name="check" size={13} className="ml-auto text-[#0f766e]" />}
                </DropdownMenuItem>
              )}
              {onOpenHandoffs && (
                <DropdownMenuItem
                  onSelect={onOpenHandoffs}
                  className="cursor-pointer gap-[8px] rounded-[10px] text-[12.5px]"
                >
                  <StaffdeckIcon name="chat" size={14} />
                  待回答
                  {handoffCount > 0 && (
                    <span className="ml-auto inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[rgba(245,72,59,.12)] px-[5px] text-[10px] leading-none text-[#d0342c]">
                      {handoffCount > 99 ? '99+' : handoffCount}
                    </span>
                  )}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={onOpenProfile}
                disabled={!agent}
                className="cursor-pointer gap-[8px] rounded-[10px] text-[12.5px]"
              >
                <StaffdeckIcon name="user" size={14} />
                打开员工档案
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={onOpenHome}
                className="cursor-pointer gap-[8px] rounded-[10px] text-[12.5px]"
              >
                <StaffdeckIcon name="grid" size={14} />
                回到开放广场
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
    </div>
  );
}

function ChatSessionSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative px-[14px] pb-[8px]">
      <StaffdeckIcon
        name="search"
        size={14}
        className="pointer-events-none absolute left-[26px] top-1/2 -translate-y-1/2 text-[#9a9a9f]"
      />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="搜索对话"
        aria-label="搜索对话"
        className="h-[36px] w-full rounded-[10px] bg-[rgba(24,24,26,.055)] pl-[32px] pr-[10px] text-[13.5px] text-[#18181a] outline-none transition-colors placeholder:text-[#9a9a9f] focus:bg-[rgba(24,24,26,.075)]"
      />
    </div>
  );
}

/** 会话按员工筛选（多员工会话混排时才需要，收成列表头右侧的小胶囊）。 */
function ChatSessionFilter({
  sessionFilter,
  sessionFilterOptions,
  onSessionFilterChange,
  collapsed = false,
}: Pick<AppSidebarChatProps, 'sessionFilter' | 'sessionFilterOptions' | 'onSessionFilterChange'> & {
  collapsed?: boolean;
}) {
  const current = sessionFilterOptions.find((option) => option.value === sessionFilter) || sessionFilterOptions[0];
  const [namePart, countPart] = current
    ? current.label.split('·').map((part) => part.trim())
    : ['全部员工', ''];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {collapsed ? (
          <button
            type="button"
            aria-label="筛选会话"
            className="inline-grid h-[32px] w-full place-items-center rounded-[8px] text-[#6d6d72] transition-colors hover:bg-[rgba(24,24,26,.06)]"
          >
            <StaffdeckIcon name="filter" size={15} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="筛选会话"
            className="inline-flex h-[22px] max-w-[132px] items-center gap-[4px] rounded-[7px] px-[6px] text-[11.5px] text-[#6d6d72] transition-colors hover:bg-[rgba(24,24,26,.06)] hover:text-[#18181a]"
          >
            <span className="truncate">{namePart}</span>
            {countPart && <span className="shrink-0 tabular-nums text-[#9a9a9f]">{countPart}</span>}
            <IconChevronDown className="size-[11px]! shrink-0" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={collapsed ? 'center' : 'end'}
        side={collapsed ? 'right' : 'bottom'}
        className={cn(
          'flex max-h-[320px] flex-col gap-[2px] overflow-y-auto rounded-[14px] p-[5px]',
          collapsed ? 'min-w-[168px]' : 'min-w-[180px]',
        )}
      >
        {sessionFilterOptions.map((option) => {
          const [optionName, optionCount] = option.label.split('·').map((part) => part.trim());
          const active = option.value === sessionFilter;
          return (
            <DropdownMenuItem
              key={option.value}
              data-active={active}
              onSelect={() => onSessionFilterChange(option.value)}
              className={cn(
                'flex h-[30px] shrink-0 cursor-pointer items-center gap-[6px] rounded-[10px] px-[8px] text-[12.5px]',
                active ? 'bg-[rgba(24,24,26,.06)] text-[#18181a]' : 'text-[rgba(24,24,26,.8)]',
              )}
            >
              <span className="truncate">{optionName}</span>
              {optionCount && <span className="ml-auto shrink-0 tabular-nums text-[#9a9a9f]">{optionCount}</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatSessionRow({
  session,
  agent,
  active,
  unread,
  onOpenSession,
  onRenameSession,
  onDeleteSession,
}: {
  session: ChatSession;
  agent: AgentProfileRead | null;
  active: boolean;
  unread: boolean;
  onOpenSession: (id: string) => void;
  onRenameSession: (session: ChatSession) => void;
  onDeleteSession: (session: ChatSession) => void;
}) {
  const title = sessionTitleFor(session, agent);
  // 「我的团队」已下线，但历史会话里 team_id 仍可能非空：按只读的历史群聊展示，
  // 名称优先用会话自带的 team_name，不再查团队花名册。
  const isTeamGroup = Boolean(session.team_id);
  const displayTitle = isTeamGroup
    ? session.team_name || title.replace(/^团队\s*/, '').replace(/\s*·\s*TL 对话$/, '')
    : title;
  const running = session.status === 'running';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenSession(session.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenSession(session.id);
        }
      }}
      className={cn(
        'group/row relative flex h-[36px] w-full cursor-pointer items-center gap-[6px] rounded-[10px] pl-[10px] pr-[8px] text-left text-[13.5px] transition-colors',
        active
          ? 'bg-white font-medium text-[#18181a] shadow-[0_0_0_0.5px_rgba(24,24,26,.08)]'
          : 'text-[rgba(24,24,26,.8)] hover:bg-[rgba(24,24,26,.045)]',
      )}
    >
      {running && (
        <span
          aria-label="正在回复"
          className="size-[11px] shrink-0 animate-spin rounded-full border-[1.5px] border-[rgba(15,118,110,.25)] border-t-[#0f766e]"
        />
      )}
      {isTeamGroup && (
        <StaffdeckIcon name="chat" size={13} className="shrink-0 text-[#9a9a9f]" />
      )}
      <span className="min-w-0 flex-1 truncate" title={displayTitle}>
        {displayTitle}
      </span>
      {unread && <span className="size-[6px] shrink-0 rounded-full bg-[#f5483b]" aria-label="未读回复" />}
      {!isTeamGroup && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="会话操作"
              onClick={(event) => event.stopPropagation()}
              className="ml-auto inline-grid size-[22px] shrink-0 place-items-center rounded-[7px] text-[#9a9a9f] opacity-0 transition-opacity hover:bg-[rgba(24,24,26,.08)] hover:text-[#18181a] focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
            >
              <StaffdeckIcon name="more" size={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[136px] rounded-[12px] p-[5px]">
            <DropdownMenuItem
              onSelect={() => onRenameSession(session)}
              className="cursor-pointer gap-[8px] rounded-[9px] text-[12.5px]"
            >
              <IconEdit className="size-[13px]!" />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onDeleteSession(session)}
              className="cursor-pointer gap-[8px] rounded-[9px] text-[12.5px] text-[#d0342c] focus:text-[#d0342c]"
            >
              <IconTrash className="size-[13px]!" />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function ChatSessionRowSkeleton() {
  return (
    <div className="flex h-[34px] w-full animate-pulse items-center gap-[8px] rounded-[10px] px-[10px]">
      <span className="h-[11px] flex-1 rounded-full bg-[rgba(24,24,26,.06)]" />
      <span className="h-[9px] w-[34px] shrink-0 rounded-full bg-[rgba(24,24,26,.045)]" />
    </div>
  );
}

function ChatSessionSkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-[2px]">
      {Array.from({ length: rows }).map((_, index) => (
        <ChatSessionRowSkeleton key={index} />
      ))}
    </div>
  );
}

function ChatHandoffButton({
  count = 0,
  onOpen,
  collapsed = false,
}: {
  count?: number;
  onOpen?: () => void;
  collapsed?: boolean;
}) {
  if (!onOpen) return null;
  const badge = count > 99 ? '99+' : String(count);

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            aria-label="待回答"
            className="relative flex h-[32px] w-full items-center justify-center rounded-[8px] text-[#6d6d72] transition-colors hover:bg-[rgba(24,24,26,.06)] hover:text-[#18181a]"
          >
            <IconChatBubble className="size-[16px]!" />
            {count > 0 && (
              <span className="absolute -right-[3px] -top-[4px] inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[#f5483b] px-[4px] text-[9px] leading-none text-white ring-[2px] ring-white">
                {badge}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" align="center">
          {count > 0 ? `待回答 ${badge}` : '待回答'}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center justify-between gap-[12px] rounded-[10px] px-[10px] py-[7px] text-left text-[13px] text-[rgba(24,24,26,.8)] transition-colors hover:bg-[rgba(24,24,26,.06)]"
    >
      <span className="flex min-w-0 items-center gap-[8px]">
        <IconChatBubble className="size-[15px]! shrink-0" />
        <span className="truncate">待回答</span>
      </span>
      {count > 0 && (
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white px-[6px] text-[11px] leading-none text-[#d0342c] shadow-[0_0_0_0.5px_rgba(245,72,59,0.18)]">
          {badge}
        </span>
      )}
    </button>
  );
}

/**
 * 「管理端」入口：紧跟在员工卡下面、搜索框之上。
 *
 * 整行描边按钮 —— 它是对话端回到管理端的唯一入口，不能长得像脚注。
 * 之前挂在会话面板之后（页脚），列表一长就跟着往下跑、一短就往上浮，
 * 一个固定入口不该随内容漂移，所以挪到列表上方。
 */
function ChatAdminEntry({ onOpenAdmin }: { onOpenAdmin: () => void }) {
  return (
    <div className="px-[14px] pb-[10px]">
      <button
        type="button"
        onClick={onOpenAdmin}
        title="切换到管理端"
        className="flex h-[32px] w-full items-center justify-center gap-[6px] rounded-[10px] border-[0.5px] border-[#ded9d2] bg-[#f2f1ee] text-[12.5px] font-medium text-[#3d3d3f] transition-colors hover:bg-[#eae8e3] hover:text-[#18181a]"
      >
        <IconToggle className="size-[14px]! rotate-90" />
        管理端
      </button>
    </div>
  );
}

function CollapsedChatSidebar({
  sessions,
  sessionsLoading = false,
  agents,
  activeSessionId,
  sessionFilter,
  onSessionFilterChange,
  sessionFilterOptions,
  isSessionUnread,
  onOpenSession,
  onNewConversation,
  onOpenHome,
  onOpenGallery,
  galleryActive = false,
  handoffCount = 0,
  onOpenHandoffs,
  onOpenAdmin,
  onToggle,
}: Pick<
  AppSidebarChatProps,
  'sessions' | 'sessionsLoading' | 'agents' | 'activeSessionId' | 'sessionFilter' | 'onSessionFilterChange' | 'sessionFilterOptions' | 'isSessionUnread' | 'onOpenSession' | 'onNewConversation' | 'onOpenHome' | 'onOpenGallery' | 'galleryActive' | 'handoffCount' | 'onOpenHandoffs' | 'onOpenAdmin'
> & { onToggle: () => void }) {
  return (
    <div className="flex h-full w-(--sidebar-width-icon) shrink-0 flex-col items-center gap-[32px] px-[20px] pt-[42px] pb-[10px]">
      <div className="flex w-full flex-col items-center gap-[10px]">
        <button
          type="button"
          title="返回首页"
          aria-label="返回首页"
          onClick={onOpenHome}
          className="flex items-center justify-center p-[10px] transition-opacity hover:opacity-70"
        >
          <BrandLogo markOnly />
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggle}
              aria-label="展开边栏"
              className="flex size-[16px] items-center justify-center text-[#6d6d72] transition-colors hover:text-[#18181a]"
            >
              <IconHeaderCollapse className="size-[16px]! -rotate-90" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            展开边栏
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-[16px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpenGallery}
              aria-label="数字员工广场"
              aria-current={galleryActive ? 'page' : undefined}
              className={cn(
                'flex h-[32px] w-full items-center justify-center rounded-[8px] transition-colors',
                galleryActive
                  ? 'bg-[rgba(24,24,26,.06)] text-[#18181a]'
                  : 'text-[#6d6d72] hover:bg-[rgba(24,24,26,.05)] hover:text-[#18181a]',
              )}
            >
              <IconGlobe className="size-[16px]!" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            数字员工广场
          </TooltipContent>
        </Tooltip>

        <ChatHandoffButton count={handoffCount} onOpen={onOpenHandoffs} collapsed />

        <div className="h-px w-full bg-[rgba(24,24,26,.08)]" />

        <ChatSessionFilter
          collapsed
          sessionFilter={sessionFilter}
          sessionFilterOptions={sessionFilterOptions}
          onSessionFilterChange={onSessionFilterChange}
        />

        {onNewConversation && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onNewConversation}
                aria-label="新建对话"
                className="flex h-[32px] w-full items-center justify-center rounded-[8px] bg-[#18181a] text-white transition-colors hover:bg-[#303030]"
              >
                <IconAdd className="size-[16px]!" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" align="center">
              新建对话
            </TooltipContent>
          </Tooltip>
        )}

        <span className="text-[10px] leading-none text-[#9a9a9f]">会话</span>

        <div className="no-scrollbar mx-[-8px] flex min-h-0 w-[calc(100%+16px)] flex-1 flex-col items-center gap-[8px] overflow-y-auto py-[2px]">
          {sessionsLoading
            ? Array.from({ length: 5 }).map((_, index) => (
                <span key={index} className="size-[34px] shrink-0 animate-pulse rounded-[10px] bg-[rgba(24,24,26,.06)]" />
              ))
            : sessions.map((session) => {
                const agent = sessionAgentFor(session, agents);
                const active = session.id === activeSessionId;
                const unread = isSessionUnread(session);
                const title = sessionTitleFor(session, agent);
                return (
                  <Tooltip key={session.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onOpenSession(session.id)}
                        aria-label={title}
                        className={cn(
                          'relative flex shrink-0 items-center justify-center overflow-hidden transition-shadow',
                          active
                            ? 'size-[40px] rounded-[12px] bg-white shadow-[0_0_0_0.5px_rgba(24,24,26,.16)]'
                            : 'size-[34px] rounded-[10px] bg-[rgba(24,24,26,.06)] text-[rgba(24,24,26,.8)]',
                        )}
                      >
                        {agent && !session.team_id ? (
                          <EmployeeAvatar agent={agent} size={active ? 32 : 34} radius={10} />
                        ) : (
                          <IconChatBubble className="size-[17px]!" />
                        )}
                        {unread && (
                          <span className="absolute right-[2px] top-[2px] size-[6px] rounded-full bg-[#f5483b] ring-[1.5px] ring-white" aria-label="未读回复" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" align="center">
                      {session.team_id
                        ? `${session.team_name || title} · 历史群聊`
                        : agent ? `${agent.name} · ${title}` : title}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
        </div>
      </div>

      <div className="flex items-center justify-center pb-[20px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpenAdmin}
              aria-label="切换到管理端"
              className="flex size-[32px] shrink-0 items-center justify-center rounded-[10px] bg-[rgba(24,24,26,.05)] text-[#6d6d72] transition-colors hover:bg-[rgba(24,24,26,.09)] hover:text-[#18181a]"
            >
              <IconViewMasonry className="size-[16px]!" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            切换到管理端
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function ChatSidebarVariant({
  sessions,
  sessionsLoading = false,
  agents,
  activeSessionId,
  sessionFilter,
  onSessionFilterChange,
  sessionFilterOptions,
  isSessionUnread,
  onOpenSession,
  onNewConversation,
  onOpenHome,
  onOpenGallery,
  galleryActive = false,
  handoffCount = 0,
  onOpenHandoffs,
  onRenameSession,
  onDeleteSession,
  onOpenAdmin,
  currentAgent = null,
  currentRoleName = '',
  running = false,
  switchAgents = [],
  switchDispatchers = [],
  onSwitchAgent,
}: AppSidebarChatProps) {
  const { toggleSidebar, state } = useSidebar();
  const collapsed = state === 'collapsed';
  const showSkeleton = sessionsLoading && sessions.length === 0;
  const [query, setQuery] = useState('');

  // ⌘\ / Ctrl+\ 收展侧栏（左栏底部有对应提示，别让提示变成假承诺）
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '\\' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      toggleSidebar();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);

  function openEmployeeProfile() {
    if (!currentAgent) return;
    // 档案页从 localStorage 读「当前员工」，先落盘再开窗；此处**不广播** scope-change，
    // 否则会把本标签页正在进行的对话切到别的员工。
    persistSharedAgentScope(currentAgent.id);
    window.open(EnterpriseRoute.Dashboard, '_blank', 'noopener,noreferrer');
  }

  const filteredSessions = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return sessions;
    return sessions.filter((session) => {
      const agent = sessionAgentFor(session, agents);
      const haystack = `${sessionTitleFor(session, agent)} ${sessionSubtitleFor(session, agent)}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }, [sessions, agents, query]);

  const groups = useMemo(() => groupSessionsByRecency(filteredSessions), [filteredSessions]);

  if (collapsed) {
    return (
      <Sidebar collapsible="icon" className={CHAT_SIDEBAR_CLASS}>
        <CollapsedChatSidebar
          sessions={sessions}
          sessionsLoading={showSkeleton}
          agents={agents}
          activeSessionId={activeSessionId}
          sessionFilter={sessionFilter}
          onSessionFilterChange={onSessionFilterChange}
          sessionFilterOptions={sessionFilterOptions}
          isSessionUnread={isSessionUnread}
          onOpenSession={onOpenSession}
          onNewConversation={onNewConversation}
          onOpenHome={onOpenHome}
          onOpenGallery={onOpenGallery}
          galleryActive={galleryActive}
          handoffCount={handoffCount}
          onOpenHandoffs={onOpenHandoffs}
          onOpenAdmin={onOpenAdmin}
          onToggle={toggleSidebar}
        />
      </Sidebar>
    );
  }

  return (
    <Sidebar collapsible="icon" className={CHAT_SIDEBAR_CLASS}>
      <div className="flex h-full w-(--sidebar-width) shrink-0 flex-col">
        <ChatEmployeeCard
          agent={currentAgent}
          roleName={currentRoleName}
          running={running}
          onOpenProfile={openEmployeeProfile}
          onNewConversation={onNewConversation}
          onToggle={toggleSidebar}
          galleryActive={galleryActive}
          handoffCount={handoffCount}
          onOpenGallery={onOpenGallery}
          onOpenHandoffs={onOpenHandoffs}
          onOpenHome={onOpenHome}
          switchAgents={switchAgents.filter((item) => !item.is_overall)}
          switchDispatchers={switchDispatchers.filter((item) => !item.is_overall)}
          onSwitchAgent={onSwitchAgent}
        />

        <ChatAdminEntry onOpenAdmin={onOpenAdmin} />

        <ChatSessionSearch value={query} onChange={setQuery} />

        {/*
          面板不吃 flex-1：一个员工通常只有两三组会话，撑满整列会在下半屏留一大块空灰。
          改成内容高度 + 上限收缩（父级 min-h-0，内容超高时这里出现滚动条）。
        */}
        <div className="mx-[8px] mb-[10px] flex min-h-0 flex-col overflow-hidden rounded-[14px] bg-[rgba(24,24,26,.035)]">
          <div className="flex items-center justify-between gap-[6px] px-[10px] pt-[9px] pb-[5px]">
            <span className="text-[12px] font-medium text-[#9a9a9f]">会话</span>
            <ChatSessionFilter
              sessionFilter={sessionFilter}
              sessionFilterOptions={sessionFilterOptions}
              onSessionFilterChange={onSessionFilterChange}
            />
          </div>

          <div className="no-scrollbar flex min-h-0 flex-col gap-[8px] overflow-y-auto px-[6px] pb-[6px]">
            {showSkeleton ? (
              <ChatSessionSkeletonList />
            ) : groups.length === 0 ? (
              <div className="flex flex-col items-center gap-[8px] py-[26px] text-center text-[12.5px] text-[#9a9a9f]">
                <StaffdeckIcon name="inbox" size={20} />
                <span>{query.trim() ? '没有匹配的对话' : '暂无历史会话'}</span>
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.label} className="flex flex-col gap-[1px]">
                  <div className="px-[10px] pt-[4px] pb-[3px] text-[12px] font-medium text-[#9a9a9f]">
                    {group.label}
                  </div>
                  {group.items.map((session) => (
                    <ChatSessionRow
                      key={session.id}
                      session={session}
                      agent={sessionAgentFor(session, agents)}
                      active={session.id === activeSessionId}
                      unread={isSessionUnread(session)}
                      onOpenSession={onOpenSession}
                      onRenameSession={onRenameSession}
                      onDeleteSession={onDeleteSession}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Sidebar>
  );
}

export default function AppSidebar(props: AppSidebarProps) {
  if (props.variant === 'chat') {
    return <ChatSidebarVariant {...props} />;
  }
  return <ManagementSidebar {...props} />;
}
