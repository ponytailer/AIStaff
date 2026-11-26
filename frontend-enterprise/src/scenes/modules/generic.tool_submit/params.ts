import type { SceneParamField } from '../../types';

/**
 * `generic.tool_submit` 的可配置参数 —— **话术层**。
 *
 * ## 样式固定，话术开放
 *
 * 卡片的**版式**（渐变卡头、单号一行、字段平铺）由 module 代码决定，
 * 用户改不了也不该改 —— 那是视觉契约，改了就和别的卡片不是一家。
 * 但**说什么话**必须能改：同一个「提交成功」，客房送物说「师傅会上门」，
 * 报修说「已派单给张师傅」，预约说「凭码到前台取号」。
 *
 * 所以这里全部是文案项，没有一条影响布局结构。
 *
 * ## 这些参数存在哪、谁能改
 *
 * | 位置 | 谁改 |
 * |---|---|
 * | 场景的 `ui_config.params` | **员工**（定义器里「回复用户」/「提交到哪里」） |
 * | 超管预设的 `params` | 超管（作为新建场景的**预填值**） |
 *
 * 优先级是「场景显式配的盖掉预设」（`effective_ui_config` 的按键合并）。
 * 留空 = 吃回预设值，再退到代码里的兜底句。
 *
 * ## `scope` —— 每一项归哪个区块填
 *
 * 六项里有五项是**话术**（`scope: 'reply'`，进「回复用户」）；
 * `receipt_no_field` 是**技术映射**（`scope: 'submit'`，进「提交到哪里」）。
 *
 * 分开的理由：把「接口返回里哪个字段是单号」摆在「结论句」「补充说明」
 * 中间，标签写着「哪个字段是单号」—— 用户会以为自己要在这里写一句中文。
 * 两类东西混在一屏，改了其中一类还会以为两类都改了。
 *
 * 不标 `scope` 的项**不会**在定义器里出现（例如 `travel.itinerary` 的
 * `price_note` 归超管预设页）。这是保守默认：多渲染一个输入框比少渲染更糟，
 * 用户会以为漏配了，改完还不生效。
 *
 * ## 为什么刻意不放「接口地址 / 参数映射」
 *
 * 那是 `scene.tool_api_json` 的事（后端通道读它决定调什么），放进 `params`
 * 会让同一件事有两个来源，改一处不生效时无从判断该看哪。
 */
export const genericToolSubmitParams: SceneParamField[] = [
  {
    key: 'receipt_title',
    scope: 'reply',
    label: '结论句',
    type: 'text',
    placeholder: '已提交',
    help: '回执卡头上那句话。客房送物可写「已通知客房部」，报修可写「已派单」。',
  },
  {
    key: 'receipt_subtitle',
    scope: 'reply',
    label: '补充说明',
    type: 'text',
    placeholder: '请保留下面的单号，便于后续查询',
    help: '结论句下面那行小字。写「多久上门」「凭码取件」这类具体承诺。留空则按有无单号自动兜底。',
  },
  {
    key: 'receipt_no_field',
    scope: 'submit',
    label: '哪个字段是单号',
    type: 'text',
    placeholder: 'order_no',
    help: '接口返回里代表单号的字段名。留空则按 no / id / code / 单号 等特征自动识别。',
  },
  {
    key: 'receipt_no_label',
    scope: 'reply',
    label: '单号叫什么',
    type: 'text',
    placeholder: '受理单号',
    help: '单号前面那个标签。受理单号 / 运单号 / 工单编号，各业务叫法不同。',
  },
  {
    key: 'progress_text',
    scope: 'reply',
    label: '进度按钮文案',
    type: 'text',
    placeholder: '查看进度',
    help: '回执卡右下角的按钮。留空则不显示这颗按钮（接口没有进度可查时该留空）。',
  },
  {
    key: 'progress_query',
    scope: 'reply',
    label: '点进度按钮时发什么',
    type: 'text',
    placeholder: '帮我查一下刚才那单的进度',
    help: '用户点按钮后实际发给助手的话。留空用默认问法。',
  },
];

/** 默认值集中在这里 —— 组件里不要散落同义字面量。 */
export const GENERIC_TOOL_SUBMIT_DEFAULTS = {
  receipt_title: '已提交',
  receipt_subtitle: '',
  receipt_no_field: '',
  receipt_no_label: '',
  /** 空 = 不显示进度按钮。默认显示（多数提交场景都想知道后续）。 */
  progress_text: '查看进度',
  progress_query: '帮我查一下刚才那单的进度',
} as const;