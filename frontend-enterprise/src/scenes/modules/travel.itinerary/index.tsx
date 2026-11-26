import { defineSceneModule } from '../../define';
import { travelItineraryParams } from './params';
import { ItineraryEmptyState, ItineraryResultCard } from './ItineraryCard';
import { TravelItinerarySlotForm } from './ItinerarySlotForm';

/**
 * `travel.itinerary` —— 定制 module，用来证明「代码驱动比配置驱动多做了什么」。
 *
 * 它和四个 generic module 的差别**不是「配置更多」，而是「有真正的 UI 代码」**：
 * 逐日时间轴、每日活动分类、价格倒推、满员提示，这些配置驱动做不出来。
 *
 * 视觉规格唯一来源：`docs/scenes/scene-v3-visual-contract.md` §1（逐值表）。
 * 按 contract §7.3 的两处刻意不同：非 table_match 的区块不渲染（不是置灰）。
 */
export default defineSceneModule({
  meta: {
    module_key: 'travel.itinerary',
    module_version: 1,
    supported_scene_types: ['table_match'],
    summary: '把匹配到的行程按「逐日时间轴」渲染，含每日活动、住宿、餐食，底部给价格与预订动作。',
    required_slots: [
      { key: 'people', label: '人数', type: 'number', required: true, unit: '人' },
      { key: 'days', label: '天数', type: 'number', required: true, unit: '天' },
      { key: 'budget', label: '预算', type: 'number', required: true, unit: '元' },
    ],
    params_schema: travelItineraryParams,
    entry_behavior: 'open_form',
    display_name: '行程规划',
    // 它要真排期，没有表画不出空态 —— 类型层给 optional，这里收紧到 required。
    // module 层只能收紧不能放宽，实际档位用 effectiveNeedsTable() 算。
    needs_table: 'required',
  },
  ResultCard: ItineraryResultCard,
  EmptyState: ItineraryEmptyState,
  /**
   * 条件表单。
   *
   * **必须显式导出**：`SceneModuleSurface` 按 `kind` 找组件，`form` 块没有
   * `SlotForm` 时直接退化成 `fallback_text`（`form` 块通常没有可用兜底文本，
   * 结果是**整块不渲染** —— 用户点完胶囊看到一条只有一句话的回复，表单消失）。
   * 这个坑在接表单之前一直藏着，因为没有任何场景走过「缺槽位 → 出 form 块」这条路。
   *
   * 自己画而不是 `renderForm(block.data)` 的理由见 `ItinerarySlotForm` 头注释：
   * demo 的分段按钮 / 金额快选，通用 `SlotFormCard` 表达不了。
   */
  SlotForm: TravelItinerarySlotForm,
});