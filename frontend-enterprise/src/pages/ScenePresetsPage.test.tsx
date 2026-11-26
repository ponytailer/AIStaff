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