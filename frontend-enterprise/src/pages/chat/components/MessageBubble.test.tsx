// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    // 用户消息现在包在右对齐列里（署名行 + 气泡上下排布），不再是 display:contents。
    // 链路：正文 span → plain-answer → 气泡 → 右对齐列。
    const column = message.parentElement?.parentElement?.parentElement;
    expect(column?.className).toContain('items-end');
  });

  it('signs user turns with a name + initial avatar above the bubble', () => {
    const { container } = renderSlashMessage('确认', []);

    // mock 的 chat 没有 authUser，署名回落为「你」；头像取显示名首字符。
    const avatar = container.querySelector('[class*="194,80,80"]');
    expect(avatar?.textContent).toBe('你');
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

describe('MessageBubble reply card', () => {
  function renderAssistant(content: string, statusOnly = false) {
    const item: ChatMessage = {
      id: 'message-card',
      role: 'assistant',
      content,
      created_at: '2026-11-16T10:24:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-card',
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
      statusOnly,
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
      activeConversationId: 'session-card',
    } as unknown as UseChatSession;
    return render(<MessageBubble chat={chat} item={item} render={messageRender} />);
  }

  it('leaves answers as plain text — replies are not boxed (2026-11-17 定稿)', () => {
    const { container } = renderAssistant('复盘已生成，附件里是完整版。');
    // 助手正文不再套圆角卡；白框只留给特殊事件（执行记录 / 转接通知 / 报错）。
    expect(container.querySelector('[class*="rounded-[16px]"]')).toBeNull();
    expect(container.querySelector('[class*="ring-[0.5px]"]')).toBeNull();
    expect(container.textContent).toContain('复盘已生成');
  });

  it('leaves one-line status notices bare instead of boxing them', () => {
    const { container } = renderAssistant('已转交给 数据分析组', true);
    const bubble = container.querySelector('[class*="rounded-[16px]"]');
    expect(bubble).toBeNull();
    expect(container.textContent).toContain('已转交给');
  });

  it('keeps errors in a red-tinted box — errors are special events', () => {
    const item: ChatMessage = {
      id: 'message-error',
      role: 'assistant',
      content: '调用工具失败，请稍后重试。',
      isError: true,
      created_at: '2026-11-17T00:00:00Z',
    } as ChatMessage;
    const messageRender: MessageRender = {
      traceTurnId: 'turn-error',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: '调用工具失败，请稍后重试。',
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
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
      activeConversationId: 'session-error',
    } as unknown as UseChatSession;
    const { container } = render(<MessageBubble chat={chat} item={item} render={messageRender} />);
    const errorBox = container.querySelector('[class*="rounded-[12px]"]');
    // 报错色（CHAT_BUBBLE_ERROR_CLASS）经 tailwind-merge 覆盖卡底色，红调最终生效。
    expect(errorBox?.className).toContain('bg-[#fce7e7]');
    expect(errorBox?.className).toContain('rounded-[12px]');
    expect(container.textContent).toContain('调用工具失败');
  });
});

describe('MessageBubble human handoff reply', () => {
  function renderHumanReply(content: string) {
    const item: ChatMessage = {
      id: 'message-human',
      role: 'user',
      content,
      metadata: { human_reply: true },
      created_at: '2026-11-17T05:49:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-human',
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
      slashCommands: [],
      toggleTrace: vi.fn(),
      rateMessage: vi.fn(),
      setActiveCitation: vi.fn(),
      confirmScheduledTask: vi.fn(),
      dismissScheduledTaskDraft: vi.fn(),
      removeQueuedTurn: vi.fn(),
      tenantId: 'tenant_demo',
      activeConversationId: 'session-human',
      displayedAgent: { id: 'agent-1', name: 'Jerry Hu', kind: 'standard' },
    } as unknown as UseChatSession;
    return render(<MessageBubble chat={chat} item={item} render={messageRender} />);
  }

  it('renders a handoff reply on the employee side with the human-reply tag', () => {
    const { container } = renderHumanReply('好的，我去找你');
    // 琥珀色「人工回复」标签醒目存在。
    const tag = container.querySelector('[class*="text-[#b45309]"]');
    expect(tag?.textContent).toContain('人工回复');
    // 站员工左侧（justify-start），不走用户右对齐的灰气泡。
    expect(container.firstElementChild?.innerHTML).toContain('justify-start');
    expect(container.querySelector('[class*="bg-[#e5e4e0]"]')).toBeNull();
    expect(container.textContent).toContain('好的，我去找你');
  });

  it('keeps a normal user message on the right without the tag', () => {
    const { container } = renderSlashMessage('转人工', []);
    expect(container.querySelector('[class*="text-[#b45309]"]')).toBeNull();
    expect(container.querySelector('[class*="bg-[#e5e4e0]"]')).toBeTruthy();
  });
});

describe('MessageBubble suggested actions', () => {
  // 这套用例靠「点不到按钮」做负向断言，前一个 it 的 DOM 必须清干净。
  afterEach(cleanup);

  function renderAssistant(metadata: ChatMessage['metadata']) {
    const content = '我这边暂时没有查到报销流程的相关资料。如果你需要，我也可以帮你转接人工同事跟进这个问题。';
    const item: ChatMessage = {
      id: 'message-action',
      role: 'assistant',
      content,
      created_at: '2026-09-01T00:00:00Z',
      metadata,
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-action',
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
    const sendQuickText = vi.fn();
    const chat = {
      sendQuickText,
      toggleTrace: vi.fn(),
      rateMessage: vi.fn(),
      setActiveCitation: vi.fn(),
      confirmScheduledTask: vi.fn(),
      dismissScheduledTaskDraft: vi.fn(),
      removeQueuedTurn: vi.fn(),
      tenantId: 'tenant_demo',
      activeConversationId: 'session-1',
    } as unknown as UseChatSession;
    render(<MessageBubble chat={chat} item={item} render={messageRender} />);
    return sendQuickText;
  }

  it('renders a handoff action chip and sends its text on click', () => {
    const sendQuickText = renderAssistant({
      suggested_actions: [{ type: 'handoff', label: '转人工', text: '转人工' }],
    });

    const chip = screen.getByRole('button', { name: '转人工' });
    fireEvent.click(chip);
    expect(sendQuickText).toHaveBeenCalledWith('转人工');
  });

  it('renders no chip for plain answers', () => {
    renderAssistant(undefined);
    expect(screen.queryByRole('button', { name: '转人工' })).toBeNull();
  });

  it('ignores malformed action payloads', () => {
    renderAssistant({ suggested_actions: [{ type: 'handoff' }] as never });
    expect(screen.queryByRole('button', { name: '转人工' })).toBeNull();
  });
});
