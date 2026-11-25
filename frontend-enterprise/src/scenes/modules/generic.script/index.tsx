import { defineSceneModule } from '../../define';

/**
 * `generic.script` —— 通用话术**界面**。
 *
 * 话术通道产**一块** `text` 块（`channels._run_script`）：
 * ```json
 * { "content": "…话术正文…", "chips": [{"label": "…", "send_text": "…"}] }
 * ```
 *
 * ## 为什么一个组件都不导出
 *
 * 理由同 `generic.handoff`：`text` 在「kind → 组件」映射里没有组件位，
 * 由平台默认渲染器 `SceneTextBlock` 渲染 —— 正文段落 + 候选追问 chips
 * （chips 用契约 §6 的 `.chip` 逐值样式）。这正是话术场景需要的全部形态：
 * 一段话 + 几个能点的追问。造一个 `ResultCard` 反而会把它画成一张卡片，
 * 而话术在对话里应该看起来像**一句话**，不像一张卡。
 *
 * ## 为什么 `required_slots` 是空的
 *
 * 话术是「关键词命中直出，零模型零逻辑」（PRD §6）。它不需要用户先填任何东西 ——
 * 声明必填槽位会让「用户直接问一句」这条主路径被表单拦住，正好抵消了它
 * 「零延迟」的全部价值。
 *
 * ## 参数为什么是空的
 *
 * 话术的正文与关键词都在实例配置（`scene.scripts_json`）里，租户自己维护，
 * 不需要 module 参数。加空参数会让人以为「话术的文案也能在这里改」。
 */
export default defineSceneModule({
  meta: {
    module_key: 'generic.script',
    module_version: 1,
    supported_scene_types: ['script'],
    summary: '正文 + 候选追问 chips，关键词命中直出，零模型零逻辑。',
    required_slots: [],
    params_schema: [],
    entry_behavior: 'send_text',
    display_name: '通用话术',
    // 类型层 script 已是 needs_table: 'none'。
  },
});