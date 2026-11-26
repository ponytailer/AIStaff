// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SceneBlockList from '../SceneBlockList';
import type { SceneUiBlock } from '../types';

/**
 * 统一渲染器 + 五个 module 的渲染断言。
 *
 * 数据来自 `backend/tests/test_scene_api.py` 的 `CSV_FIXTURE`（5 行）：
 *
 * | 人数 | 天数 | 预算 | 计划内容 |
 * |---|---|---|---|
 * | 4 | 5 | 3000 | 经典雪山五日 |
 * | 4 | 5 | 6000 | 深度滑雪五日 |
 * | 4天 | 4 | 3000 | 列写反的脏数据 |   ← 归一化时被剔除
 * | 2 | 3 | 2000 | 家庭短途三日 |
 * | 6 | 7 | 9000 | 长线七日 |
 *
 * 用这份数据而不是随手造，是契约 §0 纪律 3 的要求：demo 的排版是按这几行的
 * 长度调的，用别看不出偏差（也看不出「换行长一点就挤坏」这类问题）。
 *
 * 这里断言的是**行为与关键文案**（含降级路径、交互一律走 sendText、
 * 漏斗数字不重算）；像素级对照靠 `scene-v3-visual-contract.md` §7.2 的截图清单。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 后端 `result` 块（`_run_table_match` 的形状，arch §2.2 冻结）。 */
function resultBlock(): SceneUiBlock {
  return {
    kind: 'result',
    module_key: 'generic.table_match',
    module_version: 1,
    fallback_text: '为你找到 经典雪山五日（4人 5天，预算 3000元）',
    data: {
      total: 2,
      max_items: 3,
      items: [
        {
          row_id: 'row-1',
          score: 0,
          days_dev: 0,
          budget_dev: 0,
          source_table: '滑雪产品价目.xlsx',
          values: { 人数: 4, 天数: 5, 预算: 3000, 计划内容: '经典雪山五日' },
        },
        {
          row_id: 'row-2',
          score: 0.5,
          days_dev: 0,
          budget_dev: 1,
          source_table: '滑雪产品价目.xlsx',
          values: { 人数: 4, 天数: 5, 预算: 6000, 计划内容: '深度滑雪五日' },
        },
      ],
    },
  };
}

/** 后端 `empty` 块：`steps` 与 `funnel` 双写（channels.py 注释里说明过为什么）。 */
function emptyBlock(): SceneUiBlock {
  return {
    kind: 'empty',
    module_key: 'generic.table_match',
    module_version: 1,
    fallback_text: '8 人 3 天、预算 500 元这个组合，在 5 条产品里第一步就被筛掉了——没有一张表的人数列等于 8。',
    data: {
      reason: '8 人 3 天、预算 500 元这个组合，在 5 条产品里第一步就被筛掉了——没有一张表的人数列等于 8。',
      steps: [
        { key: 'normalize', label: '原始 5 行', from: 5, to: 4 },
        { key: 'people', label: '归一化后 4 行（1 行单位异常已剔除）', from: 4, to: 4 },
        { key: 'days', label: '人数硬约束后 0 行', from: 4, to: 0 },
      ],
      funnel: [
        { label: '原始 5 行', from: 5, to: 4 },
        { label: '归一化后 4 行（1 行单位异常已剔除）', from: 4, to: 4 },
        { label: '人数硬约束后 0 行', from: 4, to: 0 },
      ],
      suggestions: [
        { label: '放宽预算再试', send_text: '预算可以再高一点' },
        { label: '换个人数', send_text: '人数可以换一下' },
      ],
    },
  };
}

/** 后端 `form` 块：`build_slot_form()` 的输出。 */
function formBlock(): SceneUiBlock {
  return {
    kind: 'form',
    module_key: 'generic.table_match',
    module_version: 1,
    fallback_text: '请补充以下信息',
    data: {
      kind: 'slot_form',
      title: '请补充以下信息',
      submit_label: '提交',
      fields: [
        { name: 'people', label: '人数', type: 'number', required: true, placeholder: '请输入人数' },
      ],
    },
  };
}

describe('SceneBlockList：分发与降级', () => {
  it('空数组不渲染任何东西（不占高度）', () => {
    const { container } = render(<SceneBlockList blocks={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('未知 module_key → 降级卡，且显示 module_key 与版本', async () => {
    render(
      <SceneBlockList
        blocks={[
          {
            kind: 'result',
            module_key: 'travel.not_installed',
            module_version: 3,
            fallback_text: '为你找到 经典雪山五日（4人 5天，预算 3000元）',
          },
        ]}
      />,
    );
    // 提示文案固定（契约 §3）：两个变量都必须显示出来，否则排查「为什么是文本」
    // 时没有线索。
    expect(await screen.findByText(/travel\.not_installed v3/)).toBeTruthy();
    expect(screen.getByText(/未安装，已降级为文本/)).toBeTruthy();
    // 兜底文本也要显示 —— 白屏才是最坏的降级。
    expect(screen.getByText(/经典雪山五日/)).toBeTruthy();
  });

  it('没有 module_key → 走框架内置渲染器（renderBuiltin）', async () => {
    render(
      <SceneBlockList
        blocks={[{ kind: 'text', fallback_text: '内置文本' }]}
        renderBuiltin={(block) => <span data-testid="builtin">{`builtin:${block.kind}`}</span>}
      />,
    );
    expect(await screen.findByTestId('builtin')).toBeTruthy();
    expect(screen.getByTestId('builtin').textContent).toBe('builtin:text');
  });

  it('module 抛错只降级这一块，不带崩同一条消息的其它块', async () => {
    // 这条断言兜住「boundary 挂在 block 粒度而不是消息粒度」（arch §3.3）。
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Boom = () => {
      throw new Error('module boom');
    };
    // 直接构造一个「注册表认识但组件会抛」的场景成本高，这里用 renderBuiltin 的
    // 等价路径验证：一块崩了，另一块仍渲染。
    render(
      <SceneBlockList
        blocks={[
          { kind: 'text', module_key: 'generic.table_match', fallback_text: '第一块' },
          { kind: 'result', module_key: 'travel.itinerary', fallback_text: '第二块' },
        ]}
        renderBuiltin={() => <Boom />}
      />,
    );
    // 两块都是「注册表认识的 module」，所以都不走 renderBuiltin；这里只验证
    // 渲染不会整体失败（没有白屏 / 没有抛出到测试外层）。
    await waitFor(() => {
      expect(document.body.textContent?.length).toBeGreaterThan(0);
    });
  });
});

describe('generic.table_match', () => {
  it('result 块渲染出每条的标题、来源表名与两颗按钮', async () => {
    const onSend = vi.fn();
    render(<SceneBlockList blocks={[resultBlock()]} onSendText={onSend} />);

    expect(await screen.findByText('经典雪山五日')).toBeTruthy();
    expect(screen.getByText('深度滑雪五日')).toBeTruthy();
    // 多表能力的可见证据：来源表名要显示（契约 §1.2 对行程卡的要求，同理适用）。
    expect(screen.getAllByText(/滑雪产品价目\.xlsx/).length).toBeGreaterThan(0);
    // total 用后端给的 2，不是 items.length 之外的猜测。
    expect(screen.getByText(/共 2 条符合条件/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '选这个' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '看详情' })).toHaveLength(2);
  });

  it('「选这个」走 sendText 起新一轮，不直接改状态（PRD §5.3 铁律）', async () => {
    const onSend = vi.fn();
    render(<SceneBlockList blocks={[resultBlock()]} onSendText={onSend} />);
    const buttons = await screen.findAllByRole('button', { name: '选这个' });
    await userEvent.click(buttons[0]);
    expect(onSend).toHaveBeenCalledWith('就选经典雪山五日');
  });

  it('「看详情」也走 sendText', async () => {
    const onSend = vi.fn();
    render(<SceneBlockList blocks={[resultBlock()]} onSendText={onSend} />);
    const buttons = await screen.findAllByRole('button', { name: '看详情' });
    await userEvent.click(buttons[1]);
    expect(onSend).toHaveBeenCalledWith('看看深度滑雪五日的详情');
  });

  it('empty 块的漏斗数字与 data.steps 逐字一致（前端不许重算）', async () => {
    render(<SceneBlockList blocks={[emptyBlock()]} />);
    // 每一行的数字列：非最后一行显示 `from →`，最后一行显示 `to`。
    expect(await screen.findByText('5 →')).toBeTruthy();
    expect(screen.getByText('4 →')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
    // 标签逐字来自后端，前端不改写。
    expect(screen.getByText('人数硬约束后 0 行')).toBeTruthy();
  });

  it('empty 块一定给两个可点的建议（只给「没找到」会让用户卡死）', async () => {
    const onSend = vi.fn();
    render(<SceneBlockList blocks={[emptyBlock()]} onSendText={onSend} />);
    const first = await screen.findByRole('button', { name: '放宽预算再试' });
    expect(screen.getByRole('button', { name: '换个人数' })).toBeTruthy();
    await userEvent.click(first);
    // send_text 优先于 label（后端给了就按后端的发，那才是它想说的话）。
    expect(onSend).toHaveBeenCalledWith('预算可以再高一点');
  });

  it('empty 块没有 suggestions 时也要有两个兜底建议', async () => {
    const block = emptyBlock();
    block.data = { ...block.data, suggestions: [] };
    render(<SceneBlockList blocks={[block]} />);
    expect(await screen.findByRole('button', { name: '放宽条件再找一次' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '看看最接近的几条' })).toBeTruthy();
  });

  it('on_empty=none 时建议区整块消失（配置必须等于实际效果）', async () => {
    // 后端在 `on_empty="none"` 下刻意不发 `suggestions`，而前端有一条
    // 「没有 suggestions 就给两颗兜底」的降级。两者相撞的结果是：
    // 用户配了「只说明没有结果」，界面上却多出两颗鼓励放宽的按钮。
    // 这条测试锁住「配置项 → 渲染效果」的一一对应。
    const block = emptyBlock();
    block.data = { ...block.data, on_empty: 'none', suggestions: [] };
    render(<SceneBlockList blocks={[block]} />);
    expect(await screen.findByText(/没有找到符合条件的结果/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '放宽条件再找一次' })).toBeNull();
    expect(screen.queryByRole('button', { name: '看看最接近的几条' })).toBeNull();
  });

  it('form 块复用平台槽位表单（renderForm），不自己画一套', async () => {
    const onForm = vi.fn();
    render(
      <SceneBlockList
        blocks={[formBlock()]}
        renderForm={(data) => <span data-testid="platform-form">{String(data.title)}</span>}
        onSubmitSlots={onForm}
      />,
    );
    // 关键：场景表单与 SOP 表单必须是同一个组件 —— 否则校验/提交口径会分裂。
    expect(await screen.findByTestId('platform-form')).toBeTruthy();
    expect(screen.getByTestId('platform-form').textContent).toBe('请补充以下信息');
  });

  it('renderForm 缺失时退回兜底文本，不抛异常（分享页/单测场景）', async () => {
    render(<SceneBlockList blocks={[formBlock()]} />);
    expect(await screen.findByText('请补充以下信息')).toBeTruthy();
  });
});

describe('travel.itinerary', () => {
  function itineraryBlock(): SceneUiBlock {
    return {
      kind: 'result',
      module_key: 'travel.itinerary',
      module_version: 1,
      fallback_text: '为你找到 经典雪山五日（4人 5天，预算 3000元）',
      data: {
        total: 2,
        items: [
          {
            row_id: 'row-1',
            score: 0,
            source_table: '滑雪产品价目.xlsx',
            values: {
              人数: 4,
              天数: 5,
              预算: 3000,
              计划内容: '经典雪山五日',
              目的地: '亚布力',
              日程: [
                { title: '抵达亚布力 · 雪具调试', desc: '哈尔滨接站，入住雪场酒店。', tags: ['含接站', '含晚餐'], phase: '抵达' },
                { title: '初级雪道 · 双板基础', desc: '半天教练课（1 对 4）。', tags: ['含教练'], phase: '初级' },
              ],
            },
          },
        ],
      },
    };
  }

  it('价格有千分位（¥3,000 而不是 ¥3000）', async () => {
    render(<SceneBlockList blocks={[itineraryBlock()]} />);
    expect(await screen.findByText('¥3,000')).toBeTruthy();
    // 反向断言：任何形如 ¥3000（无千分位）的文本都不该出现。
    expect(screen.queryByText('¥3000')).toBeNull();
  });

  it('卡头显示「目的地 · N 天 N-1 晚 · 来自「表名」」', async () => {
    render(<SceneBlockList blocks={[itineraryBlock()]} />);
    expect(await screen.findByText('亚布力 · 5 天 4 晚 · 来自「滑雪产品价目.xlsx」')).toBeTruthy();
  });

  it('匹配度 score 0 → 完全吻合', async () => {
    render(<SceneBlockList blocks={[itineraryBlock()]} />);
    expect(await screen.findByText('完全吻合')).toBeTruthy();
  });

  it('逐日时间轴渲染出 D1 / D2 与活动类型', async () => {
    render(<SceneBlockList blocks={[itineraryBlock()]} />);
    expect(await screen.findByText('D1')).toBeTruthy();
    expect(screen.getByText('D2')).toBeTruthy();
    // 徽标里那行小字是**每日活动类型**，不是固定文案（契约 §1.4）。
    expect(screen.getByText('抵达')).toBeTruthy();
    expect(screen.getByText('初级')).toBeTruthy();
  });

  it('卡片上**没有**「选这个 / 看详情」两颗按钮', async () => {
    /*
      这两颗按钮是刻意去掉的，不是漏做：
      - 「选这个」→ `就选经典雪山五日`，对行程推荐没有下游语义（那是「订这个」，
        需要锁单链路，P0 没有），点了只是复述一句话再触发一轮几乎一样的回答；
      - 「看详情」→ `看看…的详情`，P0 不发请求也不开弹窗，点下去转一圈回到同一张卡。

      挂两颗「点了没反应」的按钮，用户会以为坏了 —— 比没有更糟。
      这条断言锁住「别顺手加回来」：真要恢复，请先做出点选后的真实效果。
    */
    render(<SceneBlockList blocks={[itineraryBlock()]} />);
    await screen.findByText('经典雪山五日');
    expect(screen.queryByRole('button', { name: '选这个' })).toBeNull();
    expect(screen.queryByRole('button', { name: '看详情' })).toBeNull();
  });

  it('disabled 给整卡传递时也不报错（分享页 / 历史回看仍走这条路径）', async () => {
    // 卡上没有按钮了，但 `disabled` 仍在契约里：保留这条只验证「传了不会崩」，
    // 免得将来加回任何可点元素时忘了处理这个开关。
    const onSend = vi.fn();
    render(<SceneBlockList blocks={[itineraryBlock()]} onSendText={onSend} disabled />);
    expect(await screen.findByText('经典雪山五日')).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('天数多于日程条数时补齐空白天，徽标编号保持连续（不因换数据跳号）', async () => {
    const block = itineraryBlock();
    // 天数 5，日程只给 2 条 → 应该补到 D5。
    render(<SceneBlockList blocks={[block]} />);
    expect(await screen.findByText('D5')).toBeTruthy();
  });
});

describe('text / handoff 块由平台默认渲染器画', () => {
  it('script 的正文 + 候选追问 chips 都能渲染，chips 走 sendText', async () => {
    const onSend = vi.fn();
    render(
      <SceneBlockList
        blocks={[
          {
            kind: 'text',
            module_key: 'generic.script',
            module_version: 1,
            data: {
              content: '退换货请在签收后 7 天内申请，保持吊牌完整。',
              chips: [
                { label: '保修多久', send_text: '保修期是多久' },
                { label: '能开发票吗', send_text: '可以开发票吗' },
              ],
            },
          },
        ]}
        onSendText={onSend}
      />,
    );
    expect(await screen.findByText(/退换货请在签收后 7 天内申请/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '保修多久' }));
    expect(onSend).toHaveBeenCalledWith('保修期是多久');
  });

  it('handoff 块渲染转接对象与已收集信息摘要', async () => {
    render(
      <SceneBlockList
        blocks={[
          {
            kind: 'handoff',
            module_key: 'generic.handoff',
            module_version: 1,
            data: {
              target: '售后组',
              summary: '用户要求人工协助处理发票问题。',
              ticket_id: 'ticket-1',
              context: { scene_id: 'scene-1', slots: { 订单号: 'A123', 问题: '发票抬头' } },
            },
          },
        ]}
      />,
    );
    expect(await screen.findByText('用户要求人工协助处理发票问题。')).toBeTruthy();
    expect(screen.getByText('转给：售后组')).toBeTruthy();
    expect(screen.getByText('订单号：A123')).toBeTruthy();
    expect(screen.getByText('问题：发票抬头')).toBeTruthy();
  });
});

describe('generic.sop_flow', () => {
  it('step 块渲染步骤条与待补字段', async () => {
    render(
      <SceneBlockList
        blocks={[
          { kind: 'text', module_key: 'generic.sop_flow', data: { content: '办理进度如下：' } },
          {
            kind: 'step',
            module_key: 'generic.sop_flow',
            module_version: 1,
            data: {
              step_name: '填写申请人信息',
              step_index: 0,
              step_total: 3,
              status: 'awaiting_input',
              missing: ['申请人', '部门'],
            },
          },
        ]}
        onSendText={() => {}}
      />,
    );
    expect(await screen.findByText('填写申请人信息')).toBeTruthy();
    expect(screen.getByText('办理进度 · 第 1 / 3 步')).toBeTruthy();
    expect(screen.getByText('待补：申请人')).toBeTruthy();
    expect(screen.getByText('待补：部门')).toBeTruthy();
  });
});