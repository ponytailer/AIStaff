import { cn } from '@/lib/utils';

/**
 * Tailwind class tokens for the migrated chat conversation page.
 *
 * Palette + metrics are derived from the SD1 Figma (nodes 38:3773 empty state
 * and 38:4962 active conversation): background #f7f7f6, 220px sidebar with a
 * rgba(24,24,26,0.06) right border, ink #18181a, muted #6d6d72 / #6d6d72, hairline borders
 * rgba(24,24,26,0.08) (0.5px), user bubble #e5e4e0, 56px header, and a white composer card
 * with a #18181a 0.5px border, 14px radius and a dark send button.
 */

// ---------------------------------------------------------------------------
// Shared chat chrome (the sidebar itself now lives in the reusable AppSidebar
// component; see AppSidebar.tsx `variant="chat"`).
// ---------------------------------------------------------------------------
export const CHAT_ICON_BUTTON_CLASS =
  'inline-grid size-[30px] shrink-0 place-items-center rounded-[8px] border-0 bg-transparent p-0 text-[#6d6d72] transition-colors hover:bg-[#f0efec] hover:text-[#18181a]';

/**
 * 对话端唯一的一种「实体卡」语言，消息窗口 / 输入框 / 右栏小卡全都复用它：
 *   白面 + 18px 圆角 + 0.5px 墨色描边（ring，不占盒模型）+ 一层极浅的浮起阴影。
 *
 * 为什么一条 token 而不是各写各的：这几张卡在屏幕上是上下叠着的，圆角差 2px、
 * 描边一个暖米一个冷灰，第一眼就会读成「两套组件」。环状描边用 ring 而不是
 * border，是为了让卡内内容宽度 = 卡宽 − padding（border 会再吃掉 1px×2，
 * 消息卡与输入框的文字左右缘就会各错 1px）。
 */
export const CHAT_SURFACE_CARD_CLASS =
  'rounded-[18px] bg-white ring-[0.5px] ring-[rgba(24,24,26,0.16)] shadow-[0_1px_2px_rgba(24,24,26,0.05),0_8px_24px_-14px_rgba(24,24,26,0.18)]';

// ---------------------------------------------------------------------------
// Main column + header
// ---------------------------------------------------------------------------
export const CHAT_MAIN_CLASS = 'flex min-h-0 min-w-0 flex-col bg-[#f7f7f6]';
export const CHAT_HEADER_CLASS =
  // h-[88px] + pt-[32px] 是桌面外壳的拖拽区约束（顶部 32px 留给原生标题栏），
  // 不能压缩：ChatHeader.test 里有对应回归用例。这里只去掉分隔线、放开左右内边距。
  'flex h-[88px] shrink-0 items-center justify-between gap-[12px] pt-[32px] pl-[20px] pr-[20px]';
export const CHAT_HEADER_TITLE_STACK_CLASS = 'flex min-w-0 items-end gap-[8px]';
export const CHAT_HEADER_TITLE_NAME_CLASS = 'truncate text-[15px] font-medium tracking-[-0.01em] text-[#18181a]';
export const CHAT_HEADER_TITLE_META_CLASS = 'shrink-0 truncate text-[11.5px] text-[#9a9a9f]';
export const CHAT_HEADER_ACTIONS_CLASS = 'flex shrink-0 items-center gap-[6px]';

// ---------------------------------------------------------------------------
// Message scroller
// ---------------------------------------------------------------------------
export const CHAT_MESSAGES_CLASS =
  'min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-[20px] pb-[22px] [scrollbar-width:thin] [scrollbar-color:rgba(24,24,26,0.16)_transparent]';
// 消息列不再自带宽度约束（原先 max-w-808）：它的父级就是那张 768 宽的消息卡，
// 这里只需要左右各 20 内边距 —— 卡宽 768 − 40 = 内容 728，与下方输入框里
// 「form p-10 + textarea px-10 = 左右各 20」得到的 728 完全一致，文字左右缘对齐。
// 间距交给「组」控制：默认 4px（同一轮的连续消息贴紧），换组时由
// CHAT_TURN_SPACED_CLASS 的 mt-[18px] 拉开。整列不再一条一个 18px 的沟。
export const CHAT_MESSAGE_STACK_CLASS =
  'mx-auto flex min-w-0 w-full flex-col gap-[4px] px-[20px]';

export const CHAT_MESSAGE_ITEM_CLASS = 'group flex min-w-0 w-full flex-col';
export const CHAT_QUEUED_MESSAGE_ITEM_CLASS = 'order-last';
export const CHAT_MESSAGE_ROW_BASE_CLASS = 'flex min-w-0 w-full';
export const CHAT_MESSAGE_ROW_USER_CLASS = 'justify-end';
export const CHAT_MESSAGE_ROW_ASSISTANT_CLASS = 'justify-start';
export const CHAT_GROUP_MESSAGE_ROW_CLASS = 'items-start gap-[10px]';
export const CHAT_GROUP_MESSAGE_AVATAR_CLASS =
  'mt-0 size-[28px] shrink-0 overflow-hidden rounded-full bg-[rgba(15,118,110,0.12)] text-[#0f766e]';
export const CHAT_GROUP_MESSAGE_CONTENT_CLASS = 'flex min-w-0 flex-1 flex-col gap-[6px]';
export const CHAT_GROUP_MESSAGE_LEADER_BADGE_CLASS =
  'rounded-full bg-[#edf3ff] px-[6px] py-px text-[9px] font-medium leading-[1.4] text-[#1a71ff]';

// ---------------------------------------------------------------------------
// Turn grouping（参考 tuffui ai-chat：一次「发言」= 头像 + 姓名行 + 内容）
//
// 连续同角色的消息共享一个组头：只有组首出头像与姓名，后续消息在头像列宽处
// 留白对齐。组与组之间用 mt 呼吸，组内只隔 4px —— 这样一眼能看出「哪几句是
// 同一轮说的」，而不是每条都被 18px 的空隙切成独立卡片。
// ---------------------------------------------------------------------------
export const CHAT_TURN_SPACED_CLASS = 'mt-[20px]';
/** 组内后续消息：占住头像那一列，内容仍在同一条竖线上。 */
export const CHAT_TURN_SPACER_CLASS = 'w-[28px] shrink-0';
export const CHAT_TURN_HEAD_CLASS = 'mb-[5px] flex min-w-0 items-center gap-[7px]';
export const CHAT_TURN_AUTHOR_CLASS =
  'inline-flex min-w-0 items-center gap-[6px] text-[13px] font-medium leading-[1.4] tracking-[-0.005em] text-[#18181a]';
/** 时间：默认隐藏，hover / 键盘聚焦该轮时才出现（和 tuffui 一致）。 */
export const CHAT_TURN_TIME_CLASS =
  'shrink-0 text-[11.5px] leading-[1.4] tabular-nums text-[#9a9a9f] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100';
/** 日期分隔：居中胶囊，不用横线（thread 里不出现线）。 */
export const CHAT_DAY_DIVIDER_CLASS = 'my-[14px] flex justify-center';
export const CHAT_DAY_DIVIDER_PILL_CLASS =
  'rounded-full bg-[rgba(24,24,26,0.05)] px-[10px] py-[2px] text-[11px] font-medium leading-[1.5] text-[#6d6d72]';

// 正文基准 14.5px（tuffui ai-chat 用 text-sm + leading-relaxed，中文再抬半档），
// 助手侧裸文本、不加卡片；用户侧只留一个暖米气泡。
export const CHAT_BUBBLE_BASE_CLASS =
  'relative box-border min-w-0 max-w-[min(680px,92%)] text-[14.5px] leading-[1.7] wrap-anywhere text-[#18181a]';
export const CHAT_BUBBLE_ASSISTANT_CLASS = 'w-full max-w-full';
export const CHAT_BUBBLE_USER_CLASS =
  'rounded-[16px] rounded-tr-[6px] bg-[#e5e4e0] px-[14px] py-[8px] text-[#18181a]';
export const CHAT_BUBBLE_ERROR_CLASS = 'border-[#f38989] bg-[#fce7e7] text-[#d20b0b]';
export const CHAT_QUEUED_BUBBLE_CLASS =
  'border border-dashed border-[rgba(24,24,26,0.12)] bg-[#f2f1ee] pr-[42px] text-[rgba(24,24,26,0.8)]';
export const CHAT_QUEUED_DELETE_BTN_CLASS =
  'absolute right-[8px] top-[8px] inline-grid size-[24px] place-items-center rounded-[7px] border-0 bg-transparent p-0 text-[#9a9a9f] transition-colors hover:bg-[#eeece9] hover:text-[#18181a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(24,24,26,0.12)]';
/** 流式输出的光标：2px 竖条缀在最后一个字后面，跟 tuffui 的 streaming caret 同款。 */
export const CHAT_STREAM_CURSOR_CLASS =
  'ml-[2px] inline-block h-[1.05em] w-[2px] translate-y-[2px] rounded-full bg-[#0f766e] animate-pulse motion-reduce:animate-none';
export function chatRowClass(role: 'user' | 'assistant' | 'system' | 'tool'): string {
  return cn(
    CHAT_MESSAGE_ROW_BASE_CLASS,
    role === 'user' ? CHAT_MESSAGE_ROW_USER_CLASS : CHAT_MESSAGE_ROW_ASSISTANT_CLASS,
  );
}

export function chatBubbleClass(role: 'user' | 'assistant' | 'system' | 'tool', isError?: boolean): string {
  return cn(
    CHAT_BUBBLE_BASE_CLASS,
    role === 'user' ? CHAT_BUBBLE_USER_CLASS : CHAT_BUBBLE_ASSISTANT_CLASS,
    isError && CHAT_BUBBLE_ERROR_CLASS,
  );
}

// User plain answer + scheduled chip
export const CHAT_PLAIN_ANSWER_CLASS = 'flex flex-col items-end gap-[6px] whitespace-pre-wrap';
export const CHAT_SLASH_COMMAND_MESSAGE_CLASS =
  'flex-row flex-wrap items-center justify-end gap-x-[9px] gap-y-[6px] whitespace-normal';
export const CHAT_SLASH_COMMAND_REQUEST_CLASS =
  'min-w-0 whitespace-pre-wrap text-[14px] leading-[1.7] text-[#18181a]';
// 定时任务标记：琥珀色 —— 对话里唯一和时间/计划有关的糖，用暖色与青绿的
// 「知识/成功」区分开。图标走 currentColor，跟着一起变色。
export const CHAT_MESSAGE_MODE_CHIP_CLASS =
  'inline-flex items-center gap-[4px] rounded-full border border-[rgba(180,110,10,0.22)] bg-[rgba(180,110,10,0.09)] px-[9px] py-[2px] text-[11px] font-medium text-[#8a5606]';
// 排队态只靠虚线边框 + 删除按钮表达，不再有「排队中」文案行
// （用户明确要求；原 CHAT_QUEUED_STATUS_* 两个常量已随文案一起下线）。

// ---------------------------------------------------------------------------
// 调度入口「转接通知」：由路由自己说「已转交给 X」，成员答案在它后面一条。
// 视觉上刻意比答案轻：淡青底 + 无阴影，读起来像一句旁白，不像一份结论。
// ---------------------------------------------------------------------------
export const CHAT_DISPATCH_NOTICE_ROW_CLASS = 'flex justify-start';
export const CHAT_DISPATCH_NOTICE_CLASS =
  'inline-flex max-w-[min(680px,92%)] flex-wrap items-center gap-[7px] rounded-[12px] border-[0.5px] border-[rgba(15,118,110,0.16)] bg-[rgba(15,118,110,0.06)] px-[13px] py-[9px] text-[13px] leading-[1.6] text-[#3f5b57]';
export const CHAT_DISPATCH_NOTICE_ROUTE_BADGE_CLASS =
  'inline-flex shrink-0 items-center gap-[4px] rounded-[6px] bg-[#dceee9] px-[6px] py-[1px] text-[11px] font-medium leading-[1.5] text-[#0f766e]';
export const CHAT_DISPATCH_NOTICE_TARGET_CLASS = 'font-medium text-[#0f766e]';
export const CHAT_DISPATCH_NOTICE_INTENT_CLASS =
  'min-w-0 truncate text-[11.5px] leading-[1.5] text-[#8f8f93]';
// ---------------------------------------------------------------------------
// Markdown answer (styled via child selectors, code delegates to CodeBlock)
// ---------------------------------------------------------------------------
export const CHAT_MARKDOWN_CLASS = cn(
  'min-w-0 max-w-full text-[14.5px] leading-[1.7] text-[#18181a]',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_p]:my-[8px] [&_p]:wrap-anywhere',
  '[&_h1]:mt-[16px] [&_h1]:mb-[8px] [&_h1]:text-[18px] [&_h1]:font-semibold',
  '[&_h2]:mt-[16px] [&_h2]:mb-[8px] [&_h2]:text-[16px] [&_h2]:font-semibold',
  '[&_h3]:mt-[14px] [&_h3]:mb-[6px] [&_h3]:text-[15px] [&_h3]:font-semibold',
  '[&_h4]:mt-[12px] [&_h4]:mb-[6px] [&_h4]:text-[14px] [&_h4]:font-semibold',
  '[&_ul]:my-[8px] [&_ul]:pl-[22px] [&_ul]:list-disc',
  '[&_ol]:my-[8px] [&_ol]:pl-[22px] [&_ol]:list-decimal',
  '[&_li]:my-[3px]',
  '[&_a]:text-[#0f766e] [&_a]:underline [&_a]:underline-offset-2',
  '[&_.md-link-label]:text-[#0f766e] [&_.md-link-label]:underline [&_.md-link-label]:underline-offset-2',
  '[&_blockquote]:my-[10px] [&_blockquote]:border-l-[3px] [&_blockquote]:border-[rgba(24,24,26,0.10)] [&_blockquote]:pl-[12px] [&_blockquote]:text-[#4b4b50]',
  '[&_hr]:my-[12px] [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[rgba(24,24,26,0.08)]',
  '[&_strong]:font-semibold',
  '[&_code]:rounded-[5px] [&_code]:bg-[#f0efec] [&_code]:px-[5px] [&_code]:py-[1px] [&_code]:font-mono [&_code]:text-[12.5px]',
  '[&_.code-block-vscode]:my-[10px]',
);
export const CHAT_MARKDOWN_IMAGE_LINK_CLASS =
  'my-[10px] block w-full max-w-full overflow-hidden rounded-[12px] border border-[rgba(24,24,26,0.08)] bg-[#f2f1ee] no-underline shadow-[0_8px_24px_rgba(30,45,70,0.08)] transition hover:border-[rgba(24,24,26,0.12)] hover:shadow-[0_10px_28px_rgba(30,45,70,0.12)]';
/**
 * 知识库配图是**操作步骤截图**（常见 865×1272 的整屏截图），按高度封顶会被缩成
 * 三百来像素宽，图里的菜单名和按钮一个都看不清 —— 等于给了图也用不了。
 * 所以按宽度撑满正文列，高度不封顶，靠消息窗口自己滚动。
 */
export const CHAT_MARKDOWN_IMAGE_CLASS =
  'block h-auto w-full max-w-full object-contain';
/**
 * 配图加载失败时的行内占位。
 *
 * 之前失败是直接把 alt 当文本吐出来：知识库文档里每个步骤都挂一张图，一失败整条
 * 回答就成了「…点击左上角“文件” 原文档配图 / …点击“帐户设置” 原文档配图」，读起来
 * 像正文被污染，而且完全看不出是「图片挂了」。改成虚线小戳，只占一个字宽的提示位。
 */
export const CHAT_MARKDOWN_IMAGE_MISSING_CLASS =
  'inline-flex max-w-full items-center gap-[5px] rounded-[7px] border border-dashed border-[rgba(24,24,26,0.18)] bg-[#faf9f6] px-[7px] py-[1px] align-[1px] text-[12px] leading-[1.7] text-[#9a9a9f]';
export const CHAT_MD_TABLE_SCROLL_CLASS = 'my-[10px] max-w-full overflow-x-auto';
export const CHAT_MD_TABLE_CLASS =
  'w-full border-collapse text-[13px] [&_th]:border [&_th]:border-[rgba(24,24,26,0.08)] [&_th]:bg-[#f2f1ee] [&_th]:px-[10px] [&_th]:py-[6px] [&_th]:font-semibold [&_td]:border [&_td]:border-[rgba(24,24,26,0.08)] [&_td]:px-[10px] [&_td]:py-[6px]';

// ---------------------------------------------------------------------------
// Execution record (执行记录 trace panel)
// ---------------------------------------------------------------------------
export const CHAT_TRACE_WRAP_CLASS = 'mb-[10px] min-w-0 max-w-[560px] rounded-[14px] bg-[rgba(24,24,26,0.035)] px-[10px] py-[8px]';
export const CHAT_TRACE_SUMMARY_CLASS =
  'inline-flex w-full cursor-pointer items-center gap-[7px] border-0 bg-transparent p-0 text-[12.5px] font-medium leading-[1.5] text-[#6d6d72] transition-colors hover:text-[#18181a]';
export const CHAT_TRACE_SUMMARY_RUNNING_CLASS = 'text-[#18181a]';
export const CHAT_TRACE_SUMMARY_FAILED_CLASS = 'text-[#d20b0b]';
export const CHAT_TRACE_ICON_CLASS =
  'inline-flex size-[18px] shrink-0 items-center justify-center text-[#6d6d72] [&>svg]:block [&>svg]:size-[14px]';
export const CHAT_TRACE_CHEVRON_CLASS = 'transition-transform duration-150';
export const CHAT_TRACE_CHEVRON_EXPANDED_CLASS = 'rotate-90';
export const CHAT_TRACE_DETAILS_CLASS = 'mt-[6px] grid gap-[2px]';
export const CHAT_TRACE_LINE_CLASS = 'grid grid-cols-[18px_minmax(0,1fr)] items-start gap-[8px]';
export const CHAT_TRACE_LINE_CONTENT_CLASS = 'grid grid-cols-[minmax(0,1fr)] min-w-0 gap-[4px]';
export const CHAT_TRACE_LINE_TEXT_CLASS = 'text-[13px] leading-[1.5] text-[rgba(24,24,26,0.8)] wrap-anywhere';
export const CHAT_TRACE_FLOW_TEXT_CLASS = 'sd1-trace-flow-text';
export const CHAT_TRACE_LINE_TEXT_FAILED_CLASS = 'text-[#d20b0b]';
export const CHAT_TRACE_LINE_DETAIL_CLASS = 'text-[12px] leading-[1.5] text-[#6d6d72] wrap-anywhere';
export const CHAT_TRACE_LINE_DURATION_CLASS =
  'ml-[7px] inline-block align-baseline text-[11px] font-medium leading-[1.5] tabular-nums text-[#9a9a9f]';
export const CHAT_TRACE_TOTAL_DURATION_CLASS =
  'ml-[6px] whitespace-nowrap text-[11px] leading-[1.4] tabular-nums text-[#9a9a9f]';
export const CHAT_TRACE_CODE_SUMMARY_CLASS =
  'cursor-pointer text-[12px] font-medium text-[#6d6d72] hover:text-[#18181a]';
export const CHAT_TRACE_CODE_DETAILS_CLASS = 'block min-w-0 max-w-full overflow-hidden';
export const CHAT_TRACE_CODE_BLOCK_CLASS =
  'mt-[6px] max-h-[420px] w-full max-w-full overflow-auto overscroll-contain';

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------
// 引用标签按**来源类型**分色，而不是一律灰底 —— 语义色板统一在对话端里就是这三档：
//   企业知识 = 青绿（品牌色，内部可信来源）
//   互联网   = 靛蓝（外部来源，与内部知识一眼区分）
//   定时任务 = 琥珀（时间/计划相关，见 CHAT_MESSAGE_MODE_CHIP_CLASS）
// 都是「8% 淡底 + 20% 同色描边 + 中深同色字」，色相区分但明度统一，不会花。
export const CHAT_CITATIONS_CLASS =
  'mt-[12px] grid min-w-0 max-w-full gap-[8px] overflow-hidden border-t border-[#f0efec] pt-[10px]';
export const CHAT_CITATION_HEADING_CLASS =
  'inline-flex items-center gap-[6px] text-[12px] font-semibold';
// 纯企业知识 → 青绿；混合来源 → 退回中性灰。混合时若跟着网页走靛蓝，
// 标题一片靛蓝、下面多数 chip 却是青绿，反而像配色出错。
export const CHAT_CITATION_HEADING_KNOWLEDGE_CLASS = 'text-[#0d6b63]';
export const CHAT_CITATION_HEADING_WEB_CLASS = 'text-[#6d6d72]';
export const CHAT_CITATION_LIST_CLASS = 'flex min-w-0 max-w-full flex-wrap gap-[6px] overflow-hidden';
export const CHAT_CITATION_CHIP_CLASS =
  'inline-flex min-w-0 max-w-full items-center gap-[6px] overflow-hidden rounded-[8px] border px-[9px] py-[5px] text-left text-[12px] transition-colors';
export const CHAT_CITATION_CHIP_KNOWLEDGE_CLASS =
  'border-[rgba(15,118,110,0.20)] bg-[rgba(15,118,110,0.07)] text-[#2b524e] hover:border-[rgba(15,118,110,0.36)] hover:bg-[rgba(15,118,110,0.12)]';
export const CHAT_CITATION_CHIP_WEB_CLASS =
  'border-[rgba(79,95,208,0.22)] bg-[rgba(79,95,208,0.07)] text-[#3a4590] hover:border-[rgba(79,95,208,0.38)] hover:bg-[rgba(79,95,208,0.12)]';
// 序号直接继承 chip 的文字色、只加粗：在淡彩底上再垫一块白，会像打了个补丁。
export const CHAT_CITATION_INDEX_CLASS = 'shrink-0 font-semibold';
export const CHAT_CITATION_TITLE_CLASS = 'min-w-0 truncate';
// 右侧小标（网页站点名 / 合并次数）继承 chip 的色相，只压低透明度。
export const CHAT_CITATION_COUNT_CLASS =
  'shrink-0 rounded-full bg-white/70 px-[6px] py-[1px] text-[10px] font-semibold text-current opacity-80';

// ---------------------------------------------------------------------------
// Message attachments (in-bubble)
// ---------------------------------------------------------------------------
export const CHAT_ATTACHMENT_LIST_CLASS = 'mt-[10px] grid gap-[8px]';
export const CHAT_ATTACHMENT_CARD_CLASS =
  'grid min-h-[46px] w-[min(280px,100%)] grid-cols-[36px_minmax(0,1fr)] items-center gap-[10px] rounded-[10px] border border-[rgba(24,24,26,0.08)] bg-[#f2f1ee] p-[7px]';
export const CHAT_ATTACHMENT_IMG_CLASS = 'size-[36px] rounded-[8px] object-cover';
export const CHAT_ATTACHMENT_FILE_ICON_CLASS =
  'inline-grid size-[36px] place-items-center rounded-[8px] bg-[#eeece9] text-[rgba(24,24,26,0.8)]';
export const CHAT_ATTACHMENT_COPY_CLASS = 'grid min-w-0 gap-px';
export const CHAT_ATTACHMENT_NAME_CLASS = 'truncate text-[12px] font-medium text-[#18181a]';
export const CHAT_ATTACHMENT_META_CLASS = 'truncate text-[11px] text-[#6d6d72]';

// ---------------------------------------------------------------------------
// Harness-generated artifacts
// ---------------------------------------------------------------------------
export const CHAT_ARTIFACTS_CLASS =
  'mt-[12px] grid min-w-0 max-w-full gap-[8px] border-t border-[#f0efec] pt-[10px]';
export const CHAT_ARTIFACT_HEADING_CLASS =
  'inline-flex items-center gap-[6px] text-[12px] font-semibold text-[#6d6d72]';
export const CHAT_ARTIFACT_LIST_CLASS = 'grid min-w-0 max-w-[560px] gap-[6px]';
export const CHAT_ARTIFACT_BUTTON_CLASS =
  'grid min-h-[46px] w-full max-w-[320px] grid-cols-[32px_minmax(0,1fr)_24px] items-center gap-[9px] rounded-[10px] border border-[rgba(24,24,26,0.08)] bg-[#f2f1ee] px-[8px] py-[6px] text-left text-[rgba(24,24,26,0.8)] transition-colors hover:border-[rgba(24,24,26,0.12)] hover:bg-white disabled:cursor-wait disabled:opacity-60';
export const CHAT_ARTIFACT_ICON_CLASS =
  'inline-grid size-[32px] place-items-center rounded-[8px] bg-[#eeece9] text-[rgba(24,24,26,0.8)]';
export const CHAT_ARTIFACT_COPY_CLASS = 'grid min-w-0 gap-px';
export const CHAT_ARTIFACT_NAME_CLASS = 'truncate text-[12px] font-medium text-[#18181a]';
export const CHAT_ARTIFACT_META_CLASS = 'truncate text-[11px] text-[#6d6d72]';
export const CHAT_ARTIFACT_IMAGE_CARD_CLASS =
  'grid w-[min(560px,100%)] min-w-0 overflow-hidden rounded-[12px] border border-[rgba(24,24,26,0.08)] bg-[#f2f1ee] shadow-[0_8px_24px_rgba(30,45,70,0.06)]';
export const CHAT_ARTIFACT_IMAGE_LINK_CLASS =
  'group relative grid min-h-[120px] max-h-[420px] place-items-center overflow-hidden bg-[linear-gradient(45deg,#f0efec_25%,transparent_25%),linear-gradient(-45deg,#f0efec_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f0efec_75%),linear-gradient(-45deg,transparent_75%,#f0efec_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0]';
export const CHAT_ARTIFACT_IMAGE_CLASS =
  'block max-h-[420px] max-w-full object-contain transition duration-200 group-hover:scale-[1.01]';
export const CHAT_ARTIFACT_IMAGE_PLACEHOLDER_CLASS =
  'grid min-h-[140px] w-full place-items-center px-[20px] text-center text-[12px] text-[#6d6d72]';
export const CHAT_ARTIFACT_IMAGE_FOOTER_CLASS =
  'grid min-w-0 grid-cols-[minmax(0,1fr)_32px] items-center gap-[10px] border-t border-[#eeece9] bg-white px-[10px] py-[8px]';
export const CHAT_ARTIFACT_IMAGE_DOWNLOAD_CLASS =
  'inline-grid size-[32px] place-items-center rounded-[8px] border border-[rgba(24,24,26,0.08)] bg-white text-[rgba(24,24,26,0.8)] transition hover:border-[rgba(24,24,26,0.12)] hover:bg-[#f2f1ee] disabled:cursor-wait disabled:opacity-60';

// ---------------------------------------------------------------------------
// Feedback actions
// ---------------------------------------------------------------------------
export const CHAT_FEEDBACK_CLASS = 'mt-[4px] flex items-center gap-[2px]';
export const CHAT_FEEDBACK_BTN_CLASS =
  'inline-grid size-[26px] place-items-center rounded-[8px] border-0 bg-transparent p-0 text-[#9a9a9f] transition-colors hover:bg-[#f0efec] hover:text-[#18181a]';
export const CHAT_FEEDBACK_BTN_ACTIVE_CLASS =
  'bg-[#ffe1e1] text-[#d11a1a] hover:bg-[#ffe1e1] hover:text-[#d11a1a]';
export const CHAT_FEEDBACK_BTN_DISLIKE_ACTIVE_CLASS =
  'bg-[#dbf6e4] text-[#0e9b46] hover:bg-[#dbf6e4] hover:text-[#0e9b46]';

// ---------------------------------------------------------------------------
// Empty state (Hello {name})
// ---------------------------------------------------------------------------
// 空态不再自己带 8vh 顶距：现在它被窗口包着，由 MessageList 的
// `min-h-full + justify-center` 在窗口里垂直居中（下方再留 4vh 抵消视觉重心）。
export const CHAT_EMPTY_CLASS =
  'mx-auto flex w-full max-w-[640px] flex-col gap-[16px]';
export const CHAT_EMPTY_GREETING_CARD_CLASS =
  'flex w-full items-end justify-between rounded-[20px] bg-[#e5e4e0] pl-[8px] pr-[16px]';
export const CHAT_EMPTY_TITLE_CLASS = 'text-[26px] font-semibold leading-[1.25] tracking-[-0.02em] text-[#18181a]';
export const CHAT_EMPTY_SUBTITLE_CLASS = 'text-[13.5px] font-normal text-[#6d6d72]';
export const CHAT_EMPTY_CARD_CLASS =
  'flex w-full items-stretch gap-[8px] rounded-[20px] bg-[#e5e4e0] p-[16px]';
export const CHAT_EMPTY_ROLE_CLASS = 'line-clamp-2 text-[12px] capitalize leading-[1.5] text-[#6d6d72]';
export const CHAT_EMPTY_TAGS_CLASS =
  'flex flex-wrap items-center gap-[6px] [&>span]:rounded-full [&>span]:bg-[rgba(24,24,26,0.05)] [&>span]:px-[9px] [&>span]:py-[3px] [&>span]:text-[11px] [&>span]:capitalize [&>span]:text-[#6d6d72]';
export const CHAT_EMPTY_STAT_CELL_CLASS =
  'flex flex-1 flex-col justify-center gap-[4px] px-[16px] py-[8px] capitalize text-[rgba(24,24,26,0.8)] [&:not(:first-child)]:border-l-[0.5px] [&:not(:first-child)]:border-[rgba(24,24,26,0.08)]';

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
// 输入坞**不再是一张带边框的卡**：外壳退成纯留白容器，没有任何底色/描边/圆角。
// 屏幕上唯一的实体就是那张纯白输入框，层级从三层（纸 → 暖白坞 → 白框）收成两层。
// 宽度必须与上方消息卡**用同一个表达式**（mx-auto w-full max-w-768），两卡才会
// 在任何视口都同宽同位；这里千万别再写 px-20 —— 那是「先缩进再居中」，在
// 744 < 列宽 < 808 的中间区间会与消息卡错开 4px（窄屏实测就是错的）。
export const CHAT_INPUT_SHELL_CLASS = 'relative mx-auto flex w-full max-w-[768px] shrink-0 flex-col';
// 768 = 消息卡宽度（CHAT_MESSAGE_SHELL_CLASS 的 max-w）。输入框与消息卡同宽，
// 且 form p-10 + textarea px-10 = 左右各 20，与消息卡 px-20 的内边距同档，
// 所以外框、文字左缘、文字右缘三层全部对齐。
export const CHAT_COMPOSER_STAGE_CLASS = 'relative w-full min-w-0';
// 「互联网检索」开关胶囊：坐在输入卡的工具行里（加号右侧）。开/关两态的配色
// 在 Composer 内拼：关 = 浅墨底灰字，开 = 品牌青绿底深青字（高对比）。
export const CHAT_COMPOSER_WEB_SEARCH_CLASS =
  'inline-flex h-[27px] shrink-0 cursor-pointer items-center gap-[6px] rounded-full border px-[9px] text-[12px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e]/30';
// 外壳去掉后，这张白框是输入区唯一的实体，直接浮在纸背景上：卡面、圆角、
// 描边、阴影全部来自 CHAT_SURFACE_CARD_CLASS —— 和上方消息窗口逐像素同款。
export const CHAT_COMPOSER_FORM_CLASS = cn(
  'relative flex min-w-0 flex-1 flex-col gap-[8px] p-[10px] transition-colors',
  CHAT_SURFACE_CARD_CLASS,
);
export const CHAT_COMPOSER_FORM_DRAG_CLASS = 'bg-[rgba(15,118,110,0.05)] ring-[1px] ring-[#0f766e]';
export const CHAT_COMPOSER_DROP_HINT_CLASS =
  'pointer-events-none absolute inset-0 z-[2] grid place-items-center rounded-[18px] bg-white/85 text-[14px] font-medium text-[#18181a] backdrop-blur-sm';
// 卡内水平内边距 10（form）+ 10（textarea）= 20，正好等于消息列的 px-20：
// 输入的文字与上方消息正文、头像落在同一条竖线上。
export const CHAT_COMPOSER_TEXTAREA_CLASS =
  'min-h-[46px] min-w-0 max-h-[200px] w-full flex-1 resize-none border-0 bg-transparent px-[10px] py-[4px] text-[14.5px] leading-[1.7] text-[#18181a] shadow-none outline-none placeholder:text-[#9a9a9f] focus-visible:ring-0';
export const CHAT_COMPOSER_TEXTAREA_WITH_COMMAND_CLASS =
  'min-h-[32px] py-[4px] leading-[24px]';
export const CHAT_COMPOSER_INPUT_ROW_CLASS = 'flex min-w-0 items-start gap-[8px]';
export const CHAT_COMPOSER_COMMAND_CHIP_CLASS =
  'group/command inline-flex h-[32px] max-w-[min(300px,100%)] shrink-0 items-center gap-[7px] rounded-[9px] border border-[rgba(24,24,26,0.10)] bg-[#f2f1ee] py-[4px] pl-[6px] pr-[5px] text-[rgba(24,24,26,0.8)] shadow-[0_1px_2px_rgba(24,24,26,0.04)] transition-colors hover:border-[rgba(24,24,26,0.16)] hover:bg-[#f0efec]';
export const CHAT_COMPOSER_COMMAND_ICON_CLASS =
  'inline-grid size-[22px] shrink-0 place-items-center rounded-[6px] bg-white text-[#4b4b50] shadow-[inset_0_0_0_1px_rgba(227,231,241,0.92)]';
export const CHAT_COMPOSER_COMMAND_LABEL_CLASS =
  'min-w-0 truncate text-[12px] font-medium text-[#3a3a3e]';
// 命令类型标签：SOP = 青绿（内部流程）、技能 = 靛蓝（模型能力）、工具 = 琥珀（外部动作）。
// 和引用来源共用同一套色相 —— 全站只有「青绿 / 靛蓝 / 琥珀 + 失败红」四档，
// 每个色相都有固定语义，不会变成随机彩虹。
export const CHAT_COMPOSER_COMMAND_KIND_CLASS =
  'shrink-0 rounded-full px-[6px] py-px text-[9px] font-medium leading-[1.4]';
export const CHAT_COMMAND_KIND_TONE_CLASS: Record<'sop' | 'skill' | 'tool', string> = {
  sop: 'bg-[rgba(15,118,110,0.10)] text-[#0d6b63]',
  skill: 'bg-[rgba(79,95,208,0.10)] text-[#3b47a8]',
  tool: 'bg-[rgba(180,110,10,0.10)] text-[#8a5606]',
};
export const CHAT_COMPOSER_COMMAND_REMOVE_CLASS =
  'inline-grid size-[18px] shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 text-[15px] leading-none text-[#9a9a9f] transition-colors hover:bg-[#18181a] hover:text-white focus-visible:bg-[#18181a] focus-visible:text-white focus-visible:outline-none';
export const CHAT_COMPOSER_ATTACHMENTS_CLASS = 'flex flex-wrap gap-[8px]';
export const CHAT_COMPOSER_ATTACHMENT_CHIP_CLASS =
  'inline-flex max-w-[240px] items-center gap-[7px] rounded-[9px] border-0 bg-[rgba(24,24,26,0.05)] py-[5px] pl-[7px] pr-[6px] text-[12px] text-[rgba(24,24,26,0.8)]';
export const CHAT_COMPOSER_ATTACHMENT_ERROR_CLASS = 'border-[#f38989] bg-[#fce7e7] text-[#d20b0b]';
export const CHAT_COMPOSER_ATTACHMENT_IMG_CLASS = 'size-[24px] rounded-[6px] object-cover';
export const CHAT_COMPOSER_ATTACHMENT_COPY_CLASS = 'grid min-w-0 gap-px';
export const CHAT_COMPOSER_ATTACHMENT_NAME_CLASS = 'truncate text-[12px] font-medium text-[#18181a]';
export const CHAT_COMPOSER_ATTACHMENT_STATUS_CLASS = 'truncate text-[11px] text-[#6d6d72]';
export const CHAT_COMPOSER_ATTACHMENT_REMOVE_CLASS =
  'inline-grid size-[18px] shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 text-[15px] leading-none text-[#9a9a9f] hover:text-[#18181a]';

export const CHAT_COMPOSER_TOOLBAR_CLASS = 'flex items-center justify-between gap-[10px]';
export const CHAT_COMPOSER_CONTEXT_ROW_CLASS = 'flex min-w-0 items-center gap-[8px]';
export const CHAT_COMPOSER_ACTIONS_ROW_CLASS = 'flex shrink-0 items-center gap-[8px]';
export const CHAT_COMPOSER_PLUS_BTN_CLASS =
  'inline-grid size-[30px] place-items-center rounded-full border-0 bg-transparent p-0 text-[#6d6d72] transition-colors hover:bg-[rgba(24,24,26,0.06)] hover:text-[#18181a] disabled:cursor-not-allowed disabled:opacity-45';
export const CHAT_COMPOSER_INTENT_CHIP_CLASS =
  'inline-flex cursor-pointer items-center gap-[5px] rounded-full border border-[rgba(24,24,26,0.08)] bg-[#f0efec] py-[4px] pl-[6px] pr-[10px] text-[12px] font-medium text-[rgba(24,24,26,0.8)] transition-colors hover:border-[rgba(24,24,26,0.12)] hover:text-[#18181a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(24,24,26,0.12)] focus-visible:ring-offset-1';
export const CHAT_COMPOSER_HINT_CLASS = 'truncate text-[11px] text-[#9a9a9f] max-[560px]:hidden';
export const CHAT_COMPOSER_MODEL_BTN_CLASS =
  'inline-flex h-[30px] max-w-[200px] items-center gap-[5px] rounded-full border-0 bg-transparent px-[10px] text-[11.5px] font-normal text-[#6d6d72] shadow-none transition-colors hover:bg-[rgba(24,24,26,0.06)] hover:text-[#18181a] disabled:cursor-not-allowed disabled:opacity-45 aria-expanded:bg-[rgba(24,24,26,0.06)] aria-expanded:text-[#18181a] [&>span:first-child]:min-w-0 [&>span:first-child]:truncate';
export const CHAT_COMPOSER_SEND_BTN_CLASS =
  'inline-grid size-[32px] place-items-center rounded-full bg-[#18181a] p-0 text-white transition-colors hover:bg-[#2e2e32] disabled:cursor-not-allowed disabled:opacity-40';
export const CHAT_COMPOSER_STOP_BTN_CLASS = 'bg-[#d20b0b] hover:bg-[#b40a0a]';

export const CHAT_MENU_CONTENT_CLASS =
  'flex flex-col gap-[6px] rounded-[14px] border-0 bg-white p-[6px] shadow-[0px_16px_15px_rgba(0,0,0,0.1)] ring-0 [--accent:#e5e4e0] [--accent-foreground:#18181A]';
export const CHAT_MENU_ITEM_CLASS =
  'h-[36px] cursor-pointer gap-[8px] rounded-[10px] px-[12px] text-[14px] text-[rgba(24,24,26,0.8)]';

export const CHAT_MODEL_MENU_ITEM_CLASS =
  'flex h-auto cursor-pointer items-center justify-between gap-[16px] rounded-[10px] px-[12px] py-[8px] text-[rgba(24,24,26,0.8)]';
export const CHAT_MODEL_MENU_COPY_CLASS = 'grid min-w-0 gap-px';
export const CHAT_MODEL_MENU_NAME_CLASS = 'truncate text-[13px] font-medium text-[#18181a]';
export const CHAT_MODEL_MENU_DETAIL_CLASS = 'truncate text-[11px] text-[#6d6d72]';

// ---------------------------------------------------------------------------
// Scheduled task draft card
// ---------------------------------------------------------------------------
export const CHAT_DRAFT_CARD_CLASS =
  'mt-[12px] grid gap-[12px] rounded-[14px] border-[0.5px] border-[rgba(24,24,26,0.08)] bg-[#f2f1ee] p-[14px]';
export const CHAT_DRAFT_CARD_CREATED_CLASS = 'border-[#96d9b0] bg-[#f2fbf5]';
export const CHAT_DRAFT_HEADER_CLASS = 'flex items-start justify-between gap-[12px]';
export const CHAT_DRAFT_IDENTITY_CLASS = 'flex min-w-0 items-center gap-[10px]';
export const CHAT_DRAFT_ICON_CLASS =
  'inline-grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-[#eeece9] text-[rgba(24,24,26,0.8)]';
export const CHAT_DRAFT_KICKER_CLASS = 'text-[11px] font-medium text-[#6d6d72]';
export const CHAT_DRAFT_TITLE_CLASS = 'text-[14px] font-semibold text-[#18181a]';
export const CHAT_DRAFT_TOP_ACTIONS_CLASS = 'flex shrink-0 items-center gap-[6px]';
export const CHAT_DRAFT_CREATED_BADGE_CLASS =
  'inline-flex items-center gap-[4px] rounded-full bg-[#e9f7ef] px-[10px] py-[3px] text-[12px] font-medium text-[#018434]';
export const CHAT_DRAFT_META_GRID_CLASS = 'grid grid-cols-3 gap-[10px] max-[520px]:grid-cols-1';
export const CHAT_DRAFT_META_ITEM_CLASS =
  'grid gap-[3px] rounded-[10px] bg-white px-[10px] py-[8px] [&>span]:text-[11px] [&>span]:text-[#6d6d72] [&>strong]:text-[13px] [&>strong]:font-medium [&>strong]:text-[#18181a]';
export const CHAT_DRAFT_PROMPT_CLASS =
  'grid gap-[4px] [&>span]:text-[11px] [&>span]:text-[#6d6d72] [&>p]:text-[13px] [&>p]:leading-[1.6] [&>p]:text-[rgba(24,24,26,0.8)]';
export const CHAT_DRAFT_EDITOR_CLASS =
  'grid grid-cols-2 gap-[10px] max-[520px]:grid-cols-1 [&_label]:grid [&_label]:gap-[5px] [&_label>span]:text-[12px] [&_label>span]:text-[#6d6d72]';
export const CHAT_DRAFT_EDITOR_FULL_CLASS = 'col-span-full';
export const CHAT_DRAFT_FOOTER_CLASS = 'flex justify-end gap-[8px]';

// ---------------------------------------------------------------------------
// Dialogs (handoff inbox + citation detail + rename)
// ---------------------------------------------------------------------------
export const CHAT_HANDOFF_LIST_CLASS = 'grid max-h-[60vh] gap-[14px] overflow-y-auto';
export const CHAT_HANDOFF_CARD_CLASS = 'grid gap-[12px] rounded-[14px] border border-[rgba(24,24,26,0.08)] bg-[#f2f1ee] p-[16px]';
export const CHAT_HANDOFF_HEAD_CLASS =
  'flex items-center gap-[10px] [&_strong]:block [&_strong]:text-[14px] [&_strong]:font-semibold [&_strong]:text-[#18181a] [&_span]:text-[12px] [&_span]:text-[#6d6d72]';
export const CHAT_HANDOFF_BLOCK_CLASS =
  'grid gap-[4px] [&>span]:text-[12px] [&>span]:font-medium [&>span]:text-[#6d6d72] [&>p]:text-[13px] [&>p]:leading-[1.6] [&>p]:text-[rgba(24,24,26,0.8)]';
export const CHAT_HANDOFF_ACTIONS_CLASS = 'flex justify-end gap-[8px]';
export const CHAT_HANDOFF_EMPTY_CLASS = 'py-[36px] text-center text-[13px] text-[#6d6d72]';

export const CHAT_CITATION_DETAIL_CLASS = 'grid w-full min-w-0 gap-[14px]';
export const CHAT_CITATION_DETAIL_EYEBROW_CLASS = 'text-[12px] font-medium text-[#6d6d72]';
export const CHAT_CITATION_DETAIL_TITLE_CLASS = 'text-[18px] font-semibold text-[#18181a]';
export const CHAT_CITATION_DETAIL_INDEX_CLASS = 'shrink-0 rounded-[4px] bg-[#f0efec] px-[6px] py-[1px] text-[12px] font-semibold text-[#18181a]';
export const CHAT_CITATION_DETAIL_SECTION_CLASS =
  'grid w-full min-w-0 gap-[5px] [&>span]:text-[12px] [&>span]:font-medium [&>span]:text-[#6d6d72] [&>p]:text-[13px] [&>p]:leading-[1.7] [&>p]:text-[rgba(24,24,26,0.8)]';
export const CHAT_CITATION_DETAIL_QUOTE_CLASS =
  'm-0 max-h-[min(52vh,520px)] overflow-y-auto overscroll-contain rounded-[10px] border-l-[3px] border-[rgba(24,24,26,0.08)] bg-[#f2f1ee] px-[12px] py-[8px] text-[13px] leading-[1.7] whitespace-pre-wrap wrap-anywhere text-[rgba(24,24,26,0.8)]';
export const CHAT_CITATION_DETAIL_MARKDOWN_CLASS =
  'max-h-[min(52vh,520px)] w-full min-w-0 max-w-full overflow-y-auto overscroll-contain rounded-[10px] border-l-[3px] border-[rgba(24,24,26,0.08)] bg-[#f2f1ee] px-[12px] py-[8px] [&>div]:w-full [&>div]:min-w-0 [&>div]:max-w-none [&>div]:text-[13px] [&>div]:leading-[1.7] [&>div]:text-[rgba(24,24,26,0.8)] [&_h1]:text-[16px] [&_h2]:text-[15px] [&_h3]:text-[14px] [&_h4]:text-[13px] [&_p]:wrap-anywhere [&_li]:wrap-anywhere [&_code]:wrap-anywhere [&_a]:wrap-anywhere';
export const CHAT_CITATION_DETAIL_GRID_CLASS =
  'grid grid-cols-2 gap-[12px] max-[520px]:grid-cols-1 [&>div]:grid [&>div]:gap-[3px] [&_span]:text-[11px] [&_span]:text-[#6d6d72] [&_strong]:text-[13px] [&_strong]:font-medium [&_strong]:text-[#18181a]';
export const CHAT_CITATION_DETAIL_NOTE_CLASS = 'text-[12px] leading-[1.6] text-[#6d6d72]';
export const CHAT_CITATION_DETAIL_MERGE_CLASS =
  'grid min-w-0 gap-[6px] rounded-[10px] border border-[#eeece9] bg-white p-[10px]';
export const CHAT_CITATION_DETAIL_MERGE_HEAD_CLASS =
  'inline-flex min-w-0 items-center gap-[8px] text-[12px] font-semibold text-[#18181a]';
export const CHAT_CITATION_DETAIL_MERGE_META_CLASS =
  'min-w-0 truncate text-[12px] font-normal text-[#6d6d72]';

export const CHAT_DEBUG_PANEL_CLASS =
  'mx-auto mt-[16px] max-w-[820px] overflow-auto rounded-[10px] bg-[#1e1e1e] p-[12px] text-[12px] text-[rgba(24,24,26,0.14)]';

// ---------------------------------------------------------------------------
// A2UI slot form card（缺槽询问的表单卡片）
// ---------------------------------------------------------------------------
export const CHAT_SLOT_FORM_CARD_CLASS =
  'mt-[12px] grid gap-[12px] rounded-[14px] border-[0.5px] border-[rgba(24,24,26,0.08)] bg-white p-[14px]';
export const CHAT_SLOT_FORM_HEADER_CLASS = 'flex items-center gap-[10px]';
export const CHAT_SLOT_FORM_ICON_CLASS =
  'inline-grid size-[32px] shrink-0 place-items-center rounded-[10px] bg-[#eef4ff] text-[#1a71ff]';
export const CHAT_SLOT_FORM_HEADING_CLASS = 'grid min-w-0 gap-[2px]';
export const CHAT_SLOT_FORM_TITLE_CLASS = 'text-[14px] font-semibold text-[#18181a]';
export const CHAT_SLOT_FORM_KICKER_CLASS = 'truncate text-[11px] text-[#6d6d72]';
export const CHAT_SLOT_FORM_GRID_CLASS = 'grid gap-[10px] max-[520px]:gap-[12px]';
export const CHAT_SLOT_FORM_FIELD_CLASS = 'grid gap-[6px]';
export const CHAT_SLOT_FORM_LABEL_CLASS =
  'inline-flex items-center gap-[4px] text-[12px] font-medium text-[rgba(24,24,26,0.8)]';
export const CHAT_SLOT_FORM_REQUIRED_CLASS = 'text-[#e5484d]';
export const CHAT_SLOT_FORM_CHOICE_ROW_CLASS = 'flex items-center gap-[8px]';
export const CHAT_SLOT_FORM_CHOICE_CLASS =
  'h-[34px] min-w-[72px] rounded-[10px] border-[0.5px] border-[rgba(24,24,26,0.10)] bg-white px-[14px] text-[13px] text-[rgba(24,24,26,0.8)] transition-colors hover:border-[#1a71ff] hover:text-[#1a71ff]';
export const CHAT_SLOT_FORM_CHOICE_ACTIVE_CLASS =
  'border-[#1a71ff] bg-[#eef4ff] font-medium text-[#1a71ff]';
export const CHAT_SLOT_FORM_ERROR_CLASS = 'text-[12px] text-[#e5484d]';
export const CHAT_SLOT_FORM_FOOTER_CLASS =
  'flex items-center justify-between gap-[12px] max-[520px]:flex-col max-[520px]:items-stretch';
export const CHAT_SLOT_FORM_HINT_CLASS = 'text-[12px] text-[#6d6d72]';
export const CHAT_SLOT_FORM_SUBMITTED_CLASS =
  'flex items-center gap-[6px] text-[13px] font-medium text-[#018434]';

// ---------------------------------------------------------------------------
// Right context rail（会话上下文右栏）
//
// 位置：标题栏之下、与消息列左右并排；只在 >=1280px 出现（xl断点），
// 窄屏收起，全局按钮仍留在标题栏右侧。
// 视觉：白卡 + 0.5px 发丝线，和消息气泡同一套线性语言，不加阴影层级。
// ---------------------------------------------------------------------------
/** 12px 外边距：中间窗口与右栏卡片共用一条上/下基线，四周都留出纸背景。 */
export const CHAT_BODY_CLASS = 'flex min-h-0 min-w-0 flex-1 gap-[12px] px-[12px] pb-[12px] pt-[2px]';
/**
 * 中间列：上卡是消息窗口（白卡），下卡退化成**只有输入框本身**（无外壳），
 * 两块共用同一条宽度与同一条中线。
 *
 * 宽度来源：两处都用 `mx-auto w-full max-w-[768px]` ——
 *   消息卡  = max-w-768（卡内 px-20，内容 728）
 *   输入框  = max-w-768（form p-10 + textarea px-10，内容 728）
 * 所以不只外框同宽，文字左右缘也对齐。别再给任一侧单独写 808/816。
 */
export const CHAT_COLUMN_CLASS = 'flex min-h-0 min-w-0 flex-1 flex-col gap-[10px]';
/** 上卡：消息窗口。与下方输入框**同一张卡**（CHAT_SURFACE_CARD_CLASS）：
 *  同圆角 18px、同 0.5px 描边、同浮起阴影，宽度也同为 max-w-768。 */
export const CHAT_MESSAGE_SHELL_CLASS = cn(
  'mx-auto flex min-h-0 w-full max-w-[768px] flex-1 flex-col overflow-hidden',
  CHAT_SURFACE_CARD_CLASS,
);
// 右栏 = 一列**独立小卡**（参考 handoff 面板的右列：卡片之间留缝，各自圆角，
// 卡内再嵌一块更浅的内容块）。之前是一整张卡靠发丝线分段，四段读起来像一个
// 长列表；拆开之后每一段都能单独被看到，高度也随内容走。
export const CHAT_RAIL_CLASS =
  'hidden w-[288px] shrink-0 flex-col gap-[10px] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:rgba(24,24,26,0.12)_transparent] xl:flex';
export const CHAT_RAIL_CARD_CLASS = cn(
  'flex shrink-0 flex-col overflow-hidden',
  CHAT_SURFACE_CARD_CLASS,
);
// 卡头：小图标方块 + 标题 + 右上角计数/耗时，和参考图的卡头同构。
export const CHAT_RAIL_CARD_HEAD_CLASS = 'flex shrink-0 items-center gap-[8px] px-[11px] pt-[10px] pb-[7px]';
export const CHAT_RAIL_CARD_ICON_CLASS =
  'grid size-[22px] shrink-0 place-items-center rounded-[7px] bg-[#f2f1ee] text-[#6d6d72] [&>svg]:size-[12px]';
// 卡头图标按卡片语义分色（同一套三色，不额外引入色相）：
//   本轮执行 = 琥珀（动作/耗时）、会话 = 靛蓝（配置/环境）、引用与能力 = 青绿（知识）。
// 只是 9% 淡底 + 同色图标，比满栏灰更像「有信息层级」，也不会抢内容。
export const CHAT_RAIL_CARD_TONE_CLASS: Record<'teal' | 'indigo' | 'amber', string> = {
  teal: 'bg-[rgba(15,118,110,0.09)] text-[#0f766e]',
  indigo: 'bg-[rgba(79,95,208,0.09)] text-[#4453c4]',
  amber: 'bg-[rgba(180,110,10,0.10)] text-[#8a5606]',
};
export const CHAT_RAIL_CARD_TITLE_CLASS = 'truncate text-[12.5px] font-medium leading-[1.4] text-[#3d3d3f]';
export const CHAT_RAIL_CARD_META_CLASS = 'ml-auto shrink-0 text-[11px] leading-none tabular-nums text-[#9a9a9f]';
// 卡内内容块：比卡面再浅一档，和输入坞里「暖白底 + 白输入框」同一套层次。
export const CHAT_RAIL_BODY_CLASS = 'mx-[7px] mb-[7px] rounded-[12px] bg-[#faf9f6] px-[7px] py-[2px]';
/** 最后一张卡吃掉剩余高度：右栏底部与左侧输入卡齐平，不在下面留一截纸背景。 */
export const CHAT_RAIL_CARD_GROW_CLASS = 'flex-1';
export const CHAT_RAIL_BODY_GROW_CLASS = 'flex flex-1 flex-col';
export const CHAT_RAIL_HEAD_CLASS = 'flex shrink-0 items-center gap-[10px] px-[12px] py-[11px]';
export const CHAT_RAIL_HEAD_NAME_CLASS = 'truncate text-[14px] font-medium leading-[1.35] tracking-[-0.005em] text-[#18181a]';
export const CHAT_RAIL_HEAD_META_CLASS = 'mt-[3px] truncate text-[11.5px] leading-[1.4] text-[#6d6d72]';
// 员工卡右上角的入口按钮（原来是一条底部整行按钮，拆卡后收成图标）。
export const CHAT_RAIL_HEAD_ACTION_CLASS =
  'grid size-[26px] shrink-0 place-items-center rounded-[8px] text-[#a3a3a8] transition-colors hover:bg-[#f2f1ee] hover:text-[#3d3d3f] disabled:cursor-not-allowed disabled:opacity-40';
export const CHAT_RAIL_ROW_CLASS =
  'flex items-center gap-[8px] rounded-[8px] px-[2px] py-[5px] text-[12.5px] leading-[1.5] text-[rgba(24,24,26,0.8)]';
export const CHAT_RAIL_ROW_TEXT_CLASS = 'min-w-0 flex-1 truncate';
export const CHAT_RAIL_ROW_VALUE_CLASS = 'shrink-0 text-[11px] tabular-nums text-[#9a9a9f]';
export const CHAT_RAIL_ROW_VALUE_ON_CLASS = 'shrink-0 text-[11px] text-[#0f766e]';
export const CHAT_RAIL_ICON_CLASS =
  'grid w-[16px] shrink-0 place-items-center text-[#6d6d72] [&>svg]:size-[12px]';
export const CHAT_RAIL_STEP_TEXT_CLASS = 'min-w-0 flex-1 truncate text-[12.5px] leading-[1.5] text-[rgba(24,24,26,0.8)]';
export const CHAT_RAIL_STEP_TEXT_FAILED_CLASS = 'min-w-0 flex-1 truncate text-[12.5px] leading-[1.5] text-[#d20b0b]';
export const CHAT_RAIL_EMPTY_CLASS = 'px-[2px] py-[6px] text-[11.5px] leading-[1.6] text-[#9a9a9f]';
