import type { SceneParamField } from '../../types';

/**
 * `generic.table_match` 的可配置参数。
 *
 * 只有 4 项，刻意比 `travel.itinerary` 少：它是「不写代码也能建场景」的保底路径，
 * 参数越多，管理员配错的面积越大。真正的定制需求应该写一个自己的 module。
 */
export const genericTableMatchParams: SceneParamField[] = [
  {
    key: 'title_column',
    label: '标题列',
    type: 'column',
    help: '列表每一项的标题取这一列；留空则依次尝试 计划内容 / 标题 / 名称 / 方案名称 / 产品名称',
  },
  {
    key: 'primary_action_label',
    label: '主按钮文案',
    type: 'text',
    placeholder: '选这个',
  },
  {
    key: 'secondary_action_label',
    label: '次按钮文案',
    type: 'text',
    placeholder: '看详情',
  },
  {
    key: 'show_source_table',
    label: '显示来源表名',
    type: 'boolean',
    default: true,
  },
];

/** 默认值集中在这里 —— 组件里不要散落同义字面量。 */
export const GENERIC_TABLE_MATCH_DEFAULTS = {
  primary_action_label: '选这个',
  secondary_action_label: '看详情',
  show_source_table: true,
} as const;