// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import type { ChatSession } from '@/types';

import type { UseChatSession } from '../useChatSession';
import ChatHeader from './ChatHeader';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

function buildChat(session: Partial<ChatSession>): UseChatSession {
  return {
    auth: null,
    currentSession: {
      id: 'session-1',
      tenant_id: 'tenant_demo',
      status: 'active',
      updated_at: '2026-08-01T00:00:00Z',
      ...session,
    } as ChatSession,
    openRename: vi.fn(),
    logout: vi.fn(),
  } as unknown as UseChatSession;
}

function renderHeader(chat: UseChatSession) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <ChatHeader chat={chat} />
      </I18nProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChatHeader session title', () => {
  it('keeps header controls below the native desktop drag region', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));
    const { container } = renderHeader(buildChat({ title: '计划讨论' }));
    const headerClassName = container.firstElementChild?.className || '';

    expect(headerClassName).toContain('h-[88px]');
    expect(headerClassName).toContain('pt-[32px]');
  });

  it('renders no badge for regular employee sessions', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));
    renderHeader(buildChat({ title: '计划讨论' }));

    expect(screen.queryByText(/团队/)).toBeNull();
  });

  /**
   * 右上角那组「分享 / 语言 / 账户」已按用户要求移除：它们悬在右栏卡片正上方，
   * 让右侧看起来是「工具栏 + 一张被压住的卡」。这里锁死，避免后续又悄悄加回来。
   * （账户菜单与语言切换在管理端顶栏仍有入口，分享在广场与员工档案页仍有入口。）
   */
  it('keeps the right side of the header empty', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));
    const { container } = renderHeader(buildChat({ title: '计划讨论' }));

    expect(screen.queryByLabelText('账户菜单')).toBeNull();
    expect(screen.queryByLabelText('分享数字员工')).toBeNull();
    // 页头只剩一个子节点（标题栈）；右侧动作区不再渲染。
    const header = container.firstElementChild as HTMLElement;
    expect(header.children).toHaveLength(1);
  });
});
