// @vitest-environment jsdom

// 页面级验证「微信接入」页：真实渲染整页，断言
//   1) 身份绑定只剩扫码一个入口，页面上没有额外的认领入口；
//   2) 有的绑定行渲染出员工与模型规则徽标；
//   3) 「微信里的指令」清单只列仍然生效的指令。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

function stubFetch(rows: unknown = bindings) {
  // 第二个参数必须显式声明：默认实现只接 input，解构 init 时 TS 会报「元组越界」
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/enterprise/wechat/bindings')) return jsonResponse(rows);
    if (url.includes('/api/enterprise/agents')) return jsonResponse(agents);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function buttonTexts(): string[] {
  return Array.from(document.querySelectorAll('button')).map((el) => el.textContent ?? '');
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
      // 转人工必须是斜杠指令：裸词「转人工」现在交回 LLM 正常作答
      '/转人工',
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

  // ---- 一个账号只能接一个微信 -------------------------------------------

  it('已有生效中的接入时，扫码接入被置灰', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => expect(screen.getByText(LOADED)).toBeTruthy());

    const scan = screen.getByText('扫码接入').closest('button') as HTMLButtonElement;
    expect(scan.disabled).toBe(true);
    // 规则要在点击之前就看得见，不能只靠灰按钮暗示
    expect(screen.getByText('一个账号只能接入一个微信。要换绑请先断开当前接入。')).toBeTruthy();
  });

  it('没有接入时扫码可用', async () => {
    stubFetch([]);
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText('还没有接入微信。扫码后就能在微信里和你的数字员工对话。'),
      ).toBeTruthy(),
    );

    const scan = screen.getByText('扫码接入').closest('button') as HTMLButtonElement;
    expect(scan.disabled).toBe(false);
  });

  it('断开的记录不再占用扫码入口', async () => {
    stubFetch([{ ...bindings[0], status: 'disconnected' }]);
    renderPage();

    await waitFor(() => expect(screen.getByText(LOADED)).toBeTruthy());

    const scan = screen.getByText('扫码接入').closest('button') as HTMLButtonElement;
    expect(scan.disabled).toBe(false);
  });

  // ---- 断开 / 删除的动作归属 -------------------------------------------

  it('生效中的行只给「断开」，不给「删除」', async () => {
    stubFetch();
    renderPage();

    await waitFor(() => expect(screen.getByText(LOADED)).toBeTruthy());

    const texts = buttonTexts();
    expect(texts).toContain('断开');
    expect(texts).not.toContain('删除');
  });

  it('断开的行给「删除」，不给「断开」', async () => {
    stubFetch([{ ...bindings[0], status: 'disconnected' }]);
    renderPage();

    await waitFor(() => expect(screen.getByText(LOADED)).toBeTruthy());

    const texts = buttonTexts();
    expect(texts).toContain('删除');
    expect(texts).not.toContain('断开');
  });

  it('别人的绑定（owned_by_me=false）不给断开/删除按钮', async () => {
    stubFetch([{ ...bindings[0], owned_by_me: false }]);
    renderPage();

    await waitFor(() => expect(screen.getByText(LOADED)).toBeTruthy());

    const texts = buttonTexts();
    expect(texts).not.toContain('断开');
    expect(texts).not.toContain('删除');
    // 别人的行是只读的，连配置也不给（改的是别人微信能跟谁对话）
    expect(texts).not.toContain('配置员工');
  });

  // ---- 别人的绑定不能混进「我的微信」（2026-11-20 用户反馈）----------------

  it('别人的绑定归到「其他人的微信」，不混在我的列表里', async () => {
    stubFetch([
      { ...bindings[0], id: 'wxbind_mine', owned_by_me: true, owner_name: 'me' },
      {
        ...bindings[0],
        id: 'wxbind_other',
        owned_by_me: false,
        owner_name: 'Jenny Hu 胡晓飞',
      },
    ]);
    renderPage();

    // 两行都在 → 「可对话员工：」会出现两次，不能用它当信号
    await waitFor(() => expect(screen.getByText('其他人的微信')).toBeTruthy());

    // 有独立的「其他人的微信」分区，并标出归属人
    expect(screen.getByText('Jenny Hu 胡晓飞')).toBeTruthy();
    expect(screen.getByText('仅管理员可见，用于排障；不能替成员操作')).toBeTruthy();
    // 我的行不留归属人标签（只有别人的行需要标注）
    expect(screen.queryByText('me')).toBeNull();
  });

  it('只有别人的绑定在跑时，我仍然可以扫码接入', async () => {
    // 关键回归：旧实现无条件 find(status==='active')，别人接了微信
    // 会把「扫码接入」灰掉——页面写着「我的微信」却因别人不能操作。
    stubFetch([{ ...bindings[0], owned_by_me: false, owner_name: 'Jenny Hu 胡晓飞' }]);
    renderPage();

    await waitFor(() => expect(screen.getByText('其他人的微信')).toBeTruthy());

    const scan = screen.getByText('扫码接入').closest('button') as HTMLButtonElement;
    expect(scan.disabled).toBe(false);
    expect(screen.getByText('还没有接入微信。扫码后就能在微信里和你的数字员工对话。')).toBeTruthy();
  });

  it('自己已接入时扫码置灰，即使还有别人的绑定', async () => {
    stubFetch([
      { ...bindings[0], id: 'wxbind_mine', owned_by_me: true },
      { ...bindings[0], id: 'wxbind_other', owned_by_me: false, owner_name: '别人' },
    ]);
    renderPage();

    await waitFor(() => expect(screen.getByText('其他人的微信')).toBeTruthy());

    const scan = screen.getByText('扫码接入').closest('button') as HTMLButtonElement;
    expect(scan.disabled).toBe(true);
  });

  it('点删除先弹确认，不会直接删', async () => {
    const fetchMock = stubFetch([{ ...bindings[0], status: 'disconnected' }]);
    renderPage();

    await waitFor(() => expect(screen.getByText(LOADED)).toBeTruthy());
    fireEvent.click(screen.getByText('删除'));

    await waitFor(() => expect(screen.getByText('删除这条接入记录？')).toBeTruthy());
    // 确认前不该发请求
    const deletions = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).includes('/api/enterprise/wechat/bindings') &&
        (init as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deletions).toHaveLength(0);
  });
});