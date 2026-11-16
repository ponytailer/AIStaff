// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentProfileRead, ChatMessage, ChatSlashCommand } from '@/types';

import type { UseChatSession } from '../useChatSession';
import MessageBubble, { type MessageRender } from './MessageBubble';

const weatherCommand: ChatSlashCommand = {
  kind: 'skill',
  target: 'weather',
  label: 'weather',
  description: '查询天气',
  command: '/skill weather',
};

function renderSlashMessage(content: string, slashCommands: ChatSlashCommand[] = [weatherCommand]) {
  const item: ChatMessage = {
    id: 'message-1',
    role: 'user',
    content,
    created_at: '2026-08-09T00:00:00Z',
  };
  const messageRender: MessageRender = {
    traceTurnId: 'turn-1',
    summary: null,
    details: [],
    expanded: false,
    showInlineTrace: false,
    visibleContent: content,
    citations: [],
    scheduledDraft: null,
    scheduledTaskPrompt: false,
    attachments: [],
    harnessArtifacts: [],
    statusOnly: false,
  };
  const chat = {
    slashCommands,
    toggleTrace: vi.fn(),
    rateMessage: vi.fn(),
    setActiveCitation: vi.fn(),
    confirmScheduledTask: vi.fn(),
    dismissScheduledTaskDraft: vi.fn(),
    removeQueuedTurn: vi.fn(),
    tenantId: 'tenant_demo',
    activeConversationId: 'session-1',
  } as unknown as UseChatSession;
  return render(<MessageBubble chat={chat} item={item} render={messageRender} />);
}

describe('MessageBubble slash command card', () => {
  it('renders a sent slash command as a card beside its request text', () => {
    renderSlashMessage('/skill weather 北京天气如何');

    expect(screen.getByRole('group', { name: '技能 weather' })).toBeTruthy();
    expect(screen.getByText('北京天气如何')).toBeTruthy();
    expect(screen.queryByText('/skill weather 北京天气如何')).toBeNull();
  });

  it('keeps the card when the referenced resource is no longer listed', () => {
    renderSlashMessage('/skill archived_weather 北京天气如何', []);

    expect(screen.getByRole('group', { name: '技能 archived_weather' })).toBeTruthy();
  });
});

describe('MessageBubble responsive sizing', () => {
  it('keeps a short user message out of a shrink-to-fit wrapper', () => {
    renderSlashMessage('确认', []);

    const message = screen.getByText('确认');
    const bubble = message.parentElement?.parentElement;
    expect(bubble?.parentElement?.classList.contains('contents')).toBe(true);
  });
});

describe('MessageBubble attachments', () => {
  it('keeps images in a thumbnail grid and files in chips', () => {
    const content = '看下这两份附件';
    const item: ChatMessage = {
      id: 'message-attachments',
      role: 'user',
      content,
      created_at: '2026-11-16T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-attachments',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [
        {
          id: 'att-image',
          filename: '看板.png',
          content_type: 'image/png',
          size: 1024,
          kind: 'image',
          data_url: 'data:image/png;base64,AAA',
        },
        {
          id: 'att-file',
          filename: '底稿.xlsx',
          content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 1_284_000,
          kind: 'binary',
        },
      ],
      harnessArtifacts: [],
      statusOnly: false,
    };
    const chat = {
      slashCommands: [],
      toggleTrace: vi.fn(),
      rateMessage: vi.fn(),
      setActiveCitation: vi.fn(),
      confirmScheduledTask: vi.fn(),
      dismissScheduledTaskDraft: vi.fn(),
      removeQueuedTurn: vi.fn(),
      tenantId: 'tenant_demo',
      activeConversationId: 'session-attachments',
    } as unknown as UseChatSession;

    render(<MessageBubble chat={chat} item={item} render={messageRender} />);

    // 图片走缩略图瓷砖：点开是弹窗大图（data: URL 不能新标签打开）
    fireEvent.click(screen.getByRole('button', { name: '查看附件图片 看板.png' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    // 文件走胶囊：文件名 + 类型/体积在同一行
    expect(screen.getByText('底稿.xlsx')).toBeTruthy();
    expect(screen.getByText('文件 · 1.2 MB')).toBeTruthy();
  });
});

describe('MessageBubble legacy team progress', () => {
  it('shows live team progress and hides feedback until synthesis finishes', () => {
    const item: ChatMessage = {
      id: 'message-team-progress',
      role: 'assistant',
      content: '已收到全部 2 项成员回复。',
      metadata: {
        team_run_id: 'team-run-1',
        team_progress: {
          phase: 'synthesizing',
          completed_tasks: 2,
          total_tasks: 2,
          status_text: '正在整理答案',
        },
      },
      created_at: '2026-08-15T00:00:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-team-progress',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: item.content,
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
    };
    const chat = {
      // 历史团队会话兼容：群聊判断改读 currentSession.team_id
      currentSession: { team_id: 'team-1' },
      slashCommands: [],
      toggleTrace: vi.fn(),
      rateMessage: vi.fn(),
      setActiveCitation: vi.fn(),
      confirmScheduledTask: vi.fn(),
      dismissScheduledTaskDraft: vi.fn(),
      removeQueuedTurn: vi.fn(),
      tenantId: 'tenant_demo',
      activeConversationId: 'session-team-1',
    } as unknown as UseChatSession;

    const { container } = render(<MessageBubble chat={chat} item={item} render={messageRender} />);

    expect(screen.getByText('已收到全部 2 项成员回复。')).toBeTruthy();
    expect(screen.getByRole('status', { name: '正在整理答案' })).toBeTruthy();
    expect(container.querySelector('button[aria-label="点赞"]')).toBeNull();
  });
});
