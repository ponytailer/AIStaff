// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';

import SceneEditor from './SceneEditor';

/**
 * 场景定义器 —— 「表单提交」类型的接口配置。
 *
 * ## 这些用例锁的是什么
 *
 * 在「接口」区块存在之前，定义器**完全没有 `tool_api` 的输入入口**：
 * 用户能把表单场景建出来，却没法指定它调哪个接口。表现是场景发布成功、
 * 按钮点得动，一提交就回「这个场景还没有配置要调用的接口」，
 * 而界面上找不到任何可以填的地方。
 *
 * 所以断言分四组：
 *
 * 1. **该出现时出现** —— `tool_submit` 下有「提交到哪里」区块
 * 2. **不该出现时消失** —— 查表类型下没有它（契约 §4.2：不渲染，不置灰）
 * 3. **保存要带上** —— `tool_api` 整份发给后端（少发 = 工具名丢失）
 * 4. **发布要拦** —— 没选接口不许发布
 */

const PRESET_OPTIONS = [
  {
    module_key: 'travel.itinerary',
    display_name: '行程规划',
    scene_type: 'table_match',
    icon: '🎿',
    icons: ['🎿', '🏔️'],
    description: '按人数天数预算推荐行程',
  },
  {
    module_key: 'generic.tool_submit',
    display_name: '表单提交',
    scene_type: 'tool_submit',
    icon: '📮',
    icons: ['📮', '🛎️'],
    description: '收齐几个字段，提交给外部系统',
  },
];

const TOOL_SUBMIT_DEFAULTS = {
  module_key: 'generic.tool_submit',
  display_name: '表单提交',
  scene_type: 'tool_submit',
  icon: '📮',
  description: '收齐几个字段，提交给外部系统',
  icons: ['📮', '🛎️'],
  ui_config: {
    fallback_text: '已提交，结果如下',
    form_title: '请填写下面的信息',
    form_subtitle: '填好这几项，我提交给对应部门',
    params: { receipt_title: '已提交', receipt_no_label: '' },
  },
  trigger: { shortcut: true, keywords: [], require_slots: true, bypass_llm_router: true },
  slots: [
    { key: 'subject', label: '要办的事', target: '', type: 'text', unit: '', required: true },
    { key: 'note', label: '备注', target: '', type: 'text', unit: '', required: false },
  ],
  match_action: { top_k: 3, on_empty: 'none' },
  respond_action: { ask_prompt: '填好下面的信息，我马上帮你提交：' },
  tool_api: {
    tool_name: '',
    reply_template: '已提交，受理单号 {{order_no}}。',
    param_map: {},
    timeout_seconds: 8,
    field_labels: {},
  },
};

const TOOLS = [
  { name: 'room.delivery_submit', description: '客房送物', bucket: '客房服务' },
  { name: 'repair.ticket_submit', description: '报修工单', bucket: '工程' },
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 桩掉 `fetch`，并把「保存时提交了什么」留在外部变量里。
 *
 * 只桩 `fetch` 而不 mock `@/api/scenes` 一整层：定义器的价值恰恰在于
 * 「state → payload → 请求体」这一整条链，把 api 层 mock 掉就只剩
 * state → 参数，中间最容易出错的那一段（字段名写错、忘了展开）测不到。
 */
function mockFetch(opts: { defaults?: unknown; tools?: unknown[] } = {}) {
  const saved: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);

      if (url.includes('/scene-preset-options/defaults/')) {
        return jsonResponse(opts.defaults ?? TOOL_SUBMIT_DEFAULTS);
      }
      if (url.includes('/scene-preset-options')) return jsonResponse(PRESET_OPTIONS);
      // 接口下拉的数据源。**顺序在下面那条通配 `/scenes/` 之前**：
      // 它是 `/api/enterprise/scenes/tool-options`，会被通配吃成「场景详情」。
      if (url.includes('/scenes/tool-options')) return jsonResponse(opts.tools ?? TOOLS);
      if (url.includes('/api/enterprise/scenes/tables')) return jsonResponse([]);

      // 创建场景：记下请求体
      if (init?.method === 'POST' && url.includes('/api/enterprise/scenes')) {
        saved.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
        return jsonResponse({ id: 'scene_new' });
      }
      // 场景详情（编辑已有场景）
      if (url.includes('/api/enterprise/scenes/')) {
        return jsonResponse(opts.defaults ?? {});
      }
      return jsonResponse([]);
    }),
  );
  return { saved, calls };
}

function renderEditor(props: Partial<Parameters<typeof SceneEditor>[0]> = {}) {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <SceneEditor
          sceneId={null}
          tables={[]}
          onClose={() => {}}
          onSaved={() => {}}
          {...props}
        />
      </TooltipProvider>
    </I18nProvider>,
  );
}

/** 把场景类型切到「表单提交」（新建时默认选第一个 = 行程规划）。 */
async function pickToolSubmit() {
  const select = await screen.findByRole('combobox', { name: /场景类型/ });
  await userEvent.selectOptions(select, 'generic.tool_submit');
  // 默认值是异步拉的，等它落地
  await waitFor(() => expect(screen.getByText('提交到哪里')).toBeTruthy());
}

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('定义器 · 表单提交类型', () => {
  it('选中「表单提交」后出现「提交到哪里」区块', async () => {
    mockFetch();
    renderEditor();
    await pickToolSubmit();

    expect(screen.getByText('提交到哪里')).toBeTruthy();
    // 接口下拉在，且提示语是「请选择」而不是已经选了某个
    const toolSelect = screen.getByRole('combobox', { name: /接口/ });
    expect((toolSelect as HTMLSelectElement).value).toBe('');
  });

  it('工具列表拉不到时给出可行动的提示，而不是空下拉', async () => {
    mockFetch({ tools: [] });
    renderEditor();
    await pickToolSubmit();

    // 「还没有可用工具，请先到工具页建」——要让用户知道去哪
    expect(screen.getByText(/还没有可用工具/)).toBeTruthy();
    // 这时不该画一个空的下拉让他以为是自己没找对地方
    expect(screen.queryByRole('combobox', { name: /接口/ })).toBeNull();
  });

  it('查表类型下不渲染「提交到哪里」', async () => {
    mockFetch();
    renderEditor();
    // 默认选中第一个预设 = 行程规划（table_match）
    await waitFor(() => expect(screen.getByText('匹配策略')).toBeTruthy());

    // 契约 §4.2：不渲染，不置灰
    expect(screen.queryByText('提交到哪里')).toBeNull();
  });

  it('选了接口 + 填了名字就能保存，且 tool_api 带上工具名', async () => {
    const { saved } = mockFetch();
    renderEditor();
    await pickToolSubmit();

    await userEvent.type(screen.getByPlaceholderText(/例如：滑雪行程推荐/), '客房送物');

    const toolSelect = screen.getByRole('combobox', { name: /接口/ });
    await userEvent.selectOptions(toolSelect, 'room.delivery_submit');

    await userEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(saved.length).toBeGreaterThan(0));
    const payload = saved[0];
    expect(payload.scene_type).toBe('tool_submit');
    expect(payload.module_key).toBe('generic.tool_submit');

    // 整份 tool_api 都在 —— 少一个键后端就当没配
    const toolApi = payload.tool_api as Record<string, unknown>;
    expect(toolApi).toBeTruthy();
    expect(toolApi.tool_name).toBe('room.delivery_submit');
    expect(toolApi.reply_template).toBe(TOOL_SUBMIT_DEFAULTS.tool_api.reply_template);
    expect(toolApi.timeout_seconds).toBe(8);
    expect(toolApi.param_map).toEqual({});
  });

  it('保存时槽位跟着预设走，且没有「对应列」映射', async () => {
    const { saved } = mockFetch();
    renderEditor();
    await pickToolSubmit();

    await userEvent.type(screen.getByPlaceholderText(/例如：滑雪行程推荐/), '客房送物');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /接口/ }), 'room.delivery_submit');
    await userEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(saved.length).toBeGreaterThan(0));
    const slots = saved[0].slots as Array<Record<string, unknown>>;
    expect(slots.map((slot) => slot.key)).toEqual(['subject', 'note']);
    // 这个类型不查表，target 必须为空 —— 有值说明状态杂交了
    expect(slots.every((slot) => slot.target === '')).toBe(true);
  });

  it('没选接口时发布被拦下，并说清缺什么', async () => {
    const { saved } = mockFetch();
    renderEditor();
    await pickToolSubmit();

    await userEvent.type(screen.getByPlaceholderText(/例如：滑雪行程推荐/), '客房送物');
    // 故意不选接口，直接发布
    await userEvent.click(screen.getByRole('button', { name: /^发布$/ }));

    /*
      拦住的证据看请求有没有发出，而不是看提示文案。

      `publishBlockers` 的失败走 `notify.error` → toast，而 toast 是
      portal + 自动消失的，在 jsdom 里断言它的文本既脆又容易假绿
      （找不到时可能是「拦住了但没提示」或「提示了但拦不住」，分不清）。
      「没发出创建请求」是唯一没有歧义的证据。
    */
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(saved.length).toBe(0);
  });
});

describe('定义器 · 回复用户（话术开放给员工）', () => {
  /*
    这一组锁的是用户原话：「这里还是要开放给用户填的，样式可以固定，
    但是话术肯定随着不同情况变化的」。

    版式由 module 代码决定（渐变卡头、单号一行），用户改不了也不该改；
    但说什么话必须能填。区块里的输入框不是写死的，而是按 module 的
    `params_schema` 里 `type` 为 text / textarea 的项渲染 ——
    加新 module 时定义器零改动。
  */

  it('「表单提交」下有「回复用户」区块，且话术输入框在里面', async () => {
    mockFetch();
    renderEditor();
    await pickToolSubmit();

    expect(screen.getByText('回复用户')).toBeTruthy();
    // 话术项应该都在（结论句 / 补充说明 / 哪个字段是单号 / 单号叫什么）。
    //
    // ⚠️ 原先还有「进度按钮文案」「点进度按钮时发什么」两项 —— 2026-11-26
    // 连按钮一起删了（点了没用：模型手上没有这张回执的上下文）。这里不再
    // 断言它们存在，同时也断言它们**确实消失**（见下一条用例）。
    for (const label of [
      '结论句',
      '补充说明',
      '哪个字段是单号',
      '单号叫什么',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const gone of ['进度按钮文案', '点进度按钮时发什么']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it('说「改了话术要能存下来」：填的结论句进 ui_config.params', async () => {
    /*
      这是「开放给用户填」的可验证含义。只渲染输入框是不够的 ——
      必须确认它写进了 `ui_config.params`（渲染时读的就是那里）。
    */
    const { saved } = mockFetch();
    renderEditor();
    await pickToolSubmit();

    await userEvent.type(screen.getByPlaceholderText(/例如：滑雪行程推荐/), '客房送物');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /接口/ }),
      'room.delivery_submit',
    );

    const titleInput = screen.getByPlaceholderText('已提交');
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, '已通知客房部');

    await userEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(saved.length).toBeGreaterThan(0));
    const uiConfig = saved[0].ui_config as Record<string, unknown>;
    const params = uiConfig.params as Record<string, unknown>;
    expect(params.receipt_title).toBe('已通知客房部');
  });

  it('查表类型下没有话术输入框（module 没声明文案参数就不渲染空区块）', async () => {
    mockFetch();
    renderEditor();
    await waitFor(() => expect(screen.getByText('匹配策略')).toBeTruthy());

    /*
      行程规划的 `params_schema` 里全是 `column` 和 `boolean`
      （标题取哪列、价格取哪列），没有一条是「文案」。它的价格说明归预设页管。

      出现一个空区块比不出现更糟：用户会以为漏配了什么。
    */
    expect(screen.queryByText('回复用户')).toBeNull();
  });

  it('区块序号连续：提交类场景是 1..5，不跳号不重复', async () => {
    /*
      区块按类型显隐，序号必须算出来。写死数字会出现两种坏情况：
      跳号（1 2 3 5 → 用户以为中间那块没加载出来）、
      重复（两块都是 4 → 左侧高亮同时点亮两项）。

      提交类场景的区块顺序：基础信息 / 槽位 / 回复用户 / 提交到哪里
      （无数据表、无匹配策略 → 共 4 块）。
    */
    mockFetch();
    renderEditor();
    await pickToolSubmit();

    const heads = ['基础信息', '槽位（要问用户什么）', '提交到哪里', '回复用户'];
    const numbers = heads.map((title) => {
      // 标题节点的前一个兄弟是序号圆点
      const heading = screen.getByText(title).closest('h3');
      const badge = heading?.querySelector('span');
      return Number(badge?.textContent);
    });
    expect(numbers).toEqual([1, 2, 3, 4]);
  });
});

describe('定义器 · 编辑存量场景', () => {
  it('回填 tool_api，且不改动就原样保存回去', async () => {
    const existing = {
      id: 'scene_1',
      tenant_id: 'tenant_demo',
      name: '客房送物',
      description: '送水送毛巾',
      icon: '🛎️',
      status: 'published',
      scene_type: 'tool_submit',
      module_key: 'generic.tool_submit',
      module_version: 1,
      table_ids: [],
      trigger: {},
      slots: [{ key: 'room_no', label: '房间号', target: '', type: 'text', required: true }],
      match_action: {},
      respond_action: { mode: 'template', template: '', ask_prompt: '填两栏就提交' },
      shortcut: {},
      ui_config: { fallback_text: '已提交', params: { receipt_title: '已提交' } },
      tool_api: {
        tool_name: 'room.delivery_submit',
        reply_template: '已为 {{room_no}} 房送出 {{item}}。',
        param_map: { roomNumber: 'room_no' },
        timeout_seconds: 12,
        field_labels: { order_no: '受理单号' },
      },
      agent_ids: [],
      warnings: [],
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
    };

    const { saved } = mockFetch({ defaults: existing });
    void saved;
    renderEditor({ sceneId: 'scene_1' });

    // 等表单铺好（场景名叫出来）
    await waitFor(() => expect(screen.getByDisplayValue('客房送物')).toBeTruthy());

    // 接口下拉应该已经选中存量值
    const toolSelect = (await screen.findByRole('combobox', {
      name: /接口/,
    })) as HTMLSelectElement;
    expect(toolSelect.value).toBe('room.delivery_submit');

    // 回复模板也回填了
    expect(screen.getByDisplayValue(/已为 \{\{room_no\}\} 房送出/)).toBeTruthy();

    // 只改个名字就保存，tool_api 不能被清空
    const nameInput = screen.getByDisplayValue('客房送物');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, '客房送物2');
    await userEvent.click(screen.getByRole('button', { name: /保存/ }));

    // 更新走 PUT，`saved` 只记 POST，所以这里从 fetch 调用参数里取
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PUT'),
      ).toBe(true),
    );
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === 'PUT',
    );
    const body = JSON.parse(String((putCall![1] as RequestInit).body));
    expect(body.tool_api.tool_name).toBe('room.delivery_submit');
    expect(body.tool_api.reply_template).toBe('已为 {{room_no}} 房送出 {{item}}。');
    // 参数映射不能被冲掉（这是 `tool_api` 归快照键而不是实时键的直接后果）
    expect(body.tool_api.param_map).toEqual({ roomNumber: 'room_no' });
    expect(body.tool_api.timeout_seconds).toBe(12);
  });
});
/**
 * 接口下拉的两条硬要求（用户提的「下拉要从员工身上拿，不是广场全量」）。
 *
 * 这两条都属于「界面让人选了个调不通的东西」这类问题：能选、保存成功、
 * 线上一点就失败，而且失败信息看起来像业务错误。所以必须在**下拉这一层**就
 * 保证「能选 = 能调」。
 */
describe('定义器 · 接口下拉只给这个员工能调的工具', () => {
  it('请求带 agent_id，走 tool-options 而不是广场全量工具列表', async () => {
    const { calls } = mockFetch();
    renderEditor({ defaultAgentId: 'agent_xianlin' });
    await pickToolSubmit();

    await waitFor(() =>
      expect(calls.some((url) => url.includes('/scenes/tool-options'))).toBe(true),
    );
    const url = calls.find((item) => item.includes('/scenes/tool-options'))!;
    expect(url).toContain('agent_id=agent_xianlin');
    // 关键：不能再打那个「工具管理页」的接口 —— 它给的是广场全量（含未绑定的）
    expect(calls.some((item) => item.includes('/api/enterprise/tools'))).toBe(false);
  });

  it('从场景管理页进来（没有员工语境）时不带 agent_id，仍然能配', async () => {
    const { calls } = mockFetch();
    renderEditor();
    await pickToolSubmit();

    await waitFor(() =>
      expect(calls.some((url) => url.includes('/scenes/tool-options'))).toBe(true),
    );
    const url = calls.find((item) => item.includes('/scenes/tool-options'))!;
    expect(url).not.toContain('agent_id=');
    // 下拉照常出现：管理员验证配置时不能因为「还没绑员工」就配不了
    expect(screen.getByRole('combobox', { name: /接口/ })).toBeTruthy();
  });

  it('员工一个工具都没绑时，提示去绑定而不是去建工具', async () => {
    mockFetch({ tools: [] });
    renderEditor({ defaultAgentId: 'agent_xianlin' });
    await pickToolSubmit();

    // 这个语境下工具很可能早就存在了，只是没勾给这个人 ——
    // 一律说「去工具页建」会让用户白跑一趟。
    expect(screen.getByText(/这个员工还没有绑定任何可用的工具/)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /接口/ })).toBeNull();
  });

  it('存量接口已解绑时占位项说「已不可用」而不是「已不存在」', async () => {
    const existing = {
      id: 'scene_1',
      tenant_id: 'tenant_demo',
      name: '客房送物',
      description: '送水送毛巾',
      icon: '🛎️',
      status: 'published',
      scene_type: 'tool_submit',
      module_key: 'generic.tool_submit',
      module_version: 1,
      table_ids: [],
      trigger: {},
      slots: [{ key: 'room_no', label: '房间号', target: '', type: 'text', required: true }],
      match_action: {},
      respond_action: { mode: 'template', template: '', ask_prompt: '填两栏就提交' },
      shortcut: {},
      ui_config: { fallback_text: '已提交', params: { receipt_title: '已提交' } },
      tool_api: {
        tool_name: 'room.gone_tool',
        reply_template: '已提交',
        param_map: {},
        timeout_seconds: 8,
        field_labels: {},
      },
      agent_ids: [],
      warnings: [],
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
    };
    mockFetch({ defaults: existing, tools: TOOLS });
    renderEditor({ sceneId: 'scene_1', defaultAgentId: 'agent_xianlin' });

    // 工具本身可能还在，只是这个员工没绑定它。说「已不存在」会让人去工具页
    // 翻半天发现工具明明在。
    expect(await screen.findByText(/已不可用/)).toBeTruthy();
  });
});
