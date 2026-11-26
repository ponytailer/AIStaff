import type { SceneParamField } from '../../types';

/**
 * `travel.itinerary` 的可配置参数（租户可改，改文案不用发版）。
 *
 * 定义器「场景界面」区块据此渲染参数表单 —— 新增 module 时定义器零改动（PRD §17.3）。
 *
 * 两类参数：
 * - **文案 / 开关**：改这些不用发版（这是「配置驱动」唯一保留的优势）。
 * - **列映射（type: 'column'）**：这个 module 不知道场景的槽位怎么映射，所以必须显式
 *   让管理员指一下「标题取哪列、价格取哪列」。不指也能跑（组件有同名兜底），
 *   但指了才不会在换表时静默取错列。
 */
export const travelItineraryParams: SceneParamField[] = [
  {
    key: 'title_column',
    label: '标题列',
    type: 'column',
    help: '卡片标题取这一列；留空则依次尝试 计划内容 / 标题 / 名称 / 行程名称',
  },
  {
    key: 'price_column',
    label: '价格列',
    type: 'column',
    help: '底部大号价格取这一列；留空则用预算列',
  },
  {
    key: 'people_column',
    label: '人数列',
    type: 'column',
    help: '元信息条「人数」取这一列',
  },
  {
    key: 'days_column',
    label: '天数列',
    type: 'column',
    help: '元信息条「天数」取这一列，同时决定时间轴画几天',
  },
  {
    key: 'budget_column',
    label: '预算列',
    type: 'column',
    help: '元信息条「预算」取这一列；留空则用 预算 / 人均预算 / 报价',
  },
  {
    key: 'destination_column',
    label: '目的地列',
    type: 'column',
    help: '副标题的第一段（亚布力 · 5 天 4 晚 · 来自「…」）',
  },
  {
    key: 'schedule_column',
    label: '日程列',
    type: 'column',
    help: '逐日日程。支持 JSON 数组，或「标题|描述|标签1,标签2」每行一天的写法',
  },
  {
    key: 'card_title_template',
    label: '卡片标题（覆盖）',
    type: 'text',
    placeholder: '留空用标题列的值',
  },
  {
    key: 'price_note',
    label: '价格说明',
    type: 'text',
    placeholder: '/人 · 含住宿、雪票、教练、接送',
  },
  {
    key: 'show_source_table',
    label: '副标题里显示来源表名',
    type: 'boolean',
    default: true,
  },
];

/**
 * 参数的默认值。
 *
 * **module 内部统一从这里取**，不要在组件里散落字面量 —— 否则「默认值」会变成
 * 三处不同的字符串，改一次要全文搜索。
 *
 * 没有 `primary_action_label` / `secondary_action_label`：这张卡上已经不放按钮了
 * （理由见 `ItineraryCard` 价格条注释）。留两个改不动的文案字段在预设页，
 * 比没有更糟 —— 超管会改完保存，然后在卡片上找不到任何变化。
 */
export const TRAVEL_ITINERARY_PARAM_DEFAULTS = {
  price_note: '/人 · 含住宿、雪票、教练、接送',
  show_source_table: true,
} as const;

/** 标题列的兜底候选（按顺序找第一个命中的列）。 */
export const TITLE_COLUMN_CANDIDATES = ['计划内容', '标题', '名称', '行程名称', '套餐', '产品名称'];

/** 各语义列的同名兜底（表头就是中文时不用配也认得）。 */
export const COLUMN_CANDIDATES: Record<string, string[]> = {
  people: ['人数', '成团人数', '出行人数'],
  days: ['天数', '行程天数', '晚数'],
  budget: ['预算', '人均预算', '价格', '报价'],
  destination: ['目的地', '城市', '景区', '雪场'],
  schedule: ['日程', '行程', '行程明细', '日程安排'],
};