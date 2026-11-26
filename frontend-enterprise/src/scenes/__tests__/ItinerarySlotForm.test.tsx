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
 * 这些断言锁的是**这个场景表单必须成立的行为**。
 *
 * 2026-11-26 之前人数/天数是分段按钮（1-8、3-7 平铺），测试按「8 颗 button」
 * 断言。用户要求「改成下拉选项，不要平铺，文字和选项在一行」之后，那两条
 * 断言随实现一起作废 —— 但**提交口径那一条（数字必须是 number）不能动**，
 * 它管的是后端 matcher 能不能认这个值，与控件长什么样无关。
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

describe('travel.itinerary 条件表单', () => {
  it('三个字段都是下拉，不再是平铺按钮或金额输入框', () => {
    render(<TravelItinerarySlotForm {...makeProps()} />);

    const people = screen.getByLabelText(/人数/) as HTMLSelectElement;
    expect(people.tagName).toBe('SELECT');
    // 1-8：八项候选 + 一项占位
    expect(people.querySelectorAll('option')).toHaveLength(9);

    const days = screen.getByLabelText(/天数/) as HTMLSelectElement;
    expect(days.tagName).toBe('SELECT');
    // 3-7：五项候选 + 一项占位
    expect(days.querySelectorAll('option')).toHaveLength(6);
    expect(days.textContent).toContain('5 天');

    const budget = screen.getByLabelText(/预算/) as HTMLSelectElement;
    expect(budget.tagName).toBe('SELECT');
    // 1k/2k/3k/4k/4k+：五项候选 + 一项占位
    expect(budget.querySelectorAll('option')).toHaveLength(6);

    // 原先那两颗「分段按钮组」和金额输入框必须彻底消失，
    // 否则同一个字段会出现两种控件
    expect(screen.queryByRole('group', { name: '人数' })).toBeNull();
    expect(screen.queryByRole('group', { name: '天数' })).toBeNull();
    expect(document.querySelector('input#itinerary-budget')).toBeNull();
    // 快选胶囊也没了
    expect(screen.queryByRole('button', { name: '3k' })).toBeNull();
  });

  it('预算下拉的选项是 1k/2k/3k/4k/4k+，提交的是数字不是「4k+」这串字', async () => {
    const submitSlots = vi.fn();
    render(<TravelItinerarySlotForm {...makeProps({ submitSlots })} />);

    const budget = screen.getByLabelText(/预算/) as HTMLSelectElement;
    const labels = Array.from(budget.querySelectorAll('option'))
      .map((option) => option.textContent);
    expect(labels.slice(1)).toEqual(['1k', '2k', '3k', '4k', '4k+']);

    await userEvent.selectOptions(screen.getByLabelText(/人数/), '4');
    await userEvent.selectOptions(screen.getByLabelText(/天数/), '5');
    // 「4k+」的显示文案是 4k+，提交值是 5000（产品决定，理由见组件里
    // SelectOption 注释：matcher 按绝对相对偏差排序，没有区间语义）
    await userEvent.selectOptions(budget, '5000');
    await userEvent.click(screen.getByRole('button', { name: '开始匹配' }));

    expect(submitSlots).toHaveBeenCalledWith({ people: 4, days: 5, budget: 5000 });
  });

  it('选固定档位时提交对应数字（3k → 3000）', async () => {
    const submitSlots = vi.fn();
    render(<TravelItinerarySlotForm {...makeProps({ submitSlots })} />);

    await userEvent.selectOptions(screen.getByLabelText(/人数/), '4');
    await userEvent.selectOptions(screen.getByLabelText(/天数/), '5');
    await userEvent.selectOptions(screen.getByLabelText(/预算/), '3000');
    await userEvent.click(screen.getByRole('button', { name: '开始匹配' }));

    // 数字必须是 number：字符串会被后端 `unit_by_slot` 判成不可转换然后丢掉
    expect(submitSlots).toHaveBeenCalledWith({ people: 4, days: 5, budget: 3000 });
  });

  it('下拉默认不预选任何值（占位项 disabled），避免看起来像已选', () => {
    render(<TravelItinerarySlotForm {...makeProps()} />);

    const people = screen.getByLabelText(/人数/) as HTMLSelectElement;
    expect(people.value).toBe('');
    const placeholder = people.querySelector('option[value=""]') as HTMLOptionElement;
    expect(placeholder.disabled).toBe(true);

    const budget = screen.getByLabelText(/预算/) as HTMLSelectElement;
    expect(budget.value).toBe('');
  });

  it('缺必填项时不提交，只标错', async () => {
    const submitSlots = vi.fn();
    render(<TravelItinerarySlotForm {...makeProps({ submitSlots })} />);

    await userEvent.click(screen.getByRole('button', { name: '开始匹配' }));

    expect(submitSlots).not.toHaveBeenCalled();
    expect(screen.getAllByText('请填写')).toHaveLength(3);
  });
});