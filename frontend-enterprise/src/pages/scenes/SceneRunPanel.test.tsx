// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';

import ScenesPage from './ScenesPage';

/**
 * 定义器的试跑面板。
 *
 * 试跑是调策略的唯一反馈通道 —— 没有它，管理员改「阈值 / 容差 / 模板」
 * 就完全是盲调。所以这里测的不是像素，而是三件事：
 * 1. 空结果必须给出**可操作**的解释（不是「暂无结果」）；
 * 2. 漏斗要显示每一步筛掉了多少，让「为什么只剩一条」可追溯；
 * 3. 模板预览要真的用命中行渲染，写错占位符要能看见。
 */

const admin = { id: 'user-admin', tenant_id: 'tenant_demo', username: 'admin', role: 'admin' as const };

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

const SCENE = {
  id: 'scene_1',
  tenant_id: 'tenant_demo',
  name: '滑雪行程推荐',
  description: '按人数天数预算推荐行程',
  icon: '🎿',
  status: 'published',
  table_id: 'sctable_1',
  trigger: { shortcut: true, keywords: [], shortcut_label: '', examples: [], require_slots: true, bypass_llm_router: true },
  slots: [
    { key: 'people', label: '人数', target: '人数', unit: '人' },
    { key: 'days', label: '天数', target: '天数', unit: '天' },
    { key: 'budget', label: '预算', target: '预算', unit: '元' },
  ],
  match_action: {},
  respond_action: { mode: 'template', template: '为你找到 {{计划内容}}，共 {{预算}} 元' },
  shortcut: { action: 'form' },
  agent_ids: ['agent-1'],
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
};

const EMPTY_RUN = {
  scene_id: 'scene_1',
  hits: [],
  ranked: [],
  steps: [
    { key: 'normalize', label: '解析', detail: '', from: 5, to: 5, dropText: '', ratio: 0 },
    { key: 'people', label: '人数', detail: '', from: 5, to: 0, dropText: '跳过 5 行', ratio: 1 },
  ],
  total: 5,
  normalized_count: 5,
  unconvertible: 0,
  gate_out: 0,
  reranked: false,
  model_used: false,
  invalid_budget: false,
  empty_reason: '表里没有 99 人的方案（5 行都在人数这层被排除）。',
  run_id: '',
};

const HIT_RUN = {
  ...EMPTY_RUN,
  hits: [
    {
      row_id: 'row_1',
      values: { 人数: '4', 天数: '5', 预算: '3000', 计划内容: '经典雪山五日' },
      score: 0.02,
      days_dev: 0,
      budget_dev: 0.04,
      fused: null,
    },
  ],
  steps: [
    { key: 'normalize', label: '解析', detail: '', from: 5, to: 5, dropText: '', ratio: 0 },
    { key: 'people', label: '人数', detail: '', from: 5, to: 2, dropText: '跳过 3 行', ratio: 0.6 },
  ],
  empty_reason: '',
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(runBody: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // 顺序敏感：/scenes/scene_1 也以 /scenes 开头，详情必须排在列表之前
      if (url.includes('/api/enterprise/scenes/scene_1/run')) return jsonResponse(runBody);
      if (url.includes('/api/enterprise/scenes/scene_1')) return jsonResponse(SCENE);
      if (url.includes('/scenes/tables/sctable_1')) {
        return jsonResponse({ table: TABLE, rows: [{ row_index: 0, values: { 计划内容: '经典雪山五日' } }] });
      }
      if (url.includes('/api/enterprise/scenes/tables')) return jsonResponse([TABLE]);
      if (/\/api\/enterprise\/scenes(\?|$)/.test(url)) return jsonResponse([SCENE]);
      if (url.includes('/api/enterprise/agents')) return jsonResponse([]);
      return jsonResponse([]);
    }),
  );
}

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  render(
    <I18nProvider>
      <TooltipProvider>
        <MemoryRouter>
          <ScenesPage currentUser={admin} />
        </MemoryRouter>
      </TooltipProvider>
    </I18nProvider>,
  );
  await screen.findByText('滑雪行程推荐');
  await user.click(screen.getByLabelText('场景操作'));
  await user.click(await screen.findByText('编辑'));
  return screen.findByLabelText('编辑场景');
}

async function fillAndRun(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, people = '99') {
  const peopleInput = within(dialog).getByPlaceholderText('单位：人');
  await user.type(peopleInput, people);
  // 「试跑」既是面板标题也是按钮，按 role 取按钮那个
  await user.click(within(dialog).getByRole('button', { name: /^试跑$/ }));
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

describe('试跑：空结果', () => {
  it('显示后端给的量化原因，而不是笼统的「没找到」', async () => {
    mockFetch(EMPTY_RUN);
    const user = userEvent.setup();
    const dialog = await openEditor(user);
    await fillAndRun(user, dialog);

    expect(await within(dialog).findByText(/表里没有 99 人的方案/)).toBeTruthy();
  });

  it('漏斗里能看到是哪一层把行筛空的', async () => {
    mockFetch(EMPTY_RUN);
    const user = userEvent.setup();
    const dialog = await openEditor(user);
    await fillAndRun(user, dialog);

    await within(dialog).findByText(/表里没有 99 人/);
    // 「人数」在表头、槽位行、漏斗里都会出现，用漏斗独有的数字串定位
    expect(within(dialog).getByText('5 → 0')).toBeTruthy();
    expect(within(dialog).getByText(/跳过 5 行/)).toBeTruthy();
  });

  it('没填任何条件时不发请求，只提示（避免一次必然空转的查询）', async () => {
    mockFetch(EMPTY_RUN);
    const user = userEvent.setup();
    const dialog = await openEditor(user);

    const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await user.click(within(dialog).getByRole('button', { name: /^试跑$/ }));
    await waitFor(() => {
      const after = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      expect(after).toBe(before);
    });
  });
});

describe('试跑：有命中', () => {
  it('显示命中行与偏差', async () => {
    mockFetch(HIT_RUN);
    const user = userEvent.setup();
    const dialog = await openEditor(user);
    await fillAndRun(user, dialog, '4');

    // 数据表预览里也有「经典雪山五日」，所以用命中卡独有的偏差行定位
    expect(await within(dialog).findByText(/偏差 天 0\.00/)).toBeTruthy();
    expect(within(dialog).getAllByText('经典雪山五日').length).toBeGreaterThanOrEqual(2);
  });

  it('模板预览用第一条命中真的渲染出来', async () => {
    mockFetch(HIT_RUN);
    const user = userEvent.setup();
    const dialog = await openEditor(user);
    await fillAndRun(user, dialog, '4');

    // 模板是「为你找到 {{计划内容}}，共 {{预算}} 元」—— 这一行只可能来自渲染结果
    expect(await within(dialog).findByText('为你找到 经典雪山五日，共 3000 元')).toBeTruthy();
  });

  it('有命中时不显示空结果解释（两件事不能同时出现）', async () => {
    mockFetch(HIT_RUN);
    const user = userEvent.setup();
    const dialog = await openEditor(user);
    await fillAndRun(user, dialog, '4');

    await within(dialog).findByText(/偏差 天 0\.00/);
    // 不能匹配「放宽」二字 —— 下拉选项里就有「反问用户能否放宽条件」，
    // 用空结果提示的独有句式：「可以放宽预算或…再试」
    expect(within(dialog).queryByText(/可以放宽预算/)).toBeNull();
  });
});

describe('模板占位符校验', () => {
  it('模板引用了表里没有的列时给出警告', async () => {
    // 把模板改成引用一个不存在的列
    mockFetch(HIT_RUN);
    const user = userEvent.setup();
    const dialog = await openEditor(user);

    const textarea = within(dialog).getByDisplayValue(/为你找到/) as HTMLTextAreaElement;
    // 用 fireEvent 直接改值：user.type 会把 `{{` 当键盘语法解析，最终输入成 `{单价}}`
    fireEvent.change(textarea, { target: { value: '价格 {{单价}} 元' } });
    expect(textarea.value).toBe('价格 {{单价}} 元');

    // 提示文案被「键名」打断成多段；函数 matcher 会同时命中祖先节点，
    // 所以用 getAllByText 判断「至少出现一次」，再单独断言键名
    await waitFor(() => {
      const matches = within(dialog).getAllByText((_, node) =>
        Boolean(node?.textContent?.includes('表里没有对应列')),
      );
      expect(matches.length).toBeGreaterThan(0);
    });
    expect(within(dialog).getAllByText(/单价/).length).toBeGreaterThan(0);
  });
});