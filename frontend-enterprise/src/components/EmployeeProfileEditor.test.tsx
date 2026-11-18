// @vitest-environment jsdom

// 员工档案编辑器里的「快捷提问」：增删、上限、以及保存时落到
// metadata.suggested_prompts（空则删 key）。
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { notify } from '@/components/ui/app-toast';
import { I18nProvider } from '@/i18n';
import type { AgentProfileRead } from '@/types';

import EmployeeProfileEditor from './EmployeeProfileEditor';

const agent: AgentProfileRead = {
  id: 'agent-1',
  tenant_id: 'tenant_demo',
  name: '小艾',
  is_overall: false,
  status: 'active',
  metadata: { suggested_prompts: ['帮我查一下最新的报销标准'] },
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

/** POST/PUT 统一回一个「保存后的员工」，并记录请求体供断言。 */
function stubFetch() {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url, body });
    return jsonResponse({ ...agent, metadata: body.metadata ?? {} });
  });
  vi.stubGlobal('fetch', fetchMock);
  return requests;
}

function renderEditor() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <I18nProvider>
      <EmployeeProfileEditor agent={agent} open currentUser={undefined} onClose={onClose} onSaved={onSaved} />
    </I18nProvider>,
  );
  return { onClose, onSaved };
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  vi.spyOn(notify, 'success').mockImplementation(() => 'toast' as never);
  vi.spyOn(notify, 'error').mockImplementation(() => 'toast' as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EmployeeProfileEditor suggested prompts', () => {
  it('loads the configured prompts and shows the counter', () => {
    stubFetch();
    renderEditor();

    expect(screen.getByDisplayValue('帮我查一下最新的报销标准')).toBeTruthy();
    expect(screen.getByText('1/3')).toBeTruthy();
  });

  it('adds and removes prompt rows, capped at three', async () => {
    stubFetch();
    renderEditor();

    const addButton = () => screen.queryByRole('button', { name: /添加快捷提问/ });
    await userEvent.click(addButton() as HTMLElement);
    await userEvent.click(addButton() as HTMLElement);
    // 已经 3 条：再加一条的入口必须消失，否则用户点了没反应还以为卡了。
    expect(screen.getByText('3/3')).toBeTruthy();
    expect(addButton()).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '删除第 2 条快捷提问' }));
    expect(screen.getByText('2/3')).toBeTruthy();
    expect(screen.getByRole('button', { name: /添加快捷提问/ })).toBeTruthy();
  });

  it('writes prompts into metadata on save', async () => {
    const requests = stubFetch();
    renderEditor();

    const input = screen.getByDisplayValue('帮我查一下最新的报销标准');
    await userEvent.clear(input);
    await userEvent.type(input, '把这周的会议纪要整理成待办');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(requests.some((item) => item.url.includes('/api/enterprise/agents/agent-1'))).toBe(true));
    const save = requests.find((item) => item.url.includes('/api/enterprise/agents/agent-1'));
    expect((save?.body.metadata as Record<string, unknown>).suggested_prompts)
      .toEqual(['把这周的会议纪要整理成待办']);
  });

  it('drops the metadata key when every prompt is cleared', async () => {
    // 留空数组会让「没配过」和「配过又清空」在数据里长得一样，
    // 空态与配置页读到的就不一定是同一件事。
    const requests = stubFetch();
    renderEditor();

    await userEvent.click(screen.getByRole('button', { name: '删除第 1 条快捷提问' }));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(requests.some((item) => item.url.includes('/api/enterprise/agents/agent-1'))).toBe(true));
    const save = requests.find((item) => item.url.includes('/api/enterprise/agents/agent-1'));
    expect(save?.body.metadata as Record<string, unknown>)
      .not.toHaveProperty('suggested_prompts');
  });
});

describe('EmployeeProfileEditor greeting message', () => {
  const editorWithUser = (target: AgentProfileRead) => render(
    <I18nProvider>
      <EmployeeProfileEditor
        agent={target}
        open
        currentUser={{
          id: 'user_wang',
          username: 'wangxm',
          display_name: '王小名',
          tenant_id: 'tenant_demo',
          role: 'member',
        }}
        onClose={vi.fn()}
      />
    </I18nProvider>,
  );

  it('writes the greeting into metadata and previews it with the header', async () => {
    const requests = stubFetch();
    editorWithUser(agent);

    const textarea = screen.getByPlaceholderText(/我可以帮你查制度/);
    await userEvent.type(textarea, '我可以帮你查制度、整理纪要。');

    // 抬头是固定的「你好，{显示名}。」，配置端只收正文，所以预览必须带出来，
    // 否则用户会以为要自己写称呼。
    const preview = screen.getByText(/^你好，王小名。/);
    expect(preview.textContent).toContain('我可以帮你查制度、整理纪要。');

    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(requests.some((item) => item.url.includes('/api/enterprise/agents/agent-1'))).toBe(true));
    const save = requests.find((item) => item.url.includes('/api/enterprise/agents/agent-1'));
    expect((save?.body.metadata as Record<string, unknown>).greeting_message)
      .toBe('我可以帮你查制度、整理纪要。');
  });

  it('drops the greeting key when the field is cleared', async () => {
    const withGreeting: AgentProfileRead = {
      ...agent,
      metadata: { ...agent.metadata, greeting_message: '原来有开场白' },
    };
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ url, body });
      return jsonResponse({ ...withGreeting, metadata: body.metadata ?? {} });
    }));

    editorWithUser(withGreeting);

    await userEvent.clear(screen.getByDisplayValue('原来有开场白'));
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(requests.some((item) => item.url.includes('/api/enterprise/agents/agent-1'))).toBe(true));
    const save = requests.find((item) => item.url.includes('/api/enterprise/agents/agent-1'));
    expect(save?.body.metadata as Record<string, unknown>).not.toHaveProperty('greeting_message');
  });
});

describe('EmployeeProfileEditor retired soft tags', () => {
  /*
   * work_styles / expertise_tags / work_modes 已下线：它们只是拼进 prompt 的
   * 人设描述，却长得像「勾了就开通能力」，容易被误读。
   *
   * 关键风险是保存路径以 `...agent.metadata` 为基线——旧员工存一次就会把这三个
   * key 原样写回去，等于永远退不掉。所以这里必须断言它们被显式删除。
   */
  it('strips retired soft-tag keys from metadata on save', async () => {
    const legacy: AgentProfileRead = {
      ...agent,
      metadata: {
        role_name: '研发',
        work_styles: ['目标明确', '证据优先'],
        expertise_tags: ['代码检索'],
        work_modes: ['理解需求'],
      },
    };
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ url, body });
      return jsonResponse({ ...legacy, metadata: body.metadata ?? {} });
    }));

    render(
      <I18nProvider>
        <EmployeeProfileEditor agent={legacy} open currentUser={undefined} onClose={vi.fn()} onSaved={vi.fn()} />
      </I18nProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(requests.some((item) => item.url.includes('/api/enterprise/agents/agent-1'))).toBe(true));
    const save = requests.find((item) => item.url.includes('/api/enterprise/agents/agent-1'));
    const metadata = save?.body.metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('work_styles');
    expect(metadata).not.toHaveProperty('expertise_tags');
    expect(metadata).not.toHaveProperty('work_modes');
    // 无关字段不能被误伤
    expect(metadata.role_name).toBe('研发');
  });

  it('no longer renders the three tag editors', () => {
    stubFetch();
    renderEditor();

    expect(screen.queryByText('掌握方向')).toBeNull();
    expect(screen.queryByText('工作风格')).toBeNull();
    expect(screen.queryByText('工作模式')).toBeNull();
  });
});