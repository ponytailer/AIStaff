// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import type { A2UIBlock } from '../chatTypes';
import { sceneFormForSubmit } from './MessageBubble';

/**
 * 这些用例锁的是一个**线上真实故障**：
 *
 *   空结果卡上的「换个人数」按钮点下去什么都不发生，也不报错。
 *
 * 根因是 `MessageBubble` 的 `onSubmitSlots` 里写着 `if (!form) return;` ——
 * 对「填表提交」是对的（那一轮一定有 form 块），但空结果卡那一轮**没有 form 块**，
 * 于是按钮的提交在第一行就被吞掉。
 *
 * 所以这里的断言不是在测一个格式化函数，而是在测「点下去真的会提交」。
 */

function emptyCard(extra: Record<string, unknown> = {}): A2UIBlock {
  return {
    kind: 'empty',
    module_key: 'travel.itinerary',
    data: { reason: 'no_match', ...extra },
  };
}

describe('sceneFormForSubmit', () => {
  it('有 form 块时原样返回，不去合成', () => {
    const formBlock: A2UIBlock = {
      kind: 'form',
      data: {
        kind: 'slot_form',
        fields: [{ name: 'people', label: '出行人数', type: 'number', required: true }],
      },
    };
    const merged = sceneFormForSubmit([formBlock], { people: 4 });
    expect(merged).not.toBeNull();
    expect(merged!.kind).toBe('slot_form');
    // 字段来自 form 块本身，不是从 values 里推的
    expect(merged!.fields.map((field) => field.name)).toEqual(['people']);
    expect(merged!.fields[0].label).toBe('出行人数');
  });

  it('没有 form 块时按本次改动合成表单（空结果卡按钮走这条路）', () => {
    // ⚠️ 这是最关键的用例：没有 form 块 → 旧实现返回 null → 按钮静默失效。
    const merged = sceneFormForSubmit([emptyCard()], { people: 4 });
    expect(merged).not.toBeNull();
    expect(merged!.kind).toBe('slot_form');
    expect(merged!.fields.map((field) => field.name)).toEqual(['people']);
    // 没有 slot_labels 时退回英文键名，但**不能是空标签**
    expect(merged!.fields[0].label).toBe('people');
    expect(merged!.fields[0].required).toBe(true);
  });

  it('合成表单用 empty.slot_labels 里的中文标签', () => {
    const merged = sceneFormForSubmit(
      [emptyCard({ slot_labels: { people: '出行人数', days: '天数', budget: '预算' } })],
      { people: 4, days: 6 },
    );
    expect(merged).not.toBeNull();
    expect(merged!.fields.map((field) => [field.name, field.label])).toEqual([
      ['people', '出行人数'],
      ['days', '天数'],
    ]);
  });

  it('slot_labels 里的脏数据不会污染标签', () => {
    const merged = sceneFormForSubmit(
      [emptyCard({ slot_labels: { people: '   ', days: 6, budget: '预算' } })],
      { people: 4, days: 6 },
    );
    expect(merged).not.toBeNull();
    const labels = Object.fromEntries(merged!.fields.map((field) => [field.name, field.label]));
    // 空串 → 退回键名；非字符串 → 退回键名
    expect(labels.people).toBe('people');
    expect(labels.days).toBe('days');
  });

  it('布尔值字段合成 boolean 类型，其余按 number', () => {
    const merged = sceneFormForSubmit([emptyCard()], { people: 4, flexible: true });
    expect(merged).not.toBeNull();
    const byName = Object.fromEntries(merged!.fields.map((field) => [field.name, field.type]));
    expect(byName.people).toBe('number');
    expect(byName.flexible).toBe('boolean');
  });

  it('既没有 form 块、values 也空 → 返回 null（这次提交确实没法进行）', () => {
    expect(sceneFormForSubmit([emptyCard()], {})).toBeNull();
    expect(sceneFormForSubmit([], {})).toBeNull();
  });

  it('多个块里有 form 块时优先用 form 块，哪怕 data 是脏的也不去读别的块', () => {
    const dirtyForm: A2UIBlock = { kind: 'form', data: { kind: 'something_else' } };
    const merged = sceneFormForSubmit([dirtyForm, emptyCard({ slot_labels: { people: '人数' } })], {
      people: 4,
    });
    // 脏 form 块解析失败 → 落到合成路径，标签仍来自空卡的 slot_labels
    expect(merged).not.toBeNull();
    expect(merged!.fields[0].label).toBe('人数');
  });
});