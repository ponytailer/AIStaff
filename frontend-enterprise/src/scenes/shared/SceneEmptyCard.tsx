import type { SceneBlockProps } from '../types';
import { SCENE_SECONDARY_BUTTON_CLASS } from './buttons';

/**
 * 空结果卡 —— `generic.*` 与 `travel.itinerary` 共用（`scene-v3-visual-contract.md` §2）。
 *
 * 为什么放在 `scenes/shared/` 而不是 `scenes/modules/_shared/`：`modules/*` 下每个带
 * `index.tsx` 的目录都会被注册表当成 module，共享组件放进去会让「目录名 === module_key」
 * 那条不变式出现例外，后来人一定会踩。
 *
 * ## 漏斗默认不显示（2026-11-26）
 *
 * `data.steps` / `data.funnel` 仍被读取（后端可用 `show_empty_funnel` 打开），
 * 但默认不下发 —— `data.reason` 已经把「卡在哪层 + 下一步怎么办」说完了，
 * 漏斗是同一件事的另一种写法。用户原话：「这些文字没必要给用户看」。
 * 前端这里**保留渲染能力**而不是删掉：诊断场景仍需要它，删了就得改两处。
 *
 * ## 建议按钮必须能改槽重跑，不能只发一句话
 *
 * 这是踩过的真实故障：按钮只调 `sendText('天数可以再灵活一点')`，这句进了
 * 普通对话，没有任何触发关键词 —— 后端 `resolve_scene_hit()` 落空，退回
 * `standard` 模式，一个方案都没重算。用户点完看到的是模型开始闲聊。
 *
 * 现在每颗按钮读 `suggestion.patch`（`{槽位: 数值}`，后端算好的**能命中**的组合），
 * 把它合并进 `data.slots`（本轮生效的完整槽位）后走 `submitSlots` —— 那是
 * 「改槽 + 带 `forcedSceneId` 重跑」的既有通路，与表单提交完全一致，不经过模型。
 *
 * 没有 `patch` 的按钮（「就看最接近的」「检查数据表」）仍然走 `sendText`：
 * 它们本来就不改条件，是纯展示或纯咨询动作。
 *
 * ⚠️ **`patch` 里可能有多个槽，而且 `label` 必须把它们全写出来**。人数是第一层、
 * 天数是第二层，只改一个常常还是空；后端因此会把「成套取值」一起下发。若
 * 标签只写「按 4 人找」而结果卡上是 5 天 ¥3000，用户会以为系统偷偷改了条件。
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

type EmptySuggestion = {
  label: string;
  sendText: string;
  /**
   * 要改哪些槽位、改成什么（后端 `patch`）。缺省表示这颗按钮不改条件。
   *
   * **可能是多个槽**：只改一个常常不够。人数是第一层、天数是第二层，
   * 表里 4 人方案是 5/6 天 —— 用户填 4 人 4 天时，把人数改成 4 等于
   * 什么都没改，点下去还是空。后端会一并算出「能出结果的最小改动组合」。
   */
  patch?: Record<string, number>;
};

function readSuggestions(data: Record<string, unknown>): EmptySuggestion[] {
  if (!Array.isArray(data.suggestions)) return [];
  return data.suggestions
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
    .map((row) => {
      const suggestion: EmptySuggestion = {
        label: typeof row.label === 'string' ? row.label : '',
        sendText: typeof row.send_text === 'string' ? row.send_text : '',
      };
      // `patch` 是 `{槽位: 数值}`。只收数值型：槽位如果不是数值（枚举/文本），
      // 后端本来就不会给 patch —— 收了也只会污染提交载荷。
      const raw = row.patch;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const patch: Record<string, number> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === 'number' && Number.isFinite(value)) patch[key] = value;
        }
        if (Object.keys(patch).length > 0) suggestion.patch = patch;
      }
      return suggestion;
    })
    .filter((row) => Boolean(row.label));
}

/** 与行程卡价格条共用同一套按钮尺寸（`shared/buttons.ts`）。 */
export const EMPTY_CARD_BUTTON_CLASS = SCENE_SECONDARY_BUTTON_CLASS;

export function SceneEmptyCard({
  block,
  title,
  sendText,
  submitSlots,
  canSubmitSlots = false,
  disabled = false,
  dataModule = '',
}: {
  block: SceneBlockProps['block'];
  /** 卡头结论。缺省用 block 里给的 `title`，再缺省用通用文案。 */
  title?: string;
  sendText: SceneBlockProps['sendText'];
  /** 改槽重跑的入口。 */
  submitSlots?: SceneBlockProps['submitSlots'];
  /**
   * 提交能力是否真的可用。**必须由调用方显式传**，不要自己判 `submitSlots` ——
   * 它永远非空（框架兜底成 no-op），判不出来。见 `SceneBlockProps.canSubmitSlots`。
   */
  canSubmitSlots?: boolean;
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
  /** 本轮生效的完整槽位（后端 `empty.slots`）。合并 patch 时以它为底。 */
  const currentSlots = (data.slots && typeof data.slots === 'object' && !Array.isArray(data.slots))
    ? data.slots as Record<string, unknown>
    : {};

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
              onClick={() => {
                // 带 `patch` 的建议 → 改槽位重跑（确定性，不过模型）。
                //
                // 合并 `currentSlots` 而不是只发 patch：patch 里只含要改的槽，
                // 其余条件必须带着 —— 只发 `{days: 6}` 会让人数和预算在后端
                // 变成空值，等于用户点一下就把两个条件丢了。后端把本轮完整
                // 槽位放在 `data.slots` 一起下发，正是为了这里能合并。
                //
                // ⚠️ 判 `canSubmitSlots` 而**不是** `submitSlots`：后者被
                // 框架兜底成 no-op，永远为真 —— 分享页里会静默什么都不做。
                if (item.patch && canSubmitSlots && submitSlots) {
                  submitSlots({ ...currentSlots, ...item.patch });
                  return;
                }
                sendText(item.sendText || item.label);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}