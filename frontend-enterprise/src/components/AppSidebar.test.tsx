// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AgentProfileRead } from '@/types';
import type { DispatcherRead } from '@/lib/dispatcher';

import AppSidebar from './AppSidebar';

const agent: AgentProfileRead = {
  id: 'agent-1',
  tenant_id: 'tenant_demo',
  name: '小艾',
  is_overall: false,
  status: 'active',
  metadata: {},
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const dispatcher: DispatcherRead = {
  id: 'dispatcher-1',
  tenant_id: 'tenant_demo',
  name: '测试Multi',
  description: '把问题分给最合适的同事',
  kind: 'dispatcher',
  status: 'active',
  model_name: 'deepseek-v4.1-flash',
  members: [
    {
      member_agent_id: 'agent-1',
      routing_rule: '增长相关的问题转给他',
      example_queries: ['怎么拉新'],
      sort_order: 0,
      status: 'active',
      agent_name: '小艾',
      agent_status: 'active',
      free_model_enabled: false,
      has_own_model: false,
    },
  ],
  config: {
    fallback_mode: 'clarify',
    fallback_reply: '',
    offer_candidates: true,
    min_confidence: 0.5,
  },
  usage_count: 3,
  published_to_gallery: false,
};

function stubRadixPointerApis() {
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

function renderSidebar(props: {
  selectedAgentId: string;
  onSelectAgent?: (value: string) => void;
}) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar
            selected="/enterprise/dashboard"
            onNavigate={() => {}}
            isAdmin={false}
            scopeAgents={[agent]}
            selectedAgentId={props.selectedAgentId}
            onSelectAgent={props.onSelectAgent ?? (() => {})}
            onOpenChat={() => {}}
          />
        </SidebarProvider>
      </TooltipProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  stubRadixPointerApis();
});

describe('AppSidebar dispatcher scope', () => {
  function renderDispatcherSidebar(onNavigate: (route: string) => void = () => {}) {
    return render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              selected="/enterprise/dashboard"
              onNavigate={onNavigate}
              isAdmin={false}
              sidebarDispatcher={dispatcher}
              scopeAgents={[agent]}
              scopeDispatchers={[dispatcher]}
              selectedAgentId="dispatcher-1"
              onSelectAgent={() => {}}
              onOpenChat={() => {}}
            />
          </SidebarProvider>
        </TooltipProvider>
      </I18nProvider>,
    );
  }

  it('当前作用域是员工小队时显示它的名字，而不是「未选择 / -」', () => {
    renderDispatcherSidebar();

    const trigger = screen.getByLabelText('切换当前员工');
    expect(within(trigger).getByText('员工小队')).toBeTruthy();
    expect(within(trigger).getByText('测试Multi')).toBeTruthy();
    expect(within(trigger).queryByText('未选择')).toBeNull();
    expect(within(trigger).queryByText('-')).toBeNull();
  });

  it('员工能力那组导航（知识库/技能/SOP/工具）对它不出现', () => {
    renderDispatcherSidebar();

    expect(screen.queryByText('知识库')).toBeNull();
    expect(screen.queryByText('技能')).toBeNull();
    expect(screen.queryByText('SOP')).toBeNull();
    expect(screen.queryByText('工具')).toBeNull();
    // 换成对员工小队成立的入口
    expect(screen.getByText('员工小队档案')).toBeTruthy();
    expect(screen.getByText('成员与路由规则')).toBeTruthy();
    // 员工档案这个名字也不该出现（它不是一个员工）
    expect(screen.queryByText('员工档案')).toBeNull();
  });

  it('「成员与路由规则」落到小队档案并带上 config=members 深链', async () => {
    // 它表达的是「改这支小队的成员和路由」，不是「看所有小队」。
    // 曾经指向 /enterprise/squads（我的小队列表页）—— 点下去是列表，
    // 列表里没有「当前这支」的概念，用户以为跳错了（截图反馈）。
    const onNavigate = vi.fn();
    renderDispatcherSidebar(onNavigate);

    await userEvent.click(screen.getByText('成员与路由规则'));

    expect(onNavigate).toHaveBeenCalledWith('/enterprise/dashboard?config=members');
  });

  it('切换器下拉里把员工小队单独分组，副标题是成员数而不是岗位名', async () => {
    const user = userEvent.setup();
    const onSelectAgent = vi.fn();
    render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              selected="/enterprise/dashboard"
              onNavigate={() => {}}
              isAdmin={false}
              sidebarDispatcher={dispatcher}
              scopeAgents={[agent]}
              scopeDispatchers={[dispatcher]}
              selectedAgentId="dispatcher-1"
              onSelectAgent={onSelectAgent}
              onOpenChat={() => {}}
            />
          </SidebarProvider>
        </TooltipProvider>
      </I18nProvider>,
    );

    await user.click(screen.getByLabelText('切换当前员工'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('员工小队')).toBeTruthy();
    const item = within(menu)
      .getAllByRole('menuitem')
      .find((row) => row.textContent?.includes('测试Multi'));
    expect(item?.textContent).toContain('1/3 位同事');
    expect(item?.textContent).not.toContain('待补充岗位');
  });

  it('普通员工作用域下仍然是原来那套员工导航（回归）', () => {
    render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              selected="/enterprise/dashboard"
              onNavigate={() => {}}
              isAdmin={false}
              sidebarAgent={agent}
              scopeAgents={[agent]}
              selectedAgentId="agent-1"
              onSelectAgent={() => {}}
              onOpenChat={() => {}}
            />
          </SidebarProvider>
        </TooltipProvider>
      </I18nProvider>,
    );

    expect(screen.getByText('知识库')).toBeTruthy();
    expect(screen.getByText('SOP')).toBeTruthy();
    expect(screen.queryByText('成员与路由规则')).toBeNull();
  });
});

describe('AppSidebar chat variant group conversations', () => {
  const leaderAgent: AgentProfileRead = { ...agent, id: 'agent-tl', name: '队长' };
  function renderChatSidebar(
    handlers: { onOpenHome?: () => void; onOpenGallery?: () => void } = {},
  ) {
    const sessions = [
      {
        id: 'session-tl',
        tenant_id: 'tenant_demo',
        agent_id: 'agent-tl',
        team_id: 'team-1',
        title: '团队 增长团队 · TL 对话',
        status: 'active',
        updated_at: '2026-08-01T00:00:00Z',
      },
      {
        id: 'session-member',
        tenant_id: 'tenant_demo',
        agent_id: 'agent-1',
        title: '写公告',
        status: 'active',
        updated_at: '2026-08-01T00:00:00Z',
      },
    ];
    return render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              variant="chat"
              sessions={sessions}
              agents={[agent, leaderAgent]}
              currentAgent={agent}
              currentRoleName="增长顾问"
              sessionFilter="all"
              onSessionFilterChange={() => {}}
              sessionFilterOptions={[{ value: 'all', label: '全部员工 · 2' }]}
              isSessionUnread={() => false}
              onOpenSession={() => {}}
              onOpenHome={handlers.onOpenHome ?? (() => {})}
              onOpenGallery={handlers.onOpenGallery ?? (() => {})}
              onRenameSession={() => {}}
              onDeleteSession={() => {}}
              onOpenAdmin={() => {}}
            />
          </SidebarProvider>
        </TooltipProvider>
      </I18nProvider>,
    );
  }

  it('「更多」里的「回到开放广场」回站点首页，而不是数字员工广场（对话端）', async () => {
    const user = userEvent.setup();
    const onOpenHome = vi.fn();
    const onOpenGallery = vi.fn();
    renderChatSidebar({ onOpenHome, onOpenGallery });

    // 员工卡右上角的「更多」——品牌 logo 已从左栏移除，回首页入口收进这个菜单。
    await user.click(screen.getByLabelText('更多'));
    await user.click(await screen.findByText('回到开放广场'));

    expect(onOpenHome).toHaveBeenCalledTimes(1);
    expect(onOpenGallery).not.toHaveBeenCalled();
  });

  it('「管理端」在搜索框上方，不跟随会话列表长度漂移', () => {
    renderChatSidebar();

    const adminButton = screen.getByText('管理端').closest('button') as HTMLElement;
    const searchInput = screen.getByLabelText('搜索对话');
    const sessionList = screen.getByText('写公告');

    // 搜索框在管理端之后 → 按钮不在列表下方，列表变长也顶不动它
    expect(
      adminButton.compareDocumentPosition(searchInput) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      adminButton.compareDocumentPosition(sessionList) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('会话行只写标题（不再画第二遍头像），历史团队会话标为群聊', async () => {
    renderChatSidebar();

    const row = screen.getByText('写公告').closest('[role="button"]') as HTMLElement;
    expect(within(row).queryByRole('img')).toBeNull();
    expect(screen.getByText('增长团队')).toBeTruthy();
    // 员工卡才是头像出现的地方：名字 + 岗位副标题
    expect(screen.getByText('小艾')).toBeTruthy();
    expect(screen.getByText('增长顾问')).toBeTruthy();
  });
});

describe('AppSidebar primary navigation', () => {
  function renderManagementSidebar(
    onNavigate: (route: string) => void = () => {},
    { isAdmin = false }: { isAdmin?: boolean } = {},
  ) {
    return render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              selected="/enterprise/dashboard"
              onNavigate={onNavigate}
              isAdmin={isAdmin}
              scopeAgents={[agent]}
              selectedAgentId="agent-1"
              onSelectAgent={() => {}}
              onOpenChat={() => {}}
            />
          </SidebarProvider>
        </TooltipProvider>
      </I18nProvider>,
    );
  }

  it('「我的团队」已从侧边栏移除', () => {
    renderManagementSidebar();
    expect(screen.queryByText('我的团队')).toBeNull();
    expect(screen.queryByText('团队对话')).toBeNull();
  });

  it('决策助手不在侧边栏：入口已移入 Agent 广场清单', () => {
    renderManagementSidebar();
    expect(screen.queryByText('决策助手')).toBeNull();
  });

  it('AI CodeReviewer 不在侧边栏：入口已移入 Agent 广场清单（adminOnly 条目）', () => {
    renderManagementSidebar(undefined, { isAdmin: true });
    expect(screen.queryByText('AI CodeReviewer')).toBeNull();
  });

  it('账号管理不在侧边栏：已并入 API Key 审批页的用户管理 tab', () => {
    renderManagementSidebar(undefined, { isAdmin: false });
    expect(screen.queryByText('账号管理')).toBeNull();

    cleanup();
    renderManagementSidebar(undefined, { isAdmin: true });
    expect(screen.queryByText('账号管理')).toBeNull();
    expect(screen.getByText('API Key 审批')).toBeTruthy();
  });
});

/**
 * 切换器要分「员工」和「员工小队」两段：小队是调度入口，不是一个人，
 * 混在员工列表里既不显眼也看不出它是小队。
 */
describe('AppSidebar chat 员工切换器', () => {
  const squad = {
    id: 'dispatcher-1',
    tenant_id: 'tenant_demo',
    name: '测试Multi',
    is_overall: false,
    kind: 'dispatcher',
    status: 'active',
    metadata: { avatar_preset: 'orbit', dispatcher_members: 3 },
    resources: [],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  } as unknown as AgentProfileRead;

  function renderSwitcher(onSwitchAgent: (id: string) => void) {
    return render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              variant="chat"
              sessions={[]}
              agents={[agent]}
              currentAgent={agent}
              currentRoleName="增长顾问"
              switchAgents={[agent]}
              switchDispatchers={[squad]}
              onSwitchAgent={onSwitchAgent}
              sessionFilter="all"
              onSessionFilterChange={() => {}}
              sessionFilterOptions={[{ value: 'all', label: '全部会話 · 0' }]}
              isSessionUnread={() => false}
              onOpenSession={() => {}}
              onOpenHome={() => {}}
              onOpenGallery={() => {}}
              onRenameSession={() => {}}
              onDeleteSession={() => {}}
              onOpenAdmin={() => {}}
            />
          </SidebarProvider>
        </TooltipProvider>
      </I18nProvider>,
    );
  }

  it('下拉里「员工小队」单独成组，并点了就对小队开草稿', async () => {
    const user = userEvent.setup();
    const onSwitchAgent = vi.fn();
    renderSwitcher(onSwitchAgent);

    await user.click(screen.getByLabelText('切换当前员工'));

    expect(await screen.findByText('员工小队')).toBeTruthy();
    expect(screen.getByText('员工小队 · 3 位同事')).toBeTruthy();

    await user.click(screen.getByText('测试Multi'));
    expect(onSwitchAgent).toHaveBeenCalledWith('dispatcher-1');
  });

  it('当前是小队时，底部动作改成「打开小队档案」', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              variant="chat"
              sessions={[]}
              agents={[agent]}
              currentAgent={squad}
              currentRoleName=""
              switchAgents={[agent]}
              switchDispatchers={[squad]}
              sessionFilter="all"
              onSessionFilterChange={() => {}}
              sessionFilterOptions={[{ value: 'all', label: '全部会话 · 0' }]}
              isSessionUnread={() => false}
              onOpenSession={() => {}}
              onOpenHome={() => {}}
              onOpenGallery={() => {}}
              onRenameSession={() => {}}
              onDeleteSession={() => {}}
              onOpenAdmin={() => {}}
            />
          </SidebarProvider>
        </TooltipProvider>
      </I18nProvider>,
    );

    await user.click(screen.getByLabelText('切换当前员工'));
    expect(await screen.findByText('打开小队档案')).toBeTruthy();
  });
});

describe('AppSidebar 微信接入入口', () => {
  it('侧栏一级菜单包含「微信接入」，点击跳到 /enterprise/wechat', async () => {
    const onNavigate = vi.fn();
    render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              selected="/enterprise/agents"
              onNavigate={onNavigate}
              isAdmin={false}
              scopeAgents={[agent]}
              selectedAgentId="agent-1"
              onSelectAgent={() => {}}
              onOpenChat={() => {}}
            />
          </SidebarProvider>
        </TooltipProvider>
      </I18nProvider>,
    );

    const entry = screen.getByText('微信接入');
    expect(entry).toBeTruthy();

    await userEvent.click(entry);
    expect(onNavigate).toHaveBeenCalledWith('/enterprise/wechat');
  });
});
