// @vitest-environment jsdom

/**
 * 回归护栏：`submitSlotForm`（表单「开始匹配」）必须与 `send()`（打字发送）
 * 对「正在跑一轮」给出**同一种**反应。
 *
 * ## 为什么单独一个文件
 *
 * 用户报的原始缺陷是「分享链接里点开始匹配报错」，截图是那条黄色警告：
 * 「当前任务仍在执行，请稍后再提交」。根因不在按钮，也不在分享页 ——
 * 是两条提交路径的口径不一致：
 *
 *   - `send()`：四项判定 → `enqueuePreparedTurn(prepared)`，进队列、提示
 *     「已加入发送队列」、本轮结束后自动执行；
 *   - `submitSlotForm()`：只判两项 → `notify.warning(...)` + `return`，
 *     **用户的点击被直接丢弃**，且没告诉他什么时候能再点。
 *
 * 只判两项还漏了 `hasQueuedTurnForConversation`：表单上连点两次时，两条
 * 提交都直接执行，同一份槽位被提交两遍（后端接口调两次）。
 *
 * 这个文件锁三件事：
 *   1. 本轮在跑时提交 → 入队，**不弹**那句警告；
 *   2. 本轮空闲时提交 → 立即执行，且带上 `slot_submission` / `forced_scene_id`；
 *   3. 已有排队项时再提交 → 继续入队，不叠第二条请求。
 *
 * ## 为什么用 shareMode
 *
 * 分享页是用户报障的现场，且 `shareMode` 跳过站内模型校验
 * （`ensureModelAvailable` 直接 return true），不用在测试里搭一整套模型
 * 配置的假接口。顺带一提，`shareMode` 也让 `drainQueuedTurns` 在
 * `selectedModelConfig` 为空时提前 return —— 队列不会在测试中被异步消费，
 * 断言才稳定。
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import { chatQueueStorageKey } from './chatQueueStorage';
import type { ChatSession } from '@/types';
import type { A2UIForm } from './chatTypes';

import { useChatSession } from './useChatSession';

const { infoMock, warnMock, errorMock, successMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  warnMock: vi.fn(),
  errorMock: vi.fn(),
  successMock: vi.fn(),
}));

// `notify` 是这条缺陷最直接的观测点：修复前走的就是
// `notify.warning('当前任务仍在执行，请稍后再提交')`。
vi.mock('@/components/ui/app-toast', () => ({
  notify: {
    success: successMock,
    error: errorMock,
    warning: warnMock,
    info: infoMock,
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

/** 记录每一轮真正打到后端的提交流（顺序敏感 —— 同一份槽位串两遍就是 bug）。 */
const { streamRequests, streamChatTurnMock } = vi.hoisted(() => {
  const requests: Record<string, unknown>[] = [];
  return {
    streamRequests: requests,
    streamChatTurnMock: vi.fn(async (body: Record<string, unknown>) => {
      requests.push(body);
    }),
  };
});

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return {
    ...actual,
    // 只替换流接口：`api.get` 等保持真实实现，走下面 `fetch` 的桩。
    streamChatTurn: streamChatTurnMock,
  };
});

const RUNNING_WARNING = '当前任务仍在执行，请稍后再提交';
const AUTH_STORAGE_KEY = 'ultrarag_auth';
const TENANT_ID = 'tenant_demo';
const USER_ID = 'share_guest_x';
const SESSION_ID = 'session-running-1';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body ?? {}),
  } as Response;
}

function sessionFixture(status: string): ChatSession {
  return {
    id: SESSION_ID,
    tenant_id: TENANT_ID,
    agent_id: 'agent-ski-1',
    status,
    title: '滑雪行程推荐',
    updated_at: '2026-11-26T00:00:00Z',
  };
}

const agentFixture = {
  id: 'agent-ski-1',
  tenant_id: TENANT_ID,
  name: '滑雪顾问',
  is_overall: false,
  status: 'active',
  metadata: {},
  resources: [],
  created_at: '2026-11-26T00:00:00Z',
  updated_at: '2026-11-26T00:00:00Z',
} as unknown as import('@/types').AgentProfileRead;

function stubFetch(status: string) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/chat/agents')) return jsonResponse([agentFixture]);
    if (url.includes('/api/chat/sessions')) return jsonResponse([sessionFixture(status)]);
    if (url.includes('/api/chat/')) return jsonResponse([]);
    if (url.includes('/api/enterprise/')) return jsonResponse([]);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 与截图里那张表一致：人数 3、天数 4 天、预算 4000。 */
const skiForm: A2UIForm = {
  kind: 'form',
  title: '滑雪行程推荐',
  fields: [
    { name: 'people', label: '人数（人）', type: 'number', required: true },
    { name: 'days', label: '天数（天）', type: 'number', required: true },
    { name: 'budget', label: '预算（元）', type: 'number', required: true },
  ],
};

const skiValues = { people: 3, days: 4, budget: 4000 };

function renderHookWithSession() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider>
      <MemoryRouter initialEntries={['/share/tok']}>{children}</MemoryRouter>
    </I18nProvider>
  );
  return renderHook(
    () => useChatSession({
      anonymous: true,
      shareMode: true,
      sessionId: SESSION_ID,
    }),
    { wrapper },
  );
}

function readQueue(): unknown[] {
  const raw = window.sessionStorage.getItem(chatQueueStorageKey(TENANT_ID, USER_ID));
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function seedQueue(count: number) {
  const key = chatQueueStorageKey(TENANT_ID, USER_ID);
  const turns = Array.from({ length: count }, (_, index) => ({
    queueId: `queue_seed_${index}`,
    conversationId: SESSION_ID,
    agentId: 'agent-ski-1',
    turnId: `turn_seed_${index}`,
    text: '人数（人）：3；天数（天）：4；预算（元）：4000',
    attachments: [],
    interactionMode: 'normal',
    createdAt: '2026-11-26T00:00:00Z',
    slotSubmission: skiValues,
  }));
  window.sessionStorage.setItem(key, JSON.stringify(turns));
}

/** 等 agents 与 sessions 都进状态（否则 effectiveAgentId 为空，提交直接被挡）。 */
async function waitForReady(result: { current: ReturnType<typeof useChatSession> }) {
  await waitFor(() => {
    expect(result.current.displayedAgent?.id).toBe('agent-ski-1');
  }, { timeout: 3000 });
}

beforeEach(() => {
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
    token: 'share-token-1',
    user: { id: USER_ID, tenant_id: TENANT_ID, username: USER_ID, role: 'member' },
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  streamRequests.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('submitSlotForm 遇到「本轮还在跑」时与 send() 同口径', () => {
  it('本轮在跑：入队并提示，而不是弹「请稍后再提交」', async () => {
    stubFetch('running');
    const { result } = renderHookWithSession();
    await waitForReady(result);

    await act(async () => {
      await result.current.submitSlotForm(skiForm, skiValues, 'scene-ski-1');
    });

    // 用户报的就是这句；修复后不能再出现
    const warned = warnMock.mock.calls.map((call) => String(call[0] ?? ''));
    expect(warned).not.toContain(RUNNING_WARNING);

    // 改成进队列 + 明确告知
    const informed = infoMock.mock.calls.map((call) => String(call[0] ?? ''));
    expect(informed).toContain('已加入发送队列');
    expect(readQueue()).toHaveLength(1);

    // 本轮还在跑，队列不该被消费：一次后端请求都不能发
    expect(streamRequests).toHaveLength(0);
  });

  it('本轮空闲：立即执行，且带上 slot_submission 与 forced_scene_id', async () => {
    stubFetch('active');
    const { result } = renderHookWithSession();
    await waitForReady(result);

    await act(async () => {
      await result.current.submitSlotForm(skiForm, skiValues, 'scene-ski-1');
    });

    expect(streamRequests).toHaveLength(1);
    const body = streamRequests[0];
    expect(body.slot_submission).toEqual(skiValues);
    // 提交文本是「人数（人）：3；…」，一个触发关键词都没有，不显式指定场景
    // 后端会落回普通对话 —— 用户填的表就白填了。
    expect(body.forced_scene_id).toBe('scene-ski-1');
    expect(readQueue()).toHaveLength(0);
  });

  it('已有排队项时再提交：继续入队，不叠出第二条请求', async () => {
    stubFetch('active');
    seedQueue(1);
    const { result } = renderHookWithSession();
    await waitForReady(result);

    await act(async () => {
      await result.current.submitSlotForm(skiForm, skiValues, 'scene-ski-1');
    });

    // 少判 `hasQueuedTurnForConversation` 的后果：这一下会直接把请求打出去，
    // 同一份槽位被提交两遍（E2E 里表现为 /api/chat/stream 收到两条一模一样的
    // slot_submission）。改成入队后，队列从 1 条变 2 条。
    expect(streamRequests).toHaveLength(0);
    expect(readQueue()).toHaveLength(2);
  });
});