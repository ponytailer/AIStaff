import type { SceneBlockProps } from '../types';
import { SCENE_CHIP_CLASS } from './buttons';

/**
 * 平台的**默认文本渲染器**：`kind` 为 `text` / `handoff` 时用它。
 *
 * ## 为什么需要它（而不是让每个 module 自己实现）
 *
 * `BlockKind` 里 `text` / `handoff` 没有对应的 module 组件位（`types.ts` 的
 * 「kind → 组件」映射只给了 form / result / empty / step 四格）。这两类块是
 * **平台自己负责画**的：
 * - `text`：后端七个通道都会产（引言、空结果原因、话术正文、转人工提示）；
 * - `handoff`：只有 handoff 通道产。
 *
 * 如果平台不画，这两类块就只能永远是裸 `fallback_text`，那么 `generic.script`
 * 的「候选追问 chips」、`generic.handoff` 的「已收集信息摘要」两个 P0 能力
 * **一个都落不了地**（它们正好都只产 text / handoff 块）。
 *
 * ## 为什么只画到「纯文本 + chips」为止
 *
 * `docs/scenes/scene-v3-visual-contract.md` 给了 §1 行程卡、§2 空结果卡、§3 降级卡
 * 的逐值规格，**没有给 text / handoff 的卡片规格**。所以这里刻意**不做卡片容器**
 * （不加边框/底色/圆角）——纯段落 + 已定义的 chips。
 * 多加一个卡框就等于凭空发明一套视觉，而这正是契约要防的漂移。
 *
 * 用到的值全部来自契约其他地方：
 * - 正文 12.5px / line-height 1.65（demo `.asst-text`，与助手气泡正文同字号）；
 * - chips 圆角 999 / padding 5×11 / 11.5px / `--border`（契约 §6 `.chip`）；
 * - 摘要行 11.5px `--muted-soft`（契约 §1.2 副标题同款）。
 */

type Chip = { label: string; sendText: string };

function readChips(data: Record<string, unknown>): Chip[] {
  if (!Array.isArray(data.chips)) return [];
  return data.chips
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map((row) => ({
      label: typeof row.label === 'string' ? row.label.trim() : '',
      sendText: (typeof row.send_text === 'string' ? row.send_text : '').trim(),
    }))
    .filter((row) => Boolean(row.label));
}

/** `context.slots` → `[{label, value}]`；值本身是空的项不显示。 */
function readCollected(data: Record<string, unknown>): { key: string; value: string }[] {
  const context = data.context;
  if (!context || typeof context !== 'object') return [];
  const slots = (context as Record<string, unknown>).slots;
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return [];
  const out: { key: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(slots as Record<string, unknown>)) {
    if (raw === null || raw === undefined || raw === '') continue;
    const value = typeof raw === 'object' ? '' : String(raw).trim();
    if (!value) continue;
    out.push({ key, value });
  }
  return out;
}

export function SceneTextBlock({
  block,
  sendText,
  disabled = false,
}: Pick<SceneBlockProps, 'block' | 'sendText' | 'disabled'>) {
  const data = block.data ?? {};

  // 正文：`data.content` 优先；`handoff` 块没有 content，用 `data.summary`
  // （handoff 通道把它的 config.summary 放在这里）。
  const content = (typeof data.content === 'string' ? data.content : '').trim()
    || (block.kind === 'handoff' && typeof data.summary === 'string' ? data.summary.trim() : '')
    || (typeof block.fallback_text === 'string' ? block.fallback_text.trim() : '');

  const chips = readChips(data);
  const collected = block.kind === 'handoff' ? readCollected(data) : [];
  const target = block.kind === 'handoff' && typeof data.target === 'string'
    ? data.target.trim()
    : '';

  if (!content && chips.length === 0 && collected.length === 0) return null;

  return (
    <div data-scene-text={block.kind}>
      {content ? (
        <p className="m-0 text-[12.5px] leading-[1.65] whitespace-pre-wrap text-[#343633]">
          {content}
        </p>
      ) : null}

      {/* 转人工：已收集信息摘要。P0 `handoff.data` 是**宽松口径**（arch §2.2），
          所以这里只按 `context.slots` 的对象形态读，读不到就什么也不显示。 */}
      {collected.length > 0 && (
        <div className="mt-[6px] flex flex-col gap-[2px]">
          {target ? (
            <span className="text-[11.5px] text-[#9a9b95]">{`转给：${target}`}</span>
          ) : null}
          {collected.map((item) => (
            <span key={item.key} className="text-[11.5px] leading-[1.6] text-[#343633]">
              {`${item.key}：${item.value}`}
            </span>
          ))}
        </div>
      )}

      {/* 候选追问 chips（契约 §6 的 .chip 类名逐值）。交互一律走 sendText。 */}
      {chips.length > 0 && (
        <div className="mt-[7px] flex flex-wrap gap-[7px]">
          {chips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              className={SCENE_CHIP_CLASS}
              disabled={disabled}
              onClick={() => sendText(chip.sendText || chip.label)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}