// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client';
import { I18nProvider } from '@/i18n';
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
  // 下面有「拿不到会话上下文时不该渲染下载按钮」这类负向断言，
  // 前一个 it 的 DOM 必须清干净，否则会把上一条的按钮查出来。
  afterEach(cleanup);

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

  it('makes file chips downloadable with the session context', async () => {
    // 线上症状：人工回复带了附件，用户只看到一个点不动的文件胶囊。
    const item: ChatMessage = {
      id: 'message-human-attachment',
      role: 'user',
      content: '参考文档',
      metadata: { human_reply: true, handoff_id: 'h1' },
      created_at: '2026-11-18T01:01:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-human-attachment',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: '参考文档',
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [
        {
          id: 'att-docx',
          filename: '未命名文档.docx',
          content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 115_712,
          kind: 'binary',
          sha256: 'a'.repeat(64),
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
      activeConversationId: 'session-human',
    } as unknown as UseChatSession;

    const blobSpy = vi.spyOn(api, 'blob').mockResolvedValue(new Blob(['x']));
    // jsdom 没实现 createObjectURL，点下载会抛；挡掉即可验证请求与清理逻辑。
    const createUrl = vi.fn(() => 'blob:mock');
    const revokeUrl = vi.fn();
    Object.defineProperty(window.URL, 'createObjectURL', { value: createUrl, configurable: true });
    Object.defineProperty(window.URL, 'revokeObjectURL', { value: revokeUrl, configurable: true });

    render(<MessageBubble chat={chat} item={item} render={messageRender} />);

    const chip = screen.getByRole('button', { name: '下载附件 未命名文档.docx' });
    fireEvent.click(chip);
    await waitFor(() => expect(blobSpy).toHaveBeenCalledTimes(1));

    // 走会话附件接口，且带上 attachment_id 与 tenant
    expect(blobSpy).toHaveBeenCalledWith(
      '/api/chat/sessions/session-human/attachments/att-docx?tenant_id=tenant_demo',
    );
    await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith('blob:mock'));
    blobSpy.mockRestore();
  });

  it('keeps the chip unclickable when no session context is available', () => {
    // 分享页 / 旧调用方拿不到 session 时不能装作可点，否则点了没反应更糟。
    const item: ChatMessage = {
      id: 'message-no-session',
      role: 'user',
      content: '附件',
      created_at: '2026-11-18T01:01:00Z',
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-no-session',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: '附件',
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [
        {
          id: 'att-orphan',
          filename: '孤立附件.pdf',
          content_type: 'application/pdf',
          size: 2048,
          kind: 'pdf',
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
    } as unknown as UseChatSession;

    render(<MessageBubble chat={chat} item={item} render={messageRender} />);

    expect(screen.getByText('孤立附件.pdf')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /下载附件/ })).toBeNull();
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
  function renderHumanReply(content: string, attachments: MessageRender['attachments'] = []) {
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
      attachments,
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

  it('renders attachments on a human reply that only sent files', () => {
    // 人工回复允许只发图片/附件不写字：content 为空，附件就是这条消息的全部内容。
    // 之前 isHumanReply 是 early-return 分支，附件渲染块在它之后，纯附件回复会渲成空气泡。
    const { container } = renderHumanReply('', [
      {
        id: 'att-human-image',
        filename: '账单截图.png',
        content_type: 'image/png',
        size: 2048,
        kind: 'image',
        data_url: 'data:image/png;base64,AAA',
      },
      {
        id: 'att-human-file',
        filename: '对账单.pdf',
        content_type: 'application/pdf',
        size: 512_000,
        kind: 'pdf',
      },
    ]);

    expect(screen.getByRole('button', { name: '查看附件图片 账单截图.png' })).toBeTruthy();
    expect(screen.getByText('对账单.pdf')).toBeTruthy();
    // 「人工回复」标签仍在，说明走的还是人工那一支，不是被降级成普通用户气泡。
    expect(container.querySelector('[class*="text-[#b45309]"]')?.textContent).toContain('人工回复');
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

describe('MessageBubble greeting message', () => {
  afterEach(cleanup);

  function renderGreeting(metadata: ChatMessage['metadata']) {
    const content = '你好，王小名。\n我可以帮你查制度、整理会议纪要。';
    const item: ChatMessage = {
      id: 'msg_greeting',
      role: 'assistant',
      content,
      created_at: '2026-11-18T01:00:00Z',
      metadata,
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-greeting',
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
      toggleTrace: vi.fn(),
      rateMessage: vi.fn(),
      setActiveCitation: vi.fn(),
      confirmScheduledTask: vi.fn(),
      dismissScheduledTaskDraft: vi.fn(),
      removeQueuedTurn: vi.fn(),
      tenantId: 'tenant_demo',
      activeConversationId: 'session-1',
    } as unknown as UseChatSession;
    const { container } = render(<MessageBubble chat={chat} item={item} render={messageRender} />);
    return container;
  }

  it('renders the greeting body without like/dislike buttons', () => {
    // 开场白是员工主动说的问候，不是对提问的回答；给它挂点评等于在问
    // 「这句寒暄答得好不好」，只会污染反馈数据。
    const container = renderGreeting({ greeting: true });
    expect(screen.getByText(/你好，王小名。/)).toBeTruthy();
    expect(container.querySelector('button[aria-label="点赞"]')).toBeNull();
    expect(container.querySelector('button[aria-label="点踩"]')).toBeNull();
  });

  it('still rates a normal assistant reply', () => {
    // 对照组：同样结构但不带 greeting 标记的消息，点评按钮必须还在。
    const container = renderGreeting(undefined);
    expect(container.querySelector('button[aria-label="点赞"]')).toBeTruthy();
  });
});

/**
 * 场景表单提交必须带 `forcedSceneId`（回归：tool_submit 走通用问答）。
 *
 * ## 这个 bug 的表现与根因
 *
 * 表现：在「客房送物」场景里填完表单点提交 → 走了通用问答流程，模型自由发挥
 * 回一句「已记录，会尽快安排送达」，既不调接口也没有回执卡；而「行程规划」
 * 场景同样的表单点提交是正常的。
 *
 * 根因：**同一个表单有两条提交路径，只有一条带了 `forcedSceneId`**。
 *
 * | 场景类型 | 表单从哪个块出 | 渲染入口 | 提交时带 forced_scene_id |
 * |---|---|---|---|
 * | 行程规划 | `result` 块里的 `slot_form` | `onSubmitSlots` | 带了 |
 * | 客房送物 | `form` 块 | `renderFormForScene` | **没带** |
 *
 * 提交文本是「房间号：8302；需要送的物品：矿泉水」——不含任何触发关键词。
 * 不带 `forced_scene_id`，后端 `resolve_scene_hit` 按关键词匹配必然命中不到，
 * 于是落回通用问答。**而且不报错**，用户只会觉得这张表白填了。
 *
 * 两条路径都要断言：只测一条的话，另一条再漏也不会被发现。
 */
describe('MessageBubble · 场景表单提交带 forcedSceneId', () => {
  /**
   * 必须是 `build_slot_form()` 的**完整**输出形状 —— 尤其 `kind`。
   *
   * `parseA2UIForm()` 第一行就收窄 `form.kind !== 'slot_form' → null`，缺了它
   * 整张表直接不渲染（不是报错，是静默消失）。手写 fixture 最常漏这个键，
   * 而漏了之后的症状是「测试里找不到输入框」，很容易被误判成渲染链断了。
   */
  const sceneForm = {
    kind: 'slot_form',
    title: '请填写下面的信息',
    submit_label: '提交',
    fields: [
      { name: 'room_no', label: '房间号', type: 'text' as const, required: true },
      { name: 'item', label: '物品', type: 'text' as const, required: true },
    ],
  };

  function renderSceneMessage(blocks: unknown[], metadata: Record<string, unknown>) {
    const item: ChatMessage = {
      id: 'message-scene',
      role: 'assistant',
      content: '填写下面的信息，我马上帮你提交：',
      created_at: '2026-11-26T00:00:00Z',
      metadata,
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-scene',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: '填写下面的信息，我马上帮你提交：',
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
      blocks: blocks as MessageRender['blocks'],
    };
    const submitSlotForm = vi.fn();
    const chat = {
      toggleTrace: vi.fn(),
      rateMessage: vi.fn(),
      setActiveCitation: vi.fn(),
      confirmScheduledTask: vi.fn(),
      dismissScheduledTaskDraft: vi.fn(),
      removeQueuedTurn: vi.fn(),
      tenantId: 'tenant_demo',
      activeConversationId: 'session-1',
      submitSlotForm,
      sendQuickText: vi.fn(),
    } as unknown as UseChatSession;
    /**
     * 必须包 `I18nProvider`：`SlotFormCard` 里的输入控件来自 `ui/*`，
     * `Input` 会翻译 placeholder —— 没有 Provider 会抛
     * `useI18n must be used inside I18nProvider`，而 React 的报错会让整棵子树
     * 渲染成空，症状是「找不到输入框」而不是「i18n 缺失」。这个坑很绕，
     * 所以 `SlotFormCard.test.tsx` 里也是同样的包法。
     */
    render(
      <I18nProvider>
        <MessageBubble chat={chat} item={item} render={messageRender} />
      </I18nProvider>,
    );
    return { submitSlotForm };
  }

  /**
   * `findBy*` 而不是 `getBy*`：带 `module_key` 的块走注册表那条路，而
   * `sceneModuleView()` 返回的是 `lazy()` 组件、`SceneModuleSurface` 还要在
   * `useEffect` 里 `loadSceneModule()` —— 首帧渲染的是 `null`。同步查询必然
   * 查不到（这个时序不是 bug，是 chunk 懒加载的正常代价）。
   *
   * 顺带说一句：`slot_form` 块（不带 module_key 的那种）走的是 builtin 段，
   * 同步就能查到，但两条路共用这个 helper，统一用 `findBy` 更稳。
   */
  async function fillAndSubmit() {
    fireEvent.change(await screen.findByLabelText(/房间号/), { target: { value: '8302' } });
    fireEvent.change(await screen.findByLabelText(/物品/), { target: { value: '矿泉水' } });
    fireEvent.click(await screen.findByRole('button', { name: /提交/ }));
  }

  it('form 块（tool_submit 走这条）提交时带上 scene_id', async () => {
    const { submitSlotForm } = renderSceneMessage(
      [{ kind: 'form', module_key: 'generic.tool_submit', data: { form: sceneForm } }],
      // 后端 `turn_run` 把本轮的场景 id 写在消息 metadata 顶层
      { scene_id: 'scene_room_delivery' },
    );

    await fillAndSubmit();

    await waitFor(() => expect(submitSlotForm).toHaveBeenCalled());
    const call = submitSlotForm.mock.calls[0];
    // 第三个参数就是 forcedSceneId。缺了它 → 后端落回通用问答。
    expect(call[2]).toBe('scene_room_delivery');
    expect(call[1]).toEqual({ room_no: '8302', item: '矿泉水' });
  });

  it('slot_form 块（table_match 走这条）提交时也带上 scene_id', async () => {
    // 这条本来就是对的，一起断言：两条路径都漏过才叫「两处不一样」，
    // 只保一条会在下一次改动里重新漂开。
    const { submitSlotForm } = renderSceneMessage(
      [{ kind: 'slot_form', data: { form: sceneForm } }],
      { scene_id: 'scene_itinerary' },
    );

    await fillAndSubmit();

    await waitFor(() => expect(submitSlotForm).toHaveBeenCalled());
    expect(submitSlotForm.mock.calls[0][2]).toBe('scene_itinerary');
  });

  it('消息上没有 scene_id 时不强行塞空串', async () => {
    // 非场景消息（普通问答里的表单）本来就没有场景可指定。传空串会让后端
    // 收到 `forced_scene_id=""`，虽然 resolve 会当空处理，但语义上是「指定了
    // 一个不存在的场景」，日志里会出现误导性的 forced_outside_binding。
    const { submitSlotForm } = renderSceneMessage(
      [{ kind: 'form', module_key: 'generic.tool_submit', data: { form: sceneForm } }],
      {},
    );

    await fillAndSubmit();

    await waitFor(() => expect(submitSlotForm).toHaveBeenCalled());
    expect(submitSlotForm.mock.calls[0][2]).toBe('');
  });
});

/**
 * 「回复的样式和 demo 不一致，是纯文字的了。」
 *
 * 这是上一个 bug 的**下游后果**，但值得单独锁一条：用户看到纯文字时，第一反应
 * 会怀疑「卡片组件坏了」，实际是那一轮压根没进场景，`ui_blocks` 里根本没有
 * `result` 块 —— 模型拿着表单那行字自由发挥，输出一句普通 Markdown。
 *
 * 所以这条用例的断言分两层：
 * 1. `result` 块**经过 MessageBubble 的分段/挂载逻辑之后**仍然是卡片
 *    （模块层的卡片测试已经有了，但那是直接喂 `SceneBlockList`，绕过了
 *    挂载位分段 —— 分段才是「块消失」最容易发生的地方）；
 * 2. 同时给出 `text` 块，保证「卡片 + 一句话」能共存，且卡片不会因为正文
 *    存在而被吞掉。
 */
describe('MessageBubble · 场景回执渲染成卡片而不是纯文字', () => {
  it('result 块经挂载位分段后仍渲染为回执卡（含单号与中文标签）', async () => {
    const item: ChatMessage = {
      id: 'message-receipt',
      role: 'assistant',
      content: '已为 8306 房提交矿泉水，受理单号 RD20261126BB6，预计 20 分钟内送达。',
      created_at: '2026-11-26T00:00:00Z',
      metadata: { scene_id: 'scene_room_delivery' },
    };
    const messageRender: MessageRender = {
      traceTurnId: 'turn-receipt',
      summary: null,
      details: [],
      expanded: false,
      showInlineTrace: false,
      visibleContent: '已为 8306 房提交矿泉水，受理单号 RD20261126BB6，预计 20 分钟内送达。',
      citations: [],
      scheduledDraft: null,
      scheduledTaskPrompt: false,
      attachments: [],
      harnessArtifacts: [],
      statusOnly: false,
      blocks: [
        { kind: 'text', data: { content: '已经帮你提交了：' } },
        {
          kind: 'result',
          module_key: 'generic.tool_submit',
          module_version: 1,
          fallback_text: '已为 8306 房提交矿泉水，受理单号 RD20261126BB6。',
          data: {
            total: 1,
            max_items: 1,
            labels: { room_no: '房间号', item: '物品' },
            items: [
              {
                row_id: 'receipt',
                source_table: '',
                values: { order_no: 'RD20261126BB6', room_no: '8306', item: '矿泉水' },
              },
            ],
          },
        },
      ],
    } as MessageRender;

    const chat = {
      toggleTrace: vi.fn(),
      rateMessage: vi.fn(),
      setActiveCitation: vi.fn(),
      confirmScheduledTask: vi.fn(),
      dismissScheduledTaskDraft: vi.fn(),
      removeQueuedTurn: vi.fn(),
      tenantId: 'tenant_demo',
      activeConversationId: 'session-1',
      submitSlotForm: vi.fn(),
      sendQuickText: vi.fn(),
    } as unknown as UseChatSession;

    render(
      <I18nProvider>
        <MessageBubble chat={chat} item={item} render={messageRender} />
      </I18nProvider>,
    );

    // ① 卡片真的画出来了（`data-scene-module` 是 module 自己打的标记，
    //    有它就说明走的是 module 渲染器而不是 `fallback_text` 纯文本）。
    await waitFor(() => {
      expect(document.querySelector('[data-scene-module="generic.tool_submit"]')).toBeTruthy();
    });
    // ② 单号与中文标签都在（纯文字降级时这些都不会出现）
    expect(await screen.findByText('RD20261126BB6')).toBeTruthy();
    expect(screen.getByText(/房间号/)).toBeTruthy();
    // ③ 卡片上方那句话也还在 —— 共存，不是二选一
    expect(screen.getByText('已经帮你提交了：')).toBeTruthy();
  });
});
