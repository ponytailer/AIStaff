// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';

import ScenePresetsPage from './ScenePresetsPage';

/**
 * 场景预设页的最小护栏。
 *
 * 这一页长期没有测试（`scene-v3-dev-guide.md` §0.5 自己标了 ⚠️），因为它全是
 * 表单与 JSON 互转，写起来成本高。但「删掉一个按钮」这种改动**必须**有测试，
 * 否则下次重构很容易把它带回来 —— 而它是个一键覆盖全页、没有确认步骤的操作。
 *
 * 只测两件事，刻意克制：
 * 1. 「恢复出厂」按钮不存在（这是用户明确要求删除的）；
 * 2. 页面主体能渲染出来（删按钮时把 import 或 state 删坏了会白屏）。
 *
 * 不去测 JSON 互转与预览：那是另一件事，且需要假 module 注册表，
 * 写歪了反而给人「这页有覆盖」的错觉。
 */

const PRESET = {
  module_key: 'travel.itinerary',
  display_name: '行程规划',
  scene_type: 'table_match',
  icon: '🎿',
  enabled: true,
  order_index: 0,
  preset_json: {
    ui_config: { form_title: '告诉我们你的需求', params: {} },
  },
  updated_at: '2026-11-26T00:00:00Z',
  updated_by: 'admin',
};

/** 「表单提交」的预设：它声明的参数与行程规划完全不同。 */
const TOOL_SUBMIT_PRESET = {
  module_key: 'generic.tool_submit',
  display_name: '表单提交',
  scene_type: 'tool_submit',
  icon: '📮',
  enabled: true,
  order_index: 10,
  preset_json: {
    description: '收齐几个字段，提交给外部系统',
    icons: ['📮', '🛎️'],
    ui_config: {
      fallback_text: '已提交，结果如下',
      form_title: '请填写下面的信息',
      params: { receipt_title: '已提交', receipt_no_label: '' },
    },
    trigger: { shortcut: true },
    slots: [{ key: 'subject', label: '要办的事', target: '', type: 'text', required: true }],
    match_action: {},
    respond_action: { ask_prompt: '填好下面的信息，我马上帮你提交：' },
    tool_api: {
      tool_name: '',
      reply_template: '已提交，受理单号 {{order_no}}。',
      param_map: {},
      timeout_seconds: 8,
      field_labels: {},
    },
  },
  updated_at: '2026-11-26T00:00:00Z',
  updated_by: 'admin',
};

// 只 mock 网络层。组件内部逻辑（JSON 解析、字段渲染）保持真实。
vi.mock('../api/scenes', async () => {
  const actual = await vi.importActual<typeof import('../api/scenes')>('../api/scenes');
  return {
    ...actual,
    listScenePresets: vi.fn(async () => [PRESET]),
    saveScenePreset: vi.fn(async () => PRESET),
    // 故意**不提供** resetScenePreset：它已从页面移除，
    // 若有人把它加回来，这里的 import 会拿到 undefined 而立刻炸，比断言更早暴露。
  };
});

describe('ScenePresetsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('标题区没有「恢复出厂」按钮（用户要求删除）', async () => {
    render(
      <I18nProvider>
        <ScenePresetsPage currentUser={{ id: 'u1', name: 'admin', role: 'admin' } as never} />
      </I18nProvider>,
    );

    // 等首屏数据落地，避免「加载中」阶段就断言不存在（那时当然不存在，测了个空气）
    await waitFor(() => {
      expect(screen.getByText('保存预设')).toBeTruthy();
    });

    expect(screen.queryByText('恢复出厂')).toBeNull();
  });

  it('页面主体能渲染，不因删按钮而白屏', async () => {
    render(
      <I18nProvider>
        <ScenePresetsPage currentUser={{ id: 'u1', name: 'admin', role: 'admin' } as never} />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('场景预设')).toBeTruthy();
    });
    // 预设清单里的那一项要出现（证明 load() 走通、state 有值）
    expect(await screen.findByText('行程规划')).toBeTruthy();
  });
});

describe('ScenePresetsPage · 参数区按 module 显隐', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  /*
    这一组锁的是「填了不生效的输入框」。

    预案页的参数区曾经无条件渲染「价格说明 / 副标题显示来源表名」——
    那是 `travel.itinerary` 的专有参数。给「表单提交」也画出来，超管会
    改完保存、然后在预览里找不到任何变化，比不提供更糟（他会以为是自己改错了）。

    判据取 module 的 `params_schema`（声明了才渲染），所以这里用两个
    **声明了不同参数**的真 module 来验：行程规划有 price_note，
    表单提交有 receipt_title / receipt_no_label。
  */
  it('表单提交：显示回执文案字段，不显示查表参数', async () => {
    const scenes = await import('../api/scenes');
    vi.mocked(scenes.listScenePresets).mockResolvedValue([TOOL_SUBMIT_PRESET] as never);

    render(
      <I18nProvider>
        <ScenePresetsPage currentUser={{ id: 'u1', name: 'admin', role: 'admin' } as never} />
      </I18nProvider>,
    );

    /*
      标签文案取 module 的 `params_schema`，与定义器「回复用户」区块**逐字一致**。

      这里曾经断的是「回执标题」「单号字段名」—— 那两个词是本页自己编的。
      同一个 `receipt_no_label`，这边叫「单号字段名」（听起来像要填 `order_no`），
      定义器里叫「单号叫什么」（要填中文标签）。超管和员工互相以为对方改了
      另一个东西，而实际是同一个键。现在两处都读 schema。
    */
    await waitFor(() => expect(screen.getByText('结论句')).toBeTruthy());
    expect(screen.getByText('单号叫什么')).toBeTruthy();
    // 「哪个字段是单号」是技术映射，同样归 module 声明
    expect(screen.getByText('哪个字段是单号')).toBeTruthy();

    // 查表专有的两项不该出现
    expect(screen.queryByText('价格说明')).toBeNull();
    // 按钮文案同理（tool_submit 的卡上没有按钮）
    expect(screen.queryByText('主按钮文案')).toBeNull();
  });
});