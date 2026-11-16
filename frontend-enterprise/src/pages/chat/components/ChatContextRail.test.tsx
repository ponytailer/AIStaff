// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentProfileRead, ChatMessage, UIConfigRead } from '@/types';

import ChatContextRail from './ChatContextRail';
import type { TraceLine, TurnTrace } from '../chatTypes';
import type { UseChatSession } from '../useChatSession';

const UI_CONFIG = {
  show_thinking_trace: true,
  show_skill_trace: true,
  show_tool_trace: true,
} as unknown as UIConfigRead;

function buildAgent(overrides: Partial<AgentProfileRead> = {}): AgentProfileRead {
  return {
    id: 'agent-1',
    name: 'IT 服务员工',
    resources: [
      { id: 'r1', resource_type: 'skill', resource_id: 's1', status: 'active' },
      { id: 'r2', resource_type: 'general_skill', resource_id: 'g1', status: 'active' },
      { id: 'r3', resource_type: 'general_skill', resource_id: 'g2', status: 'active' },
      { id: 'r4', resource_type: 'knowledge_base', resource_id: 'k1', status: 'active' },
    ],
    ...overrides,
  } as unknown as AgentProfileRead;
}

function buildChat({
  messages = [] as ChatMessage[],
  trace = null as TurnTrace | null,
  webSearchEnabled = true,
  agent = buildAgent() as AgentProfileRead | null,
}: {
  messages?: ChatMessage[];
  trace?: TurnTrace | null;
  webSearchEnabled?: boolean;
  agent?: AgentProfileRead | null;
} = {}): UseChatSession {
  const store = new Map<string, TurnTrace>();
  if (trace && messages[0]) store.set(messages[0].turnId || messages[0].id, trace);
  return {
    displayedAgent: agent,
    displayedProfile: agent ? { roleName: 'IT 服务' } : null,
    displayedAgentIsDispatcher: false,
    displayedMessages: messages,
    turnTraceRef: { current: store },
    uiConfig: UI_CONFIG,
    selectedModelConfig: { name: 'deepseek-v4-flash' },
    webSearchEnabled,
    currentSessionRunning: false,
  } as unknown as UseChatSession;
}

function line(overrides: Partial<TraceLine>): TraceLine {
  return {
    id: 'line-1',
    kind: 'tool',
    text: '调用工具 perm_policy_check',
    state: 'completed',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ChatContextRail', () => {
  it('展示员工、模型与能力数量', () => {
    render(<ChatContextRail chat={buildChat()} />);

    expect(screen.getByLabelText('会话上下文')).toBeTruthy();
    expect(screen.getByText('IT 服务员工')).toBeTruthy();
    expect(screen.getByText('IT 服务 · 本次会话')).toBeTruthy();
    expect(screen.getByText('deepseek-v4-flash')).toBeTruthy();
    expect(screen.getByText('已开启')).toBeTruthy();
    // SOP 1 / 技能 2 / 资料 1，工具没有配置
    expect(screen.getAllByText('1')).toHaveLength(2);
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('未配置')).toBeTruthy();
  });

  it('没有执行记录时给出空态而不是空白面板', () => {
    render(<ChatContextRail chat={buildChat()} />);
    expect(screen.getByText('这一轮还没有执行记录。')).toBeTruthy();
  });

  it('读取最近一轮 trace 的步骤与耗时', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', role: 'assistant', content: '好的', created_at: '2026-11-16T00:00:00Z', turnId: 'turn-1' },
    ];
    const trace: TurnTrace = {
      startedAt: 1000,
      completedAt: 4600,
      durationMs: 3600,
      lines: [
        line({ id: 'l1', kind: 'skill', text: '命中 SOP · 权限开通工单分流', durationMs: 800 }),
        line({ id: 'l2', kind: 'knowledge', text: '检索 3 个知识库', durationMs: 1400 }),
        line({ id: 'l3', text: '调用工具 perm_policy_check', state: 'running' }),
      ],
    };

    render(<ChatContextRail chat={buildChat({ messages, trace })} />);

    expect(screen.getByText('命中 SOP · 权限开通工单分流')).toBeTruthy();
    expect(screen.getByText('检索 3 个知识库')).toBeTruthy();
    expect(screen.getByText('0.8s')).toBeTruthy();
    // durationMs 为整轮耗时，展示在面板标题右侧
    expect(screen.getByText('3.6s')).toBeTruthy();
    expect(screen.queryByText('这一轮还没有执行记录。')).toBeNull();
  });

  it('联网关闭时展示「已关闭」', () => {
    render(<ChatContextRail chat={buildChat({ webSearchEnabled: false })} />);
    expect(screen.getByText('已关闭')).toBeTruthy();
  });

  it('点「打开员工档案」在新标签页打开档案页，并把作用域先落盘', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    window.localStorage.clear();

    render(<ChatContextRail chat={buildChat()} />);
    fireEvent.click(screen.getByRole('button', { name: /打开员工档案/ }));

    // 档案页从 localStorage 读「当前员工」，必须先落盘再开窗，否则新标签页会
    // 落到别的员工（或兜底改写）。
    expect(window.localStorage.getItem('ultrarag_enterprise_agent_scope')).toBe('agent-1');
    expect(openSpy).toHaveBeenCalledWith(
      '/enterprise/dashboard',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('没有选中员工时档案入口不可点', () => {
    render(<ChatContextRail chat={buildChat({ agent: null })} />);
    const button = screen.getByRole('button', { name: /打开员工档案/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('聚合本会话引用过的资料，同一份文档只出现一次', () => {
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'a',
        created_at: '2026-11-16T00:00:00Z',
        metadata: {
          knowledge_citations: [
            { id: 'c1', document_id: 'doc-1', title: 'VPN 接入与权限开通 SOP' },
            { id: 'c2', document_id: 'doc-2', title: '账号权限矩阵' },
          ],
        },
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'b',
        created_at: '2026-11-16T00:01:00Z',
        metadata: {
          knowledge_citations: [
            // 同一份文档在不同轮次被再次命中，右栏只列一次
            { id: 'c3', document_id: 'doc-1', title: 'VPN 接入与权限开通 SOP' },
            { id: 'c4', url: 'https://example.com/a', title: '互联网来源说明' },
          ],
        },
      },
    ];

    render(<ChatContextRail chat={buildChat({ messages })} />);

    expect(screen.getAllByText('VPN 接入与权限开通 SOP')).toHaveLength(1);
    expect(screen.getByText('账号权限矩阵')).toBeTruthy();
    expect(screen.getByText('互联网来源说明')).toBeTruthy();
    expect(screen.getByText('3 份')).toBeTruthy();
  });

  it('没有引用时给一句空态而不是空白段', () => {
    render(<ChatContextRail chat={buildChat()} />);
    expect(screen.getByText('本次会话还没有引用资料。')).toBeTruthy();
  });
});
