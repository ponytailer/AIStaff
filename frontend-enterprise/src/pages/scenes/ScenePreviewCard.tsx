import { useEffect, useMemo, useState } from 'react';

import { loadSceneModule } from '@/scenes/registry';
import type { SceneModule, SceneUiBlock } from '@/scenes/types';

/**
 * 「命中后回答」的只读预览：用**真实的 module 卡片**渲染一份样例数据。
 *
 * ## 为什么不是一张示意图
 *
 * 用户要判断的是「我这个场景长什么样」。画一张示意图就等于 Demo 一个样、
 * 实际另一个样 —— 正是本项目明确要避免的事（视觉契约 §0 第 3 条：
 * 每个 module 完成后用同一份数据对照）。所以这里 `lazy` 加载真组件、
 * 喂真形状的 block，渲染结果与聊天里一致。
 *
 * ## 为什么不传 `sendText`
 *
 * 预览态下点「选这个」不该发消息。`sendText` 传空函数即可 —— module 的铁律是
 * 「所有交互都归到 sendText」，但没人规定它必须真的发出去。传一个 no-op 比
 * 传 `undefined` 安全：后者会让 module 里的 `sendText(...)` 直接抛 TypeError。
 *
 * ## 为什么从 `SceneEditor` 里搬出来
 *
 * 场景管理页的检查器右列也要画同一个预览（`scene-manager-demo.html`
 * `.insp-col` 第二节）。两边各写一份的话，一处改了 module 契约、
 * 另一处就会静默停在旧形状 —— 而预览恰恰是「不许漂」的那部分。
 */

/**
 * 预览用的样例数据 —— **按场景类型给不同形状**。
 *
 * ## 为什么不能只有一份
 *
 * 原先是写死的行程样例（经典雪山五日 / 亚布力 / 4 人 / 5 天 / 3000）。
 * 用户建「客房送物」时看到的也是这份数据：回执卡上写着「亚布力」「4 人」
 * 「3000」，既不是他的业务、也判断不了自己配的话术对不对 ——
 * 「预览」本该回答「我配完是什么样」，一份与配置无关的样例提供不了这个答案。
 *
 * 现在按 `module_key` 分派：行程给行程样例，表单提交给一张**通用回执**
 * （字段名用 `labels` 里的中文，值用中性占位）。认不出的类型回落到行程
 * —— 那是目前视觉契约的唯一基准，至少能看出卡片家族长什么样。
 */

/** 行程推荐的样例（`travel.itinerary`）。形状严格按 arch §2.2 的 `kind=result` 契约。 */
const ITINERARY_BLOCK: SceneUiBlock = {
  kind: 'result',
  module_key: '',
  module_version: 0,
  fallback_text: '',
  data: {
    total: 1,
    max_items: 1,
    items: [
      {
        row_id: 'preview-1',
        score: 0,
        source_table: '滑雪套餐价目表',
        values: {
          计划内容: '经典雪山五日',
          目的地: '亚布力',
          人数: 4,
          天数: 5,
          预算: 3000,
          日程: [
            { title: '抵达亚布力', description: '哈尔滨接站，入住雪场酒店。', tags: ['含接站', '含晚餐'], phase: '抵达' },
            { title: '初级道练习', description: '上午教练带练，下午自由滑。', tags: ['含雪票', '含教练'], phase: '初级' },
            { title: '进阶训练', description: '中级道压弯与回转技巧。', tags: ['含教练'], phase: '进阶' },
            { title: '自由滑行', description: '全天自由安排，可选雪地摩托。', tags: ['自由活动'], phase: '自由' },
            { title: '返程', description: '早餐后送站。', tags: ['含送站'], phase: '返程' },
          ],
        },
      },
    ],
  },
};

/**
 * 表单提交的样例（`generic.tool_submit`）。
 *
 * 字段刻意用**场景配的槽位 label**（调用方传 `params` 时一并传 `slotLabels`），
 * 这样「我配的字段会怎么显示」能直接看出来。没有槽位信息时用一组中性占位。
 *
 * `data.labels` 一起给：回执卡靠它把英文 key 翻成中文，预览里也得有，
 * 否则用户看到的是 `order_no`、`eta_minutes`，跟他配的中文名对不上。
 */
function toolSubmitBlock(overrides?: {
  title?: string;
  subtitle?: string;
  noField?: string;
  slotLabels?: Record<string, string>;
}): SceneUiBlock {
  const labels = overrides?.slotLabels ?? {};
  const values: Record<string, unknown> = {
    // 单号字段：用户配了就用他的，否则给一个「像单号」的占位
    [overrides?.noField || 'order_no']: 'RD20261126001',
  };
  // 槽位字段：有 label 的按 label 出，没配则给两个通用占位
  const slotEntries = Object.entries(labels);
  if (slotEntries.length > 0) {
    for (const [key, label] of slotEntries) {
      if (key === (overrides?.noField || 'order_no')) continue;
      values[key] = `示例${label}`;
    }
  } else {
    values.item = '示例物品';
    values.quantity = 2;
  }

  return {
    kind: 'result',
    module_key: '',
    module_version: 0,
    fallback_text: '',
    data: {
      total: 1,
      max_items: 1,
      items: [{ row_id: 'preview-1', score: 0, source_table: '', values }],
      // 回执卡读块级 labels 做中文名。这里把「单号字段」也补上中文名，
      // 否则预览里单号那一行的标签会退回英文 key。
      labels: {
        ...labels,
        [overrides?.noField || 'order_no']: '单号',
      },
    },
  };
}

/** 按 module 选样例。未知类型回落到行程（视觉契约的基准）。 */
export function previewBlockFor(
  moduleKey: string,
  overrides?: {
    title?: string;
    subtitle?: string;
    noField?: string;
    slotLabels?: Record<string, string>;
  },
): SceneUiBlock {
  if (moduleKey === 'generic.tool_submit') return toolSubmitBlock(overrides);
  return ITINERARY_BLOCK;
}

/** @deprecated 用 `previewBlockFor()` —— 保留仅为兼容既有 import。 */
export const PREVIEW_BLOCK: SceneUiBlock = ITINERARY_BLOCK;

export default function ScenePreviewCard({
  moduleKey,
  /**
   * 场景的 `ui_config.params` —— **必须传**，这是「预览」有意义的前提。
   *
   * 传空对象时卡片会用代码兜底话术（如「已提交」），看起来是能出图的；
   * 但用户改过的结论句、单号标签全都不会体现。那就退回到
   * 「Demo 一个样、实际另一个样」—— 正是这个组件存在的理由所反对的事。
   */
  params,
  /**
   * 槽位 key → 中文名。回执卡靠块级 `data.labels` 翻字段名，预览也要有，
   * 否则用户看到 `room_no` / `item`，跟他刚配的中文名对不上。
   */
  slotLabels,
  /** 是否显示「样例数据预览」这行说明。检查器右栏自己有分组标题，就不再叠一层。 */
  showCaption = true,
}: {
  moduleKey: string;
  params?: Record<string, unknown>;
  slotLabels?: Record<string, string>;
  showCaption?: boolean;
}) {
  const [module, setModule] = useState<SceneModule | null>(null);
  const [failed, setFailed] = useState(false);

  /**
   * 样例数据跟着配置走。
   *
   * `receipt_no_field` 是用户明确指定的单号字段 —— 预览里必须用同一个字段名，
   * 否则用户填了 `waybill_no`，预览卡片上却显示 `order_no`，会以为配置没生效。
   */
  const block = useMemo(() => {
    const raw = params?.receipt_no_field;
    const noField = typeof raw === 'string' ? raw.trim() : '';
    return previewBlockFor(moduleKey, { noField, slotLabels });
  }, [moduleKey, params, slotLabels]);

  useEffect(() => {
    let alive = true;
    setModule(null);
    setFailed(false);
    if (!moduleKey) return;
    void (async () => {
      const mod = await loadSceneModule(moduleKey);
      if (!alive) return;
      if (mod) setModule(mod);
      else setFailed(true);
    })();
    return () => {
      alive = false;
    };
  }, [moduleKey]);

  if (!moduleKey) {
    return (
      <p className="m-0 rounded-[10px] bg-[#fbfaf6] px-[12px] py-[10px] text-[12px] text-[#9a9b95]">
        先选一个场景类型，这里会显示用户实际看到的卡片。
      </p>
    );
  }

  // 未知 module / chunk 加载失败：明确说「没有这个界面组件」，
  // 而不是显示空白 —— 空白看起来像「加载中」，用户会一直等。
  if (failed) {
    return (
      <p className="m-0 rounded-[10px] bg-[#fff2e5] px-[12px] py-[10px] text-[12px] leading-[18px] text-[#b45309]">
        没有找到「{moduleKey}」的界面组件，聊天里会退化成纯文本。
      </p>
    );
  }

  if (!module) {
    return <p className="m-0 text-[12px] text-[#9a9b95]">加载预览…</p>;
  }

  const Card = module.ResultCard;
  if (!Card) {
    return (
      <p className="m-0 rounded-[10px] bg-[#fbfaf6] px-[12px] py-[10px] text-[12px] leading-[18px] text-[#9a9b95]">
        这个场景类型的回答是纯文本，没有卡片界面。
        {module.meta.summary ? `（${module.meta.summary}）` : ''}
      </p>
    );
  }

  return (
    <div className="rounded-[12px] border border-dashed border-[#cfc5b7] bg-[#fbfaf6] p-[10px]">
      {/* 说明这只是一份样例：用真组件必然要喂数据，不标注会被误认成真结果 */}
      {showCaption && (
        <p className="m-0 mb-[8px] text-[10.5px] text-[#9a9b95]">
          样例数据预览 · 用户在聊天里看到的效果
        </p>
      )}
      <Card
        block={block}
        siblings={[block]}
        params={params ?? {}}
        sendText={() => {}}
        submitSlots={() => {}}
        openExternal={() => {}}
        disabled
      />
    </div>
  );
}