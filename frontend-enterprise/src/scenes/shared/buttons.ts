/**
 * 场景 module 共用的两颗按钮样式（`scene-v3-visual-contract.md` §1.5）。
 *
 * 抽出来是因为 §1.5（行程卡价格条）、§2（空结果卡建议按钮）、以及
 * `generic.table_match` 结果列表的「选这个」都是**同一颗按钮**：圆角 8、
 * padding 5/11、字号 11.5。三处各写一份必然漂成三种尺寸，而它们的差异
 * 在截图里只有 1~2px —— 每次改版都得重新量。
 *
 * 颜色只用项目 token：`--accent #0f766e` / `--accent` hover `#0c6158` /
 * `--border #ded7cc` / `--border-strong #cfc5b7` / `--ink-soft #343633`。
 */
export const SCENE_PRIMARY_BUTTON_CLASS =
  'rounded-[8px] border border-[#0f766e] bg-[#0f766e] px-[11px] py-[5px] text-[11.5px] '
  + 'font-semibold text-white transition-colors hover:bg-[#0c6158] '
  + 'disabled:cursor-not-allowed disabled:opacity-60';

export const SCENE_SECONDARY_BUTTON_CLASS =
  'rounded-[8px] border border-[#ded7cc] bg-white px-[11px] py-[5px] text-[11.5px] text-[#343633] '
  + 'transition-colors hover:border-[#cfc5b7] hover:bg-[#fbfaf6] '
  + 'disabled:cursor-not-allowed disabled:opacity-60';

/** 入口胶囊与文本块追问 chips 共用（contract §6）。 */
export const SCENE_CHIP_CLASS =
  'inline-flex items-center gap-[5px] rounded-full border border-[#ded7cc] bg-white '
  + 'px-[11px] py-[5px] text-[11.5px] text-[#343633] transition-colors '
  + 'hover:border-[#0f766e] hover:bg-[#e1f1ed] hover:text-[#0f766e] '
  + 'disabled:cursor-not-allowed disabled:opacity-60';

/** 「更多」胶囊：虚线边框、弱化文字（contract §6）。 */
export const SCENE_CHIP_MORE_CLASS =
  'inline-flex items-center gap-[5px] rounded-full border border-dashed border-[#ded7cc] bg-white '
  + 'px-[11px] py-[5px] text-[11.5px] text-[#9a9b95] transition-colors '
  + 'hover:border-[#0f766e] hover:text-[#0f766e] '
  + 'disabled:cursor-not-allowed disabled:opacity-60';