import { useEffect, useState } from 'react';

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
 * 预览用的样例数据。形状严格按 arch §2.2 的 `kind=result` 契约。
 *
 * 刻意用「经典雪山五日」这份数据：它与 `test_scene_api.py` 的 CSV_FIXTURE
 * 同源，视觉契约 §1 的排版就是按这组长度的文案调的 —— 换一组数据就看不出
 * 排版是否对齐（比如标题过长会不会把徽标挤歪）。
 */
export const PREVIEW_BLOCK: SceneUiBlock = {
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

export default function ScenePreviewCard({
  moduleKey,
  /** 是否显示「样例数据预览」这行说明。检查器右栏自己有分组标题，就不再叠一层。 */
  showCaption = true,
}: {
  moduleKey: string;
  showCaption?: boolean;
}) {
  const [module, setModule] = useState<SceneModule | null>(null);
  const [failed, setFailed] = useState(false);

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
        block={PREVIEW_BLOCK}
        siblings={[PREVIEW_BLOCK]}
        params={{}}
        sendText={() => {}}
        submitSlots={() => {}}
        openExternal={() => {}}
        disabled
      />
    </div>
  );
}