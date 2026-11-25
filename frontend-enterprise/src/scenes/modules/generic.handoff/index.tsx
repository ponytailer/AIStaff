import { defineSceneModule } from '../../define';

/**
 * `generic.handoff` —— 通用转人工**界面**。
 *
 * 转人工通道产两块（`channels._run_handoff`）：
 * 1. `text`：`data.content` = 「已为你转接{target}，稍后会有同事在这里回复你。」；
 * 2. `handoff`：`data` = `{target, summary, ticket_id, context: {scene_id, slots}}`。
 *
 * ## 为什么这个 module 一个组件都不导出（这是刻意的，不是漏做）
 *
 * `text` 与 `handoff` 两种 kind 在 `types.ts` 的「kind → 组件」映射里
 * **本来就没有组件位**，由平台默认渲染器 `SceneTextBlock` 画
 * （正文 + 已收集信息摘要 + 候选追问 chips）。
 *
 * 这正是设计意图：转人工不需要定制 UI，它的价值在「摘要说清已收集了什么」，
 * 而那是纯文本能表达的最完整形态。如果这里硬造一个 `ResultCard` 去画转人工，
 * 会同时坏两件事：
 * - 造出来的组件永远没人调（`componentForKind('handoff')` 返回 undefined 是写死的），
 *   下一个人会以为转人工有独立卡片，去改那个死组件；
 * - 真正的渲染路径（`SceneTextBlock`）会被当成「临时兜底」被替换掉，
 *   而它其实是这两类 kind 的唯一正规实现。
 *
 * ## 为什么 `required_slots` 是空的
 *
 * 转人工的前提是「用户遇到问题了」，不是「用户要填表」。声明 3 个必填槽位会让
 * 发布校验拦住所有还没配槽位的转人工场景，而那些场景本来是能用的
 * （`handoff_json.summary` 一句话 + 一个 target 就够了）。
 */
export default defineSceneModule({
  meta: {
    module_key: 'generic.handoff',
    module_version: 1,
    supported_scene_types: ['handoff'],
    summary: '转人工提示 + 已收集信息摘要 + 「已转给 XX」，不做业务处理。',
    required_slots: [],
    params_schema: [],
    entry_behavior: 'send_text',
    display_name: '通用转人工',
    // 类型层 handoff 已是 needs_table: 'none'，module 不声明（只能收紧不能放宽）。
  },
});