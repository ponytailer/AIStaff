import type { SceneBlockProps } from '../types';
import { SCENE_SECONDARY_BUTTON_CLASS } from './buttons';

/**
 * 空结果卡 —— `generic.*` 与 `travel.itinerary` 共用（`scene-v3-visual-contract.md` §2）。
 *
 * 为什么放在 `scenes/shared/` 而不是 `scenes/modules/_shared/`：`modules/*` 下每个带
 * `index.tsx` 的目录都会被注册表当成 module，共享组件放进去会让「目录名 === module_key」
 * 那条不变式出现例外，后来人一定会踩。
 *
 * ## 漏斗必须显示每一步的真实数字
 *
 * 来源是 `data.steps`（matcher 的 `steps` 数组），**不许前端重算** —— 自己算会和试跑
 * 面板对不上，而「试跑里 5→4→2、消息里 5→4→1」是最伤信任的一类不一致。
 * 后端老字段叫 `funnel`（arch §2.2 的 `empty` 形状），两种都认。
 *
 * ## 两个建议按钮不能省
 *
 * 它们是「让用户能继续」的关键：只给一段「没找到」会让用户卡死在这一轮。
 */

type EmptyStep = { key: string; label: string; from: number | null; to: number | null };

function readSteps(data: Record<string, unknown>): EmptyStep[] {
  const raw = Array.isArray(data.steps)
    ? data.steps
    : (Array.isArray(data.funnel) ? data.funnel : []);
  return raw
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map((row, index) => ({
      key: typeof row.key === 'string' ? row.key : `${index}:${String(row.label ?? '')}`,
      label: typeof row.label === 'string' ? row.label : '',
      from: typeof row.from === 'number' ? row.from : null,
      to: typeof row.to === 'number' ? row.to : null,
    }))
    .filter((row) => Boolean(row.label));
}

function readSuggestions(data: Record<string, unknown>): { label: string; sendText: string }[] {
  if (!Array.isArray(data.suggestions)) return [];
  return data.suggestions
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map((row) => ({
      label: typeof row.label === 'string' ? row.label : '',
      sendText: typeof row.send_text === 'string' ? row.send_text : '',
    }))
    .filter((row) => Boolean(row.label));
}

/** 与行程卡价格条共用同一套按钮尺寸（`shared/buttons.ts`）。 */
export const EMPTY_CARD_BUTTON_CLASS = SCENE_SECONDARY_BUTTON_CLASS;

export function SceneEmptyCard({
  block,
  title,
  sendText,
  disabled = false,
  dataModule = '',
}: {
  block: SceneBlockProps['block'];
  /** 卡头结论。缺省用 block 里给的 `title`，再缺省用通用文案。 */
  title?: string;
  sendText: SceneBlockProps['sendText'];
  disabled?: boolean;
  dataModule?: string;
}) {
  const data = block.data ?? {};
  const heading = title
    || (typeof data.title === 'string' && data.title.trim() ? data.title.trim() : '')
    || '没有找到符合条件的结果';
  const reason = typeof data.reason === 'string' && data.reason.trim()
    ? data.reason.trim()
    : (block.fallback_text || '');
  const steps = readSteps(data);
  const suggestions = readSuggestions(data);

  return (
    <div
      className="rounded-[13px] border border-[#f5e3b3] bg-[#fffdf5] px-[15px] py-[13px]"
      data-scene-empty={dataModule || block.kind}
    >
      <p className="mb-[5px] text-[12.5px] font-semibold text-[#7c5510]">{heading}</p>
      {reason ? (
        <p className="mb-[9px] text-[11.5px] leading-[1.6] text-[#7c5510]">{reason}</p>
      ) : null}

      {steps.length > 0 && (
        <div className="flex flex-col gap-[3px]">
          {steps.map((step, index) => {
            // `{前一步} →` 或 `{终止步数字}`（contract §2 的格式约定）。
            const isLast = index === steps.length - 1;
            const number = !isLast && step.from !== null
              ? `${step.from} →`
              : (step.to ?? step.from ?? '');
            return (
              <div key={step.key} className="flex items-center gap-[7px] text-[11px] text-[#7c5510]">
                <span className="min-w-[28px] font-mono">{number}</span>
                <span>{step.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {/*
        建议按钮区在 `on_empty="none"` 时必须整块消失。

        为什么不能只靠「后端不给 suggestions」：这里有一条 `suggestions.length > 0
        ? ... : [两颗兜底]` 的降级 —— 后端刻意不发建议时，前端会补上两颗
        「放宽条件再找一次 / 看看最接近的几条」，于是「只说明没有结果」
        这个配置在界面上完全看不出来（反而多出两个鼓励用户放宽的按钮）。
        配置项与渲染效果必须一一对应，所以这里显式判 `on_empty`。
      */}
      {block.data?.on_empty === 'none' ? null : (
        <div className="mt-[9px] flex flex-wrap gap-[7px]">
          {(suggestions.length > 0
            ? suggestions
            : [
              { label: '放宽条件再找一次', sendText: '放宽条件再找一次' },
              { label: '看看最接近的几条', sendText: '看看最接近的几条' },
            ]
          ).map((item) => (
            <button
              key={item.label}
              type="button"
              disabled={disabled}
              className={EMPTY_CARD_BUTTON_CLASS}
              onClick={() => sendText(item.sendText || item.label)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}