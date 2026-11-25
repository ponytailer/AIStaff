// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AgentProfileRead } from '@/types';

import ScenesPage from './ScenesPage';

/**
 * 场景列表页 / 员工档案场景 tab。
 *
 * 断言重点放在「用户会不会被误导」：
 * 1. 成员看不到建/改/删入口（不是点了才 403）；
 * 2. 没有数据表时不能让人点「新建」进定义器（进去也是空转）；
 * 3. 绑定员工 0 个 / 3 个的文案不能长得一样；
 * 4. 表被删除的场景不能显示成正常状态。
 */

const admin = { id: 'user-admin', tenant_id: 'tenant_demo', username: 'admin', role: 'admin' as const };
const member = { id: 'user-1', tenant_id: 'tenant_demo', username: 'demo', role: 'member' as const };

const employee: AgentProfileRead = {
  id: 'agent-1',
  tenant_id: 'tenant_demo',
  name: '行程管家',
  is_overall: false,
  status: 'active',
  metadata: { owner_user_id: 'user-1' },
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const TABLE = {
  id: 'sctable_1',
  tenant_id: 'tenant_demo',
  name: '滑雪价目',
  source_filename: 'ski.csv',
  columns: [
    { key: '人数', label: '人数', type: 'number', unit: '人', aliases: [], required: false, filterable: true, order: 0 },
    { key: '天数', label: '天数', type: 'number', unit: '天', aliases: [], required: false, filterable: true, order: 1 },
    { key: '预算', label: '预算', type: 'number', unit: '元', aliases: [], required: false, filterable: true, order: 2 },
    { key: '计划内容', label: '计划内容', type: 'text', unit: '', aliases: [], required: false, filterable: false, order: 3 },
  ],
  quality: [],
  row_count: 5,
  status: 'ready',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
};

function scene(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'scene_1',
    tenant_id: 'tenant_demo',
    name: '滑雪行程推荐',
    description: '按人数天数预算推荐行程',
    icon: '🎿',
    status: 'published',
    table_id: 'sctable_1',
    trigger: { shortcut: true, keywords: ['滑雪'], shortcut_label: '', examples: [], require_slots: true, bypass_llm_router: true },
    slots: [
      { key: 'people', label: '人数', target: '人数' },
      { key: 'days', label: '天数', target: '天数' },
      { key: 'budget', label: '预算', target: '预算' },
    ],
    match_action: {},
    respond_action: { mode: 'template', template: '{{计划内容}}' },
    shortcut: { action: 'form' },
    agent_ids: [] as string[],
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(opts: { scenes?: unknown[]; tables?: unknown[]; agents?: unknown[] } = {}) {
  const calls: string[] = [];
  const tables = (opts.tables ?? [TABLE]) as typeof TABLE[];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      // 详情接口返回 {table, rows}；列表接口返回数组。两者顺序不能反 ——
      // '/tables/xxx' 也包含 '/tables'，必须先判详情。
      const detail = tables.find((table) => url.includes(`/scenes/tables/${table.id}`));
      if (detail) {
        return jsonResponse({
          table: detail,
          rows: [
            { row_index: 0, values: { 人数: '4', 天数: '5', 预算: '3000', 计划内容: '经典雪山五日' } },
          ],
        });
      }
      if (url.includes('/api/enterprise/scenes/tables')) return jsonResponse(tables);
      if (url.includes('/api/enterprise/scenes')) return jsonResponse(opts.scenes ?? []);
      if (url.includes('/api/enterprise/agents')) return jsonResponse(opts.agents ?? [employee]);
      return jsonResponse([]);
    }),
  );
  return calls;
}

function renderPage(props: Parameters<typeof ScenesPage>[0] = {}) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <MemoryRouter>
          <ScenesPage {...props} />
        </MemoryRouter>
      </TooltipProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('ScenesPage 列表', () => {
  it('渲染场景名、数据表名、槽位与状态', async () => {
    mockFetch({ scenes: [scene()] });
    renderPage({ currentUser: admin });

    expect(await screen.findByText('滑雪行程推荐')).toBeTruthy();
    expect(screen.getByText('滑雪价目')).toBeTruthy();
    expect(screen.getByText('人数 / 天数 / 预算')).toBeTruthy();
    expect(screen.getByText('已发布')).toBeTruthy();
  });

  it('绑定 0 个员工时显示「未绑定员工」而不是空白', async () => {
    mockFetch({ scenes: [scene({ agent_ids: [] })] });
    renderPage({ currentUser: admin });
    expect(await screen.findByText('未绑定员工')).toBeTruthy();
  });

  it('绑定 3 个员工时折叠成「第一个等 N 个」', async () => {
    mockFetch({ scenes: [scene({ agent_ids: ['a1', 'a2', 'a3'] })] });
    renderPage({ currentUser: admin });
    expect(await screen.findByText(/等 3 个员工/)).toBeTruthy();
  });

  it('绑定员工列显示员工名字，而不是 agent_xxx 原始 id', async () => {
    // 后端只存 id。「绑定员工」列如果直接把 id 渲染出来，用户看到的是一串
    // agent_319ccac9acd54b4b —— 认不出是谁，也没法点进去。
    mockFetch({
      scenes: [scene({ agent_ids: ['agent-1'] })],
      agents: [employee],
    });
    renderPage({ currentUser: admin });

    expect(await screen.findByText('已绑定 行程管家')).toBeTruthy();
    expect(screen.queryByText(/已绑定 agent-1/)).toBeNull();
  });

  it('拿不到员工名单时退化成显示 id，不影响整页', async () => {
    // 员工接口挂了不该让场景页报错 —— 这一列只是可读性问题。
    mockFetch({ scenes: [scene({ agent_ids: ['agent-1'] })], agents: [] });
    renderPage({ currentUser: admin });

    expect(await screen.findByText('已绑定 agent-1')).toBeTruthy();
  });

  it('数据表被删掉后不显示成正常状态', async () => {
    mockFetch({ scenes: [scene({ table_id: 'sctable_gone' })] });
    renderPage({ currentUser: admin });
    expect(await screen.findByText('表已删除')).toBeTruthy();
  });

  it('没有场景时给出「新建」引导（有表的前提下）', async () => {
    mockFetch({ scenes: [] });
    renderPage({ currentUser: admin });
    expect(await screen.findByText(/还没有场景/)).toBeTruthy();
  });

  it('一张表都没有时，空态指向「先导入表」而不是「新建场景」', async () => {
    // 直接引导去新建，用户点进去会发现定义器里选不了表 —— 白跑一趟
    mockFetch({ scenes: [], tables: [] });
    renderPage({ currentUser: admin });
    expect(await screen.findByText(/先导入一张表/)).toBeTruthy();
  });
});

describe('ScenesPage 权限', () => {
  it('管理员看到「新建场景」与操作列', async () => {
    mockFetch({ scenes: [scene()] });
    renderPage({ currentUser: admin });
    expect(await screen.findByText('＋ 新建场景')).toBeTruthy();
    expect(screen.getByLabelText('场景操作')).toBeTruthy();
  });

  it('普通成员在全局列表页没有写入口（不是点了才 403）', async () => {
    mockFetch({ scenes: [scene()] });
    renderPage({ currentUser: member });
    await screen.findByText('滑雪行程推荐');
    expect(screen.queryByText('＋ 新建场景')).toBeNull();
    expect(screen.queryByLabelText('场景操作')).toBeNull();
  });

  it('员工档案 tab（带 agentId）里成员有写入口 —— 这是自己员工的场景', async () => {
    mockFetch({ scenes: [scene({ agent_ids: ['agent-1'] })] });
    renderPage({ currentUser: member, agentId: 'agent-1', embedded: true });
    expect(await screen.findByText('＋ 新建场景')).toBeTruthy();
  });

  it('带 agentId 时按 agent_id 过滤查询', async () => {
    const calls = mockFetch({ scenes: [scene()] });
    renderPage({ currentUser: member, agentId: 'agent-1', embedded: true });
    await screen.findByText('滑雪行程推荐');
    expect(calls.some((url) => url.includes('agent_id=agent-1'))).toBe(true);
  });
});

describe('ScenesPage 新建入口的前置条件', () => {
  it('没有数据表时点「新建」给出明确提示，不打开定义器', async () => {
    mockFetch({ scenes: [], tables: [] });
    const user = userEvent.setup();
    renderPage({ currentUser: admin });

    const button = await screen.findByText('＋ 新建场景');
    await user.click(button);

    // 定义器的标题不会出现 —— 因为压根没进定义器
    await waitFor(() => {
      expect(screen.queryByLabelText('新建场景')).toBeNull();
    });
  });

  it('有表时点「新建」打开定义器', async () => {
    mockFetch({ scenes: [], tables: [TABLE] });
    const user = userEvent.setup();
    renderPage({ currentUser: admin });

    await user.click(await screen.findByText('＋ 新建场景'));
    expect(await screen.findByLabelText('新建场景')).toBeTruthy();
  });
});

describe('SceneEditor 打开后的内容', () => {
  it('新建时自动按表头铺好三个语义槽位', async () => {
    mockFetch({ scenes: [], tables: [TABLE] });
    const user = userEvent.setup();
    renderPage({ currentUser: admin });
    await user.click(await screen.findByText('＋ 新建场景'));

    const dialog = await screen.findByLabelText('新建场景');
    // 三个语义槽位应该都出现，并且已经映射到同名列
    const selects = await within(dialog).findAllByRole('combobox');
    const mapped = selects
      .map((node) => (node as HTMLSelectElement).value)
      .filter((value) => value !== '' && value !== undefined);
    expect(mapped).toEqual(expect.arrayContaining(['人数', '天数', '预算']));
  });

  it('槽位缺预算时给出 warning 文案而不是拦死', async () => {
    mockFetch({ scenes: [scene({ slots: [{ key: 'people', label: '人数', target: '人数' }] })], tables: [TABLE] });
    const user = userEvent.setup();
    renderPage({ currentUser: admin });

    await screen.findByText('滑雪行程推荐');
    await user.click(screen.getByLabelText('场景操作'));
    await user.click(await screen.findByText('编辑'));

    const dialog = await screen.findByLabelText('编辑场景');
    expect(await within(dialog).findByText(/没配预算槽位/)).toBeTruthy();
  });

  it('数据表有质量问题时在定义器里显式列出', async () => {
    const dirtyTable = {
      ...TABLE,
      quality: [
        { level: 'warning', code: 'unit_mismatch', message: '有 1 行的值与列单位不符', column: '人数', row_count: 1 },
      ],
    };
    mockFetch({ scenes: [], tables: [dirtyTable] });
    const user = userEvent.setup();
    renderPage({ currentUser: admin });
    await user.click(await screen.findByText('＋ 新建场景'));

    const dialog = await screen.findByLabelText('新建场景');
    expect(await within(dialog).findByText(/单位不符/)).toBeTruthy();
    expect(within(dialog).getByText('建议检查')).toBeTruthy();
  });
});