// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TravelItinerarySlotForm } from '../modules/travel.itinerary/ItinerarySlotForm';
import type { SceneBlockProps, SceneUiBlock } from '../types';

// 这个仓库没有开启 `globals` 自动 cleanup，不手动清会让上一个用例的 DOM
// 留在 document 里 —— 第二个用例的 `getByRole` 直接报「找到多个」。
afterEach(cleanup);

/**
 * 这三个断言锁的是**与 `docs/scenes/scene-demo.html` 对齐的行为**。
 *
 * 用户明确要求「胶囊点开后交互以 demo 为准」，而 demo 的关键差异就在于：
 * 人数/天数是分段按钮、预算有快选、提交出去的数字是 number。这些都是
 * 「看起来像」和「真的对」之间的差别 —— 比如数字变成字符串时后端 matcher
 * 会把这个值判成不可转换然后静默丢掉，界面上一模一样。
 */

function makeProps(overrides: Partial<SceneBlockProps> = {}): SceneBlockProps {
  const block: SceneUiBlock = {
    kind: 'form',
    module_key: 'travel.itinerary',
    data: {
      title: '滑雪行程推荐 · 请补充条件',
      submit_label: '开始匹配',
      fields: [
        { name: 'people', label: '人数', type: 'number', unit: '人', required: true },
        { name: 'days', label: '天数', type: 'number', unit: '天', required: true },
        { name: 'budget', label: '预算', type: 'number', unit: '元', required: true },
      ],
    },
  };
  return {
    block,
    siblings: [block],
    params: {},
    sendText: vi.fn(),
    submitSlots: vi.fn(),
    openExternal: vi.fn(),
    ...overrides,
  };
}

describe('travel.itinerary 条件表单（对齐 scene-demo.html）', () => {
  it('人数/天数是分段按钮，不是数字输入框', () => {
    render(<TravelItinerarySlotForm {...makeProps()} />);

    // 1-8 的人数是 8 颗按钮；它们不是 input[type=number]
    const peopleGroup = screen.getByRole('group', { name: '人数' });
    expect(peopleGroup.querySelectorAll('button')).toHaveLength(8);
    expect(peopleGroup.querySelector('input')).toBeNull();

    const daysGroup = screen.getByRole('group', { name: '天数' });
    expect(daysGroup.querySelectorAll('button')).toHaveLength(5);
    expect(daysGroup.textContent).toContain('5 天');
  });

  it('点分段按钮后 aria-pressed 反白，且选中值进提交载荷', async () => {
    const submitSlots = vi.fn();
    render(<TravelItinerarySlotForm {...makeProps({ submitSlots })} />);

    await userEvent.click(screen.getByRole('button', { name: '4' }));
    // 用原生属性断言而不是 `toHaveAttribute`：本仓库没有装 jest-dom 匹配器
    expect(screen.getByRole('button', { name: '4' }).getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(screen.getByRole('button', { name: '5 天' }));
    await userEvent.click(screen.getByRole('button', { name: '3k' }));
    await userEvent.click(screen.getByRole('button', { name: '开始匹配' }));

    expect(submitSlots).toHaveBeenCalledTimes(1);
    // 数字必须是 number：字符串会被后端 `unit_by_slot` 判成不可转换然后丢掉
    expect(submitSlots).toHaveBeenCalledWith({ people: 4, days: 5, budget: 3000 });
  });

  it('缺必填项时不提交，只标错', async () => {
    const submitSlots = vi.fn();
    render(<TravelItinerarySlotForm {...makeProps({ submitSlots })} />);

    await userEvent.click(screen.getByRole('button', { name: '开始匹配' }));

    expect(submitSlots).not.toHaveBeenCalled();
    expect(screen.getAllByText('请填写')).toHaveLength(3);
  });
});