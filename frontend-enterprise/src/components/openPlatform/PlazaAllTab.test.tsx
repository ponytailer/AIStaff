// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlazaAllTab from './PlazaAllTab';

// 组件内经 api client 拉热门列表，右侧两个 widget 也各自发请求——全部 mock，不真发网络。
const apiGet = vi.fn();
const apiPost = vi.fn().mockResolvedValue({});
vi.mock('@/api/client', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  TENANT_ID: 'tenant_demo',
}));

const NEWS_PAYLOAD = { date: '2026-10-09', provenance: 'rss', items: { ai: [], travel: [] } };

/**
 * 榜单三类成员各一条：
 * - №1 主推卡：真·数字员工（ref_id = agent_profile id）
 * - 榜单行：目录型 Agent（ref_id = agent-catalog.json 的 key，不在 agent_profiles 里）
 * - 榜单行：非 Agent 资源（知识库）
 */
const HOT_PAYLOAD = {
  generated_at: '2026-10-16T06:00:00Z',
  items: [
    {
      kind: 'agents',
      ref_id: 'agent_46ea3fa5441e4992',
      title: 'AI G.O',
      description: '重庆文旅 Mall 项目答疑',
      metric_label: '被使用',
      metric_value: 42,
      score: 42,
      updated_at: '2026-10-15T02:00:00Z',
    },
    {
      kind: 'agents',
      ref_id: 'oa-assistant',
      title: 'AI 单据助手',
      description: 'OA 报销单代填',
      metric_label: '被使用',
      metric_value: 18,
      score: 18,
      updated_at: null,
    },
    {
      kind: 'knowledge',
      ref_id: 'kb_9fa98ee6b2ce4c39',
      title: 'Hi Sphere 重庆项目百问百搭',
      description: '项目知识库',
      metric_label: '被引用',
      metric_value: 9,
      score: 9,
      updated_at: null,
    },
  ],
};

/** 与 HOT_PAYLOAD 同构，但把 №1 换成 SOP——用来验证下架模块不进榜。 */
const HOT_PAYLOAD_WITH_SOP = {
  generated_at: '2026-10-16T06:00:00Z',
  items: [
    {
      kind: 'skills',
      ref_id: 'skill_报销流程',
      title: '差旅报销 SOP',
      description: '三步走完报销',
      metric_label: '被复制',
      metric_value: 99,
      score: 99,
      updated_at: null,
    },
    ...HOT_PAYLOAD.items,
  ],
};

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/enterprise/platform']}>
      <PlazaAllTab />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  apiPost.mockClear();
  apiGet.mockImplementation((url: unknown) =>
    Promise.resolve(String(url).includes('/plaza-hot') ? HOT_PAYLOAD : NEWS_PAYLOAD),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PlazaAllTab 热门榜点击落点', () => {
  it('№1 主推卡若是数字员工：直进该员工工作台，并切换当前员工作用域', async () => {
    renderTab();
    fireEvent.click(await screen.findByText('AI G.O'));

    // 落点是员工工作台，而不是广场的「数字员工」tab
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/enterprise/dashboard'),
    );
    expect(window.localStorage.getItem('ultrarag_enterprise_agent_scope'))
      .toBe('agent_46ea3fa5441e4992');
    // 顺带把该员工收进「我的数字员工」
    expect(apiPost).toHaveBeenCalledWith(
      '/api/chat/agents/agent_46ea3fa5441e4992/use?tenant_id=tenant_demo',
      {},
    );
  });

  it('排行榜里的目录型 Agent（如 AI 单据助手）进对应工作台路由', async () => {
    renderTab();
    fireEvent.click(await screen.findByText('AI 单据助手'));

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent)
        .toBe('/enterprise/agent-apps/oa-assistant'),
    );
    // 目录型 Agent 不在 agent_profiles 里：不写员工作用域、不调 /use
    expect(window.localStorage.getItem('ultrarag_enterprise_agent_scope')).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('排行榜里的非 Agent 资源仍跳对应广场 tab', async () => {
    renderTab();
    fireEvent.click(await screen.findByText('Hi Sphere 重庆项目百问百搭'));

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/enterprise/platform/knowledge'),
    );
    expect(window.localStorage.getItem('ultrarag_enterprise_agent_scope')).toBeNull();
  });

  it('下架模块（SOP）的条目不进榜，也不会顶替 №1 主推位', async () => {
    apiGet.mockImplementation((url: unknown) =>
      Promise.resolve(String(url).includes('/plaza-hot') ? HOT_PAYLOAD_WITH_SOP : NEWS_PAYLOAD),
    );
    renderTab();

    // 高分 SOP 被剔除后，冠军仍是分数最高的那类可见资源
    expect(await screen.findByText('AI G.O')).toBeTruthy();
    expect(screen.queryByText('差旅报销 SOP')).toBeNull();
  });
});
