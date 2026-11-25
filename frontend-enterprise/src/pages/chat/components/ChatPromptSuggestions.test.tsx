// @vitest-environment jsdom

// 快捷提问：只在员工配了 `suggested_prompts` 时出现，点了直接发出去，
// 只读 / 执行中不可点。位置在输入框正上方（Composer 渲染），不在空态里。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { employeeProfile, greetingPreviewText, normalizeSuggestedPrompts } from '@/employee';
import { I18nProvider } from '@/i18n';
import type { AgentProfileRead, ChatSession } from '@/types';

import type { UseChatSession } from '../useChatSession';
import ChatEmptyState from './ChatEmptyState';
import ChatPromptSuggestions from './ChatPromptSuggestions';

const baseAgent: AgentProfileRead = {
  id: 'agent-1',
  tenant_id: 'tenant_demo',
  name: '小艾',
  is_overall: false,
  status: 'active',
  metadata: {},
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const PROMPTS = ['帮我查一下最新的报销标准', '把这周的会议纪要整理成待办'];

function buildAgent(prompts: unknown): AgentProfileRead {
  return { ...baseAgent, metadata: { suggested_prompts: prompts } };
}

function buildChat(agent: AgentProfileRead, extra: Record<string, unknown> = {}): UseChatSession {
  return {
    currentSession: {
      id: 'session-1',
      tenant_id: 'tenant_demo',
      status: 'active',
      updated_at: '2026-08-01T00:00:00Z',
      agent_id: agent.id,
    } as ChatSession,
    displayedAgent: agent,
    displayedProfile: employeeProfile(agent),
    displayedAgentIsDispatcher: false,
    emptyRoleSummary: 'role summary',
    emptyStats: [
      { label: '资料', value: 1 },
      { label: '技能', value: 2 },
      { label: 'SOP', value: 3 },
    ],
    agents: [agent],
    ...extra,
  } as unknown as UseChatSession;
}

function renderEmptyState(chat: UseChatSession) {
  return render(
    <I18nProvider>
      <ChatEmptyState chat={chat} />
    </I18nProvider>,
  );
}

// 负向断言（不显示 / 不可点）必须清干净上一个用例的 DOM，否则会把上一条的
// 卡片再查出来。本项目 vitest 未开 globals，cleanup 得逐个 describe 声明。
afterEach(cleanup);

function renderPrompts(props: {
  prompts?: string[];
  disabled?: boolean;
  onSelect?: (prompt: string) => void;
} = {}) {
  return render(
    <I18nProvider>
      <ChatPromptSuggestions
        prompts={props.prompts ?? PROMPTS}
        disabled={props.disabled}
        onSelect={props.onSelect ?? vi.fn()}
      />
    </I18nProvider>,
  );
}

describe('ChatPromptSuggestions', () => {
  it('renders the configured prompts as clickable chips', () => {
    renderPrompts();

    expect(screen.getByRole('button', { name: `快捷提问 1：${PROMPTS[0]}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `快捷提问 2：${PROMPTS[1]}` })).toBeTruthy();
    expect(screen.getByText(PROMPTS[0])).toBeTruthy();
  });

  it('sends the prompt text straight to the bot on click', () => {
    const onSelect = vi.fn();
    renderPrompts({ onSelect });

    fireEvent.click(screen.getByRole('button', { name: `快捷提问 2：${PROMPTS[1]}` }));

    // 直接把整句发给 bot，而不是先塞进输入框让用户再按一次回车。
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(PROMPTS[1]);
  });

  it('renders nothing when the employee has no prompts configured', () => {
    // 没配 = 不显示这一块，不能留一段空白把输入框往下推。
    const { container } = renderPrompts({ prompts: [] });

    expect(screen.queryByRole('button', { name: /快捷提问/ })).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('disables the chips while disabled', () => {
    const onSelect = vi.fn();
    renderPrompts({ onSelect, disabled: true });

    const chip = screen.getByRole('button', { name: `快捷提问 1：${PROMPTS[0]}` }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('ChatEmptyState no longer hosts the prompts', () => {
  it('keeps the prompts out of the empty state', () => {
    // 位置契约：快捷提问归输入区管（Composer），空态只讲「我是谁」。
    renderEmptyState(buildChat(buildAgent(PROMPTS), {
      sendQuickText: vi.fn(),
      currentSessionRunning: false,
    }));

    expect(screen.queryByRole('button', { name: /快捷提问/ })).toBeNull();
  });
});

describe('normalizeSuggestedPrompts', () => {
  it('trims, drops blanks and duplicates, and keeps at most three', () => {
    // 线上脏数据的三种形态：前后空白、空串、超量。
    expect(normalizeSuggestedPrompts(['  查报销 ', '', '   ', '查报销', 'A', 'B', 'C']))
      .toEqual(['查报销', 'A', 'B']);
  });

  it('ignores non-array and non-string entries', () => {
    expect(normalizeSuggestedPrompts(undefined)).toEqual([]);
    expect(normalizeSuggestedPrompts('查报销')).toEqual([]);
    expect(normalizeSuggestedPrompts([1, null, '有效'])).toEqual(['有效']);
  });

  it('clips an over-long prompt instead of dropping it', () => {
    // 60 字以上就截断：卡片最多两行，全留也读不完，丢掉反而更糟。
    const long = '很'.repeat(100);
    const [result] = normalizeSuggestedPrompts([long]);
    expect(result).toHaveLength(60);
  });
});

describe('ChatEmptyState greeting preview', () => {
  const GREETING_BODY = '我可以帮你查制度、整理会议纪要，也可以直接起草邮件。';
  const greetingAgent: AgentProfileRead = {
    ...baseAgent,
    metadata: { greeting_message: GREETING_BODY },
  };

  it('shows the greeting with the signed-in user name before the first turn', () => {
    renderEmptyState(buildChat(greetingAgent, {
      sendQuickText: vi.fn(),
      authUser: { id: 'user_wang', username: 'wangxm', display_name: '王小名' },
    }));

    // 用 textContent 断言而不是 getByText：RTL 默认把连续空白（含换行）折叠成
    // 单个空格，直接匹配带 \n 的字符串必然匹配不上。
    const body = screen.getByText(new RegExp(GREETING_BODY.slice(0, 8))).textContent || '';
    // 格式是硬约定：第一行「你好，显示名。」，正文另起一行。
    expect(body.split('\n')[0]).toBe('你好，王小名。');
    expect(body.split('\n')[1]).toBe(GREETING_BODY);
  });

  it('renders nothing when the employee has no greeting configured', () => {
    renderEmptyState(buildChat(baseAgent, {
      sendQuickText: vi.fn(),
      authUser: { id: 'user_wang', username: 'wangxm', display_name: '王小名' },
    }));

    expect(screen.queryByText(/^你好，王小名。/)).toBeNull();
  });

  it('falls back to username when the share visitor has no display name', () => {
    renderEmptyState(buildChat(greetingAgent, {
      sendQuickText: vi.fn(),
      authUser: { id: 'user_guest', username: 'guest', display_name: '' },
    }));

    const body = screen.getByText(new RegExp(GREETING_BODY.slice(0, 8))).textContent || '';
    expect(body.split('\n')[0]).toBe('你好，guest。');
  });
});

describe('greetingPreviewText', () => {
  it('matches the backend format exactly', () => {
    // 后端 greeting_text_for_user() 的输出必须与这里逐字一致，否则用户会看到
    // 文案在发送前后"跳"一下。
    expect(greetingPreviewText('正文', '王小名')).toBe('你好，王小名。\n正文');
    expect(greetingPreviewText('正文', '  ')).toBe('你好。\n正文');
  });

  it('treats a blank greeting as not configured', () => {
    expect(greetingPreviewText('  \n ', '王小名')).toBe('');
    expect(greetingPreviewText(undefined as unknown as string, '王小名')).toBe('');
  });
});