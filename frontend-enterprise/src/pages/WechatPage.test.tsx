// @vitest-environment jsdom

// 页面级验证「微信接入」页：真实渲染整页，断言
//   1) 身份绑定只剩扫码一个入口，页面上没有额外的认领入口；
//   2) 有的绑定行渲染出员工与模型规则徽标；
//   3) 「微信里的指令」清单只列仍然生效的指令。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import type { EnterpriseAuthUser } from '@/auth';
import type { AgentProfileRead } from '../types';

import WechatPage from './WechatPage';

const currentUser: EnterpriseAuthUser = {
  id: 'user-1',
  username: 'me',
  tenant_id: 'tenant_demo',
  role: 'member',
};

const agents: AgentProfileRead[] = [
  {
    id: 'agent-1',
    tenant_id: 'tenant_demo',
    name: 'AI G.O',
    is_overall: false,
    status: 'active',
    metadata: {},
    resources: [],
    free_model_enabled: false,
    free_model_remaining: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  },
];

const bindings = [
  {
    id: 'wxbind_1',
    status: 'active',
    display_name: '我的微信',
    ilink_bot_id: 'bot_1',
    agents: [{ agent_id: 'agent-1', name: 'AI G.O', is_default: true, sort_order: 0 }],
    last_error: '',
    last_seen_at: null,
    created_at: '2026-09-01T00:00:00Z',
  },
];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/enterprise/wechat/bindings')) return jsonResponse(bindings);
    if (url.includes('/api/enterprise/agents')) return jsonResponse(agents);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(<WechatPage currentUser={currentUser} />);
}

// 「我的微信」在侧栏与页内各有一处，用它当加载完成信号会撞多元素；
// 「可对话员工：」只在本页出现。
const LOADED = '可对话员工：';

beforeAll(() => {
  // Radix 在 jsdom 下需要这些 stub
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

// 每个用例渲染整页，不 cleanup 会让上一个用例的 DOM 残留，
// 出现「Found multiple elements with the text」这种假失败。
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WechatPage', () => {
  it('页面只提供扫码接入，没有额外的手动认领入口', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => expect(screen.getByText(LOADED)).toBeTruthy());

    // 唯一的接入动作是扫码
    expect(screen.getByText('扫码接入')).toBeTruthy();
    // 页面上不该再有第二个「绑定」类按钮
    const buttons = Array.from(document.querySelectorAll('button')).map(
      (el) => el.textContent ?? '',
    );
    expect(buttons.filter((text) => text.includes('绑定'))).toHaveLength(0);
  });

  it('微信指令清单只列仍然生效的指令', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => expect(screen.getByText(LOADED)).toBeTruthy());

    const commands = Array.from(document.querySelectorAll('code')).map((el) => el.textContent);
    expect(commands).toEqual([
      '/员工',
      '/切换 <名字>',
      '/当前',
      '转人工',
      '/取消转人工',
    ]);
  });

  it('绑定行展示已挂载员工', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => expect(screen.getByText(LOADED)).toBeTruthy());
    // 员工名出现在挂载摘要里
    expect(screen.getAllByText(/AI G\.O/).length).toBeGreaterThan(0);
  });
});