// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { I18nProvider } from '@/i18n';
import { parseA2UIForm } from '@/pages/chat/chatHelpers';
import type { SceneSlot } from '@/api/scenes';

import {
  previewFormDataFor,
  SceneChipPreview,
  SceneFormPreview,
} from './ScenePreviewCard';

/**
 * 场景定义器右栏的三段预览。
 *
 * 这个文件存在的唯一理由是**防漂**：预览一旦和聊天里的真东西不一样，
 * 它就比没有更糟 —— 用户会照着预览配，配完发现不是那样。
 *
 * 三组护栏：
 *
 * 1. `previewFormDataFor()` 复刻后端的拼 label 规则。两份分叉的症状是
 *    「预览里『人数』、聊天里『人数（人）』」，几乎不可能靠肉眼发现；
 * 2. `SceneFormPreview` 必须用 **module 自己的 `SlotForm`**，不是通用
 *    `SlotFormCard`。行程场景在聊天里是三个下拉，预览若是三个输入框，
 *    用户改完槽位以为对了，进聊天发现完全不同；
 * 3. `SceneChipPreview` 的关键类名必须与 `SceneChips` 的 `CHIP_CLASS` 一致
 *    （视觉契约 §6）。胶囊是像素级的，圆角小 2px 都看得出来。
 */

// 这个仓库没开 `globals`，不手动 cleanup 会让上一条用例的 DOM 留在
// document 里 —— 下一条的 `getByRole` 直接报「找到多个」。
afterEach(cleanup);

/**
 * `SlotFormCard` 里的 `Input` 走 `useI18n()`，没有 Provider 会直接抛
 * `useI18n must be used inside I18nProvider` —— 那不是断言失败而是整块崩掉。
 */
function renderInI18n(node: ReactNode) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

const SLOTS: SceneSlot[] = [
  { key: 'people', label: '人数', type: 'number', unit: '人', required: true },
  { key: 'days', label: '天数', type: 'number', unit: '天', required: true },
  { key: 'budget', label: '预算', type: 'number', unit: '元', required: true },
];

describe('previewFormDataFor：复刻后端的表单描述', () => {
  it('把单位拼进 label，与后端 `人数（人）` 写法一致', () => {
    const data = previewFormDataFor(SLOTS, '滑雪行程推荐 · 请补充条件');
    expect(data).not.toBeNull();
    const fields = data?.fields as Array<{ name: string; label: string }>;
    expect(fields.map((field) => field.label)).toEqual([
      '人数（人）',
      '天数（天）',
      '预算（元）',
    ]);
  });

  it('label 自己已带括号时不再拼第二遍（后端同一条正则）', () => {
    const data = previewFormDataFor(
      [{ key: 'people', label: '人数（成人）', unit: '人', required: true }],
      '标题',
    );
    const fields = data?.fields as Array<{ label: string }>;
    // 拼第二遍会变成「人数（成人）（人）」—— 括号嵌套、明显难看，
    // 但因为只在「label 手写了括号」时才出现，很容易漏测。
    expect(fields[0].label).toBe('人数（成人）');
  });

  it('带出 `unit` 键：定制 module 靠它认金额字段', () => {
    const data = previewFormDataFor(SLOTS, '标题');
    const fields = data?.fields as Array<{ name: string; unit?: string }>;
    const budget = fields.find((field) => field.name === 'budget');
    // `ItinerarySlotForm.isMoneyField()` 判 `field.unit === '元'`。
    // 少了这个键，预览里预算会退化成文本框，而聊天里是下拉。
    expect(budget?.unit).toBe('元');
  });

  it('label 为空时回落到 key（不让预览出现空标签）', () => {
    const data = previewFormDataFor([{ key: 'people', required: true }], '标题');
    const fields = data?.fields as Array<{ label: string }>;
    expect(fields[0].label).toBe('people');
  });

  it('没有槽位时返回 null（上层据此显示「还没配槽位」）', () => {
    expect(previewFormDataFor([], '标题')).toBeNull();
    // key 是空白的槽位不算 —— 它在提交时会被后端丢掉。
    expect(previewFormDataFor([{ key: '   ', label: '空' }], '标题')).toBeNull();
  });

  it('`kind` 必须是 `slot_form`：`parseA2UIForm` 的准入条件', () => {
    const data = previewFormDataFor(SLOTS, '标题');
    // 写成 `form` 会让解析直接返回 null，而那个 null 会显示成
    // 「还没有配槽位」—— 明明配了三个，界面说没配。
    expect(data?.kind).toBe('slot_form');
    // 这条断言与上一行是同一件事的两种证明：消费方真的能把它解析出来。
    expect(parseA2UIForm(data)).not.toBeNull();
  });
});

describe('SceneFormPreview：必须用 module 自己的表单', () => {
  it('行程场景渲染出三个下拉 —— 与聊天里同一张表', async () => {
    const { container } = renderInI18n(
      <SceneFormPreview
        moduleKey="travel.itinerary"
        slots={SLOTS}
        title="滑雪行程推荐 · 请补充条件"
        subtitle="填好这几项，我按方案表逐条比对"
        showCaption={false}
      />,
    );

    // module chunk 是动态 import，要等它 resolve。
    await waitFor(() => {
      expect(container.querySelectorAll('select')).toHaveLength(3);
    });

    /*
      ⚠️ 这一条是**整个文件里最重要的一条**。

      预览曾经无条件用 `SlotFormCard`，于是行程场景在定义器里是三个
      `input[type=number]`，在聊天里是三个原生 `select`（用户 2026-11-26
      刚要求改成下拉）。同一份槽位配置、两处长得完全不一样 ——
      而预览的全部价值就是「所见即所得」。

      断言取 `tagName === 'INPUT'` 而不是 `querySelector('input')` 非空：
      下拉内部也可能有 input 类的包装，写成「有 input 就不对」会误伤。
    */
    const budgetInput = container.querySelector('input#itinerary-budget');
    expect(budgetInput).toBeNull();
    // 预算选项显示 `4k+`，提交值另算 —— 只断言显示文案在这里足够，
    // 提交语义由 `ItinerarySlotForm.test.tsx` 锁。
    expect(screen.getByText('4k+')).toBeTruthy();
  });

  it('表单提交场景回落通用表单（module 没实现自己的 SlotForm 之外的路径）', async () => {
    const { container } = renderInI18n(
      <SceneFormPreview
        moduleKey="generic.tool_submit"
        slots={[
          { key: 'room_no', label: '房间号', type: 'text', required: true },
          { key: 'item', label: '物品', type: 'text', required: true },
        ]}
        title="请填写下面的信息"
        showCaption={false}
      />,
    );

    // `generic.tool_submit` 的 SlotForm 走 `renderForm` → `SlotFormCard`。
    // 预览里没有聊天容器，`renderForm` 未注入，所以这里断言的是兜底那条路：
    // 至少要把字段画出来，不能空白。
    await waitFor(() => {
      expect(container.querySelector('#a2ui-room_no')).toBeTruthy();
    });
    // 标签带单位拼装规则对这个 module 同样生效（字段本身没单位，保持原样）。
    expect(screen.getByText('房间号')).toBeTruthy();
  });

  it('没有槽位时给出可行动的说明，不是空白', () => {
    renderInI18n(
      <SceneFormPreview
        moduleKey="travel.itinerary"
        slots={[]}
        title="标题"
        showCaption={false}
      />,
    );
    expect(screen.getByText(/还没有配槽位/)).toBeTruthy();
  });
});

describe('SceneChipPreview：类名必须与 SceneChips 一致', () => {
  it('圆角 full + 契约描边 + 11.5px 字号', () => {
    const { container } = render(
      <SceneChipPreview icon="🎿" label="滑雪行程推荐" showCaption={false} />,
    );
    const chip = container.querySelector('[data-preview-chip]');
    expect(chip).not.toBeNull();
    const className = chip?.className ?? '';

    /*
      `SceneChips.tsx` 的 `CHIP_CLASS`（视觉契约 §6）逐值：
        rounded-full border border-[#ded7cc] bg-white
        px-[11px] py-[5px] text-[11.5px] text-[#343633]

      这里断言的是**这些值本身**，而不是「和 SceneChips 的常量相等」——
      那个常量没有导出。所以宁可把契约值抄进测试：改契约时测试会红，
      强制回来同步两处。抄一份常量到测试里是「防漂」的最低成本做法。
    */
    for (const token of [
      'rounded-full',
      'border-[#ded7cc]',
      'bg-white',
      'px-[11px]',
      'py-[5px]',
      'text-[11.5px]',
      'text-[#343633]',
    ]) {
      expect(className).toContain(token);
    }
  });

  it('场景名为空时显示占位，不渲染成一颗空胶囊', () => {
    render(<SceneChipPreview label="   " showCaption={false} />);
    expect(screen.getByText('这个场景')).toBeTruthy();
  });

  it('没配图标时不画图标位（空串不是「用默认 emoji」）', () => {
    const { container } = render(<SceneChipPreview label="报修" showCaption={false} />);
    const chip = container.querySelector('[data-preview-chip]');
    // `SceneChips` 的规则：`chip.icon && <span>`。空串 = 不画。
    // 回落到某个默认 emoji 会让「我没配图标」变成「配了个别的」。
    expect(chip?.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});