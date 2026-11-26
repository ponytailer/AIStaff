/**
 * 场景管理三页（场景列表 / 定义器 / 场景预设）共用的样式常量。
 *
 * ## 这个文件存在的唯一理由：**同一样式只允许有一个定义**
 *
 * 曾经同一个主按钮在项目里有**四份手写实现**：
 * `ScenesPage` 的局部 `btnPrimary`、`SceneEditor` 顶栏一处内联、
 * `SceneEditor` 试跑条一处内联、`shared/buttons.ts` 的
 * `SCENE_PRIMARY_BUTTON_CLASS`。四份的圆角/内边距各不相同（8 与 9、
 * `py-[5px]` 与 `py-[6px]`），截图里差 1~2px —— 每次改版都要重新量一遍，
 * 而且总有一处被漏掉，表现是「同一个按钮在两个页面看着不一样高」。
 *
 * 所以：**页面级按钮/输入框/卡片在这里定义一次**，页面只写
 * `className={SCENE_BTN_PRIMARY}`。
 *
 * ## 与 `src/scenes/shared/buttons.ts` 的分工
 *
 * | 文件 | 管什么 | 谁用 |
 * |---|---|---|
 * | **本文件** | 管理页的**外壳控件**（按钮 / 输入框 / 卡片 / 分组标题） | `ScenesPage` / `SceneEditor` / `ScenePresetsPage` |
 * | `scenes/shared/buttons.ts` | **聊天气泡内**的小按钮与胶囊（尺寸更小：11.5px / py-5px） | 各 module 的卡片 |
 *
 * 两者**刻意不同尺寸**，不是漏统一：聊天里的卡片宽度约 400px，必须用更小的
 * 字号与内边距才塞得下；管理页是整屏，用 12.5px / py-6px 才不显得局促。
 * 混用会出真问题 —— 把聊天按钮的样式套到管理页顶栏，按钮会矮一截；
 * 反过来把管理页按钮塞进卡片，价格条会被撑高。详见 `scene-v3-visual-contract.md` §1、§7。
 *
 * ## 规格来源
 *
 * 逐值对齐 `docs/scenes/scene-manager-demo.html` 的 `.btn` / `.btn-primary` /
 * `.btn-ghost`（圆角 9、`padding:7px 12px`、12.5px）。`scene-editor-demo.html`
 * 的 `.btn` 是圆角 8 / `padding:6px 12px`，与 manager 差 1px —— 两份 demo
 * 之间就已经漂了，这里统一取 manager 那份（它是主页面，且圆角 9 与项目
 * 其它页面（`rounded-[9px]`）一致）。
 */

/* ============================================================
   按钮
   ============================================================ */

/** 主按钮：实心 teal，页面唯一的主操作（新建 / 保存 / 发布）。 */
export const SCENE_BTN_PRIMARY =
  'inline-flex shrink-0 items-center gap-[5px] rounded-[9px] border border-[#0f766e] bg-[#0f766e] '
  + 'px-[11px] py-[6px] text-[12.5px] font-medium whitespace-nowrap text-white transition-colors '
  + 'hover:border-[#0c6158] hover:bg-[#0c6158] disabled:cursor-not-allowed disabled:opacity-50';

/** 次按钮：白底描边。 */
export const SCENE_BTN_SECONDARY =
  'inline-flex shrink-0 items-center gap-[5px] rounded-[9px] border border-[#ded7cc] bg-white '
  + 'px-[11px] py-[6px] text-[12.5px] text-[#343633] whitespace-nowrap transition-colors '
  + 'hover:border-[#cfc5b7] hover:bg-[#fbfaf6] disabled:cursor-not-allowed disabled:opacity-50';

/** 幽灵按钮：无边框，用于「刷新」这类辅助动作。 */
export const SCENE_BTN_GHOST =
  'inline-flex shrink-0 items-center gap-[5px] rounded-[9px] border border-transparent bg-transparent '
  + 'px-[9px] py-[6px] text-[12.5px] text-[#6d6d72] whitespace-nowrap transition-colors '
  + 'hover:bg-[rgba(17,17,17,0.045)] hover:text-[#18181a] disabled:cursor-not-allowed disabled:opacity-50';

/** 小按钮：检查器底部 / 行内动作（更矮一档，12px）。 */
export const SCENE_BTN_SM =
  'inline-flex shrink-0 items-center gap-[4px] rounded-[8px] border border-[#ded7cc] bg-white '
  + 'px-[9px] py-[4px] text-[12px] text-[#343633] whitespace-nowrap transition-colors '
  + 'hover:border-[#cfc5b7] hover:bg-[#fbfaf6] disabled:cursor-not-allowed disabled:opacity-50';

/**
 * 小号主按钮：窄栏里的主操作（定义器试跑面板的「试跑」）。
 *
 * 与 `SCENE_BTN_PRIMARY` 的差别只有尺寸（圆角 8 / 12px / px-10 py-5），颜色与
 * 交互态逐值相同。之所以不复用大号：试跑面板只有 360px 宽，塞一颗 `py-[6px]`
 * 的按钮会把表头那一行撑高，而左侧同屏的分区标题行比它矮 —— 两条水平线对不上。
 */
export const SCENE_BTN_PRIMARY_SM =
  'inline-flex shrink-0 items-center gap-[5px] rounded-[8px] border border-[#0f766e] '
  + 'bg-[#0f766e] px-[10px] py-[5px] text-[12px] font-medium whitespace-nowrap text-white '
  + 'transition-colors hover:border-[#0c6158] hover:bg-[#0c6158] '
  + 'disabled:cursor-not-allowed disabled:opacity-50';

/** 纯文字按钮：删除这类低频危险动作，靠 hover 变色提示。 */
export const SCENE_BTN_LINK_DANGER =
  'rounded-[7px] border-0 bg-transparent px-[8px] py-[3px] text-[11.5px] text-[#6d6d72] '
  + 'transition-colors hover:bg-[#fdf0f0] hover:text-[#c0392b]';

/** 纯文字按钮：非危险的低频动作。 */
export const SCENE_BTN_LINK =
  'rounded-[7px] border-0 bg-transparent px-[8px] py-[3px] text-[11.5px] text-[#6d6d72] '
  + 'transition-colors hover:bg-[rgba(17,17,17,0.055)] hover:text-[#18181a]';

/* ============================================================
   输入控件
   ============================================================ */

/** 单行输入 / 下拉。高度 32、圆角 8、左右 9px（三份 demo 逐值一致）。 */
export const SCENE_INPUT =
  'h-[32px] w-full rounded-[8px] border border-[#cfc5b7] bg-white px-[9px] text-[12.5px] '
  + 'text-[#18181a] outline-none transition-colors placeholder:text-[#b0b1ab] '
  + 'focus:border-[#0f766e] disabled:cursor-not-allowed disabled:bg-[#fbfaf6]';

/** 多行输入。 */
export const SCENE_TEXTAREA =
  'w-full resize-y rounded-[8px] border border-[#cfc5b7] bg-white px-[9px] py-[7px] text-[12.5px] '
  + 'leading-[19px] text-[#18181a] outline-none transition-colors placeholder:text-[#b0b1ab] '
  + 'focus:border-[#0f766e]';

/**
 * 下拉框本体（**不含宽度**）。
 *
 * ## 为什么不能复用 `SCENE_INPUT`
 *
 * 原生 `<select>` 套 `<input>` 的样式会坏两件事：
 *
 * 1. **右侧箭头还是浏览器自绘的**（Windows 上是灰三角、macOS 上是蓝色渐变方块），
 *    和站点其它下拉（shadcn `Select`、`SELECT_TRIGGER_CLASS` 那套自绘 chevron）
 *    完全不是一个东西。截图里最刺眼的就是这个 —— 页面上其它下拉都是细线箭头，
 *    只有接口这个是个系统控件。
 * 2. **`SCENE_INPUT` 带 `w-full`**，调用点再追加 `w-[420px]` 时是「两个宽度类
 *    同时存在」，谁生效取决于 Tailwind 产物里的顺序而不是书写顺序。表现是
 *    「我明明写了 420px，它却撑满整行」。
 *
 * 所以下拉单独一份：`appearance-none` 干掉原生箭头、`pr` 留出自绘箭头的位、
 * **不写宽度**（宽度一律由调用点给，避免上面第 2 条那种双写）。
 * 高度/圆角/边框/字号与 `SCENE_INPUT` 逐值一致 —— 并排放的时候是同一排控件。
 */
export const SCENE_SELECT =
  'h-[32px] w-full appearance-none rounded-[8px] border border-[#cfc5b7] bg-white '
  + 'pl-[9px] pr-[26px] text-[12.5px] text-[#18181a] outline-none transition-colors '
  + 'focus:border-[#0f766e] disabled:cursor-not-allowed disabled:bg-[#fbfaf6]';

/** 下拉框外层（承载自绘箭头）。`relative` 是箭头绝对定位的锚。 */
export const SCENE_SELECT_WRAP = 'relative inline-flex items-center';

/** 下拉框的自绘箭头。 */
export const SCENE_SELECT_CHEVRON =
  'pointer-events-none absolute right-[7px] size-[14px] text-[#6d6d72]';

/** 等宽多行输入（JSON 编辑）。 */
export const SCENE_TEXTAREA_MONO =
  'w-full resize-y rounded-[8px] border border-[#cfc5b7] bg-white px-[9px] py-[7px] font-mono '
  + 'text-[11.5px] leading-[18px] text-[#18181a] outline-none transition-colors '
  + 'focus:border-[#0f766e]';

/* ============================================================
   容器
   ============================================================ */

/** 卡片外壳：管理页所有分区都长这样。 */
export const SCENE_CARD = 'rounded-[12px] border border-[#ded7cc] bg-white shadow-[0_1px_2px_rgba(17,17,17,0.04),0_1px_8px_rgba(70,76,94,0.06)]';

/** 卡片头：标题 + 右侧说明。 */
export const SCENE_CARD_HEAD =
  'flex items-center gap-[7px] border-b border-[#e7dfd3] px-[14px] py-[11px] text-[12.5px] font-semibold text-[#18181a]';

/** 卡片体。 */
export const SCENE_CARD_BODY = 'flex flex-col gap-[13px] px-[14px] py-[14px]';

/** 表单字段：标签在上、控件在下。 */
export const SCENE_FIELD = 'flex flex-col gap-[4px]';

/* ============================================================
   定义器的分区（`scene-editor-demo.html` 的 .section / .section-head / .section-n）
   ============================================================ */

/**
 * 分区外框。比 `SCENE_CARD` 圆一档（14 vs 12）、内边距大一档（16/18 vs 11/14）。
 *
 * 为什么不复用 `SCENE_CARD`：这两者不是同一层的东西 —— 检查器的卡是「一屏里的
 * 一个小模块」，定义器的分区是「整页的主要章节」，用同一套尺寸会让定义器看起来
 * 像检查器的放大版，层级全平。demo 里它们就是两个值，照抄。
 */
export const SCENE_FORM_SECTION =
  'mb-[14px] rounded-[14px] border border-[rgba(24,24,26,0.10)] bg-white px-[18px] py-[16px]';

/** 分区标题行：编号 + 标题（+ 右侧说明）。 */
export const SCENE_FORM_SECTION_HEAD =
  'm-0 mb-[12px] flex items-center gap-[8px] text-[13.5px] font-semibold text-[#18181a]';

/** 分区编号圆点。 */
export const SCENE_FORM_SECTION_N =
  'grid size-[18px] flex-[0_0_18px] place-items-center rounded-full bg-[#f2f1ee] '
  + 'text-[10px] font-semibold text-[#6d6d72]';

/** 分区标题右侧的旁注（「这些都能改」）。 */
export const SCENE_FORM_SECTION_NOTE =
  'ml-auto flex items-center gap-[4px] text-[10.5px] font-normal text-[#9a9b95]';

/** 字段标签。 */
export const SCENE_FIELD_LABEL = 'text-[12px] text-[#343633]';

/** 字段说明（标签下方或控件下方的小字）。 */
export const SCENE_FIELD_HINT = 'm-0 text-[11px] leading-[16px] text-[#9a9b95]';

/** 分组小标题（检查器里的 CONFIG / 回答效果）。 */
export const SCENE_SECTION_LABEL =
  'mb-[7px] text-[10.5px] font-semibold tracking-[0.055em] text-[#9a9b95] uppercase';

/* ============================================================
   状态胶囊
   ============================================================ */

/** 胶囊外壳。 */
export const SCENE_PILL =
  'inline-flex items-center gap-[5px] rounded-full border px-[8px] py-[2px] text-[10.5px] '
  + 'leading-[16px] font-medium whitespace-nowrap';

/** 胶囊色调。键名与 `statusMeta()` 的 `tone` 对齐。 */
export const SCENE_PILL_TONE = {
  green: 'border-[#bfe8d9] bg-[#eafaf3] text-[#0f8a5f]',
  orange: 'border-[#f3d28b] bg-[#fff8e8] text-[#8a4b00]',
  gray: 'border-[#e2dbd0] bg-[#fbfaf6] text-[#6d6d72]',
  warn: 'border-[#f3d28b] bg-[#fff8e8] text-[#8a4b00]',
} as const;

export type ScenePillTone = keyof typeof SCENE_PILL_TONE;