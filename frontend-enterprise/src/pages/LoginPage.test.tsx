// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENTERPRISE_AUTH_STORAGE_KEY,
  ENTERPRISE_REMEMBERED_USERNAME_STORAGE_KEY,
  ENTERPRISE_REMEMBER_LOGIN_STORAGE_KEY,
  type EnterpriseAuthSession,
} from '../auth';
import { I18nProvider } from '../i18n';

import LoginPage from './LoginPage';

// jsdom 不实现 matchMedia，而登录页/卡片堆/光路动效要靠它判断
// prefers-reduced-motion 与精细指针。补一个最小实现，保持测试环境与浏览器一致。
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

const session: EnterpriseAuthSession = {
  token: 'token-1',
  user: {
    id: 'user-1',
    tenant_id: 'tenant_demo',
    username: 'admin',
    role: 'admin',
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    text: async () => JSON.stringify(body),
  } as Response;
}

function renderLogin(onLogin = vi.fn()) {
  render(
    <MemoryRouter>
      <I18nProvider>
        <LoginPage onLogin={onLogin} />
      </I18nProvider>
    </MemoryRouter>,
  );
  return onLogin;
}

async function enterCredentials(
  user: ReturnType<typeof userEvent.setup>,
  username = 'admin',
  password = 'secret',
) {
  await user.type(screen.getByLabelText('账号'), username);
  await user.type(screen.getByLabelText('密码'), password);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('LoginPage', () => {
  it('shows the credentials card directly on the landing hero', () => {
    renderLogin();

    // 登录框改为常驻的浮层卡片堆：表单直接可见，不再有「先点登录再展开」两步
    expect(screen.getByLabelText('账号')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  });

  it('renders the hero title as one heading holding the brand and product lines', () => {
    renderLogin();

    const heading = screen.getByRole('heading', { level: 1 });
    // 两行拆成 span 后，空白文本节点在 flex 列布局里不参与渲染，但仍应留在
    // 无障碍名称里，避免读屏把「品牌名 + 产品名」连读成一个词。
    expect(heading.textContent).toBe('AIStaff AI 数字员工平台');
    expect(heading.childElementCount).toBe(2);
  });

  it('introduces the product with a scene collage and the SOP light path', () => {
    renderLogin();

    // 左栏的拼贴承担「谁在岗 / 任务怎么跑 / 交付了多少」三件事，
    // 替代了原来一次只能露一条的在岗播报。
    expect(screen.getByText('把一次交代，变成一套可复用的流程')).toBeTruthy();
    expect(screen.getByText('4 位')).toBeTruthy();
    expect(screen.getByText('已交付 3 条方案')).toBeTruthy();
    expect(screen.getByText('本周已交付')).toBeTruthy();
    // 拼贴里的竖卡 —— 换成 SOP 执行卡后，讲的是「一个任务跑到第几步」。
    // 标题、进行中状态、四步清单、底部进度文案要能一起读出来。
    expect(screen.getByText('供应商比价与审批材料')).toBeTruthy();
    expect(screen.getByText('执行中')).toBeTruthy();
    for (const step of ['澄清采购需求', '汇总供应商清单', '供应商比价分析', '生成审批材料']) {
      expect(screen.getByText(new RegExp(step))).toBeTruthy();
    }
    expect(screen.getByText('SOP · 采购流程 v2 · 进行到 3 / 4 步')).toBeTruthy();

    // 四个能力标签现在由底部「SOP 光路流水线」的节点承载。
    // 宽屏光路与窄屏时间轴是两套布局（靠 CSS 断点互斥显示），
    // 在 jsdom 里不会被隐藏，所以每项都会命中两次 —— 断言「至少一处」即可。
    for (const label of ['流程 SOP', '知识检索', '自主执行', '长期记忆']) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('labels the account field as the OA account and offers no SSO entry', () => {
    renderLogin();

    // 员工用的是企业 OA 账号登录，占位文案要说清这一点。
    expect((screen.getByLabelText('账号') as HTMLInputElement).placeholder).toBe('请输入 OA 账号');
    // SSO 入口已移除：本平台只有账号密码一种登录方式。
    expect(screen.queryByText(/SSO/)).toBeNull();
    expect(screen.queryByText('使用 SSO 登录')).toBeNull();
  });

  it('toggles the password between hidden and visible text', async () => {
    const user = userEvent.setup();
    renderLogin();
    const password = screen.getByLabelText('密码');

    expect(password.getAttribute('type')).toBe('password');
    await user.click(screen.getByRole('button', { name: '显示密码' }));
    expect(password.getAttribute('type')).toBe('text');
    await user.click(screen.getByRole('button', { name: '隐藏密码' }));
    expect(password.getAttribute('type')).toBe('password');
  });

  it('posts trimmed credentials with the configured tenant', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => jsonResponse(session));
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();

    await enterCredentials(user, '  admin  ', '  secret  ');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        tenant_id: 'tenant_demo',
        username: 'admin',
        password: 'secret',
        // 「记住账号」默认不勾选 → 维持现状（14 天窗口，服务端缺省值）
        remember: false,
      }),
    }));
  });

  it('asks the backend for the 30-day window when 记住账号 is checked', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(session),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();

    await user.click(screen.getByRole('checkbox', { name: '记住账号' }));
    await enterCredentials(user, 'chenjl5', 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      tenant_id: 'tenant_demo',
      username: 'chenjl5',
      password: 'secret',
      remember: true,
    });
    // 勾选态与账号一起记住：下次进登录页预填、并保持勾选
    expect(window.localStorage.getItem(ENTERPRISE_REMEMBER_LOGIN_STORAGE_KEY)).toBe('1');
    expect(window.localStorage.getItem(ENTERPRISE_REMEMBERED_USERNAME_STORAGE_KEY)).toBe('chenjl5');
  });

  it('does not store the account when 记住账号 stays unchecked', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(session)));
    renderLogin();

    await enterCredentials(user);
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY)).toBeTruthy());
    expect(window.localStorage.getItem(ENTERPRISE_REMEMBER_LOGIN_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(ENTERPRISE_REMEMBERED_USERNAME_STORAGE_KEY)).toBeNull();
  });

  it('prefills the remembered account and keeps the checkbox checked', () => {
    window.localStorage.setItem(ENTERPRISE_REMEMBERED_USERNAME_STORAGE_KEY, 'chenjl5');
    window.localStorage.setItem(ENTERPRISE_REMEMBER_LOGIN_STORAGE_KEY, '1');
    renderLogin();

    expect((screen.getByLabelText('账号') as HTMLInputElement).value).toBe('chenjl5');
    expect((screen.getByRole('checkbox', { name: '记住账号' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('30 天内免登录')).toBeTruthy();
  });

  it('stores the session and notifies the caller after a successful login', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(session)));
    const onLogin = renderLogin();

    await enterCredentials(user);
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(session));
    expect(JSON.parse(window.localStorage.getItem(ENTERPRISE_AUTH_STORAGE_KEY) || 'null'))
      .toEqual(session);
  });

  it('surfaces validation errors without calling the API when fields are empty', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();

    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(screen.getByText('请输入 OA 账号')).toBeTruthy();
    expect(screen.getByText('请输入密码')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
