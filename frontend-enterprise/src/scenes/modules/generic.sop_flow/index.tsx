import { defineSceneModule } from '../../define';
import { SCENE_SECONDARY_BUTTON_CLASS } from '../../shared/buttons';
import type { SceneBlockProps } from '../../types';

/**
 * `generic.sop_flow` —— 通用流程**界面**。
 *
 * 后端 `sop_flow` 通道把 `flow_json.steps` 摊成若干 `step` 块
 * （`app/scene_modules/channels._run_sop_flow`），每个块带：
 * ```json
 * { "step_name": "...", "step_index": 0, "step_total": 3,
 *   "status": "pending" | "awaiting_input" | "done", "missing": ["people"] }
 * ```
 * P0 刻意只做「走到哪一步 + 缺哪些字段」，不驱动真实 SOP 引擎的节点跳转
 * （PRD §14.3 C 段把端到端排到 P1），所以 `data` 形状是**宽松口径**。
 *
 * ## 为什么用纵向时间轴，而不是横向步骤条
 *
 * 契约 §1.4 已经把「纵向时间轴」逐值定死了（徽标 34×34 / 连接线 1.5px /
 * 最后一行不画线）。横向步骤条没有任何契约数值 —— 自己发明一套横向尺寸，
 * 就是本文档最忌的「凭空造视觉」。所以这里直接复用 §1.4 的时间轴骨架，
 * 只把「日程标题」换成「步骤名」。
 */

/** 与行程卡同一个外框（契约 §1.1）。 */
const CARD_CLASS =
  'overflow-hidden rounded-[14px] border border-[#ded7cc] bg-white '
  + 'shadow-[0_1px_2px_rgba(17,17,17,0.04),0_1px_8px_rgba(70,76,94,0.06)]';

type StepData = {
  name: string;
  index: number;
  total: number;
  status: 'pending' | 'awaiting_input' | 'done';
  missing: string[];
};

function readStep(block: SceneBlockProps['block']): StepData {
  const data = block.data ?? {};
  const statusRaw = typeof data.status === 'string' ? data.status : '';
  const status: StepData['status'] = statusRaw === 'awaiting_input' || statusRaw === 'done'
    ? statusRaw
    : 'pending';
  return {
    name: typeof data.step_name === 'string' ? data.step_name.trim() : '',
    index: Number.isFinite(Number(data.step_index)) ? Math.max(0, Math.trunc(Number(data.step_index))) : 0,
    total: Number.isFinite(Number(data.step_total)) ? Math.max(1, Math.trunc(Number(data.step_total))) : 1,
    status,
    missing: Array.isArray(data.missing)
      ? data.missing.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      : [],
  };
}

/** 从同轮全部 step 块里取「当前步」——后端会在第一个缺字段的步骤 break，所以取 last。 */
function currentStepOf(siblings: SceneBlockProps['siblings']): StepData | null {
  const steps = siblings.filter((item) => item.kind === 'step').map(readStep);
  if (steps.length === 0) return null;
  return steps[steps.length - 1];
}

const STATUS_TEXT: Record<StepData['status'], string> = {
  awaiting_input: '等待你补充信息',
  done: '已完成',
  pending: '待开始',
};

/**
 * 一步一行（骨架照抄契约 §1.4）。
 *
 * `isLast` 用 JS 判断不画线，理由同行程卡：CSS `:last-child` 在「最后一行之上
 * 又插入了别的元素」这类改动静默失效。
 */
function StepRow({
  step,
  isLast,
  highlighted,
}: {
  step: StepData;
  isLast: boolean;
  highlighted: boolean;
}) {
  return (
    <div className="flex gap-[11px] pb-[14px] last:pb-0">
      <div className="flex w-[40px] shrink-0 flex-col items-center">
        <div
          className={`flex size-[34px] shrink-0 flex-col items-center justify-center rounded-[10px] text-[8.5px] leading-[1.1] font-semibold ${
            highlighted ? 'bg-[#0f766e] text-white' : 'bg-[#e1f1ed] text-[#0f766e]'
          }`}
        >
          <b className="font-mono text-[13px] leading-none">{`S${step.index + 1}`}</b>
          <span>{step.status === 'done' ? '完成' : step.status === 'awaiting_input' ? '当前' : '待办'}</span>
        </div>
        {!isLast && <div className="mt-[4px] w-[1.5px] flex-1 bg-[#e7dfd3]" />}
      </div>
      <div className="min-w-0 flex-1 pt-[2px]">
        <p className="mb-[3px] text-[12px] font-semibold text-[#18181a]">
          {step.name || `第 ${step.index + 1} 步`}
        </p>
        <p className="m-0 text-[11.5px] leading-[1.6] text-[#343633]">
          {STATUS_TEXT[step.status]}
        </p>
        {step.missing.length > 0 && (
          <div className="mt-[5px] flex flex-wrap gap-[5px]">
            {step.missing.map((field) => (
              <span
                key={field}
                className="rounded-[4px] bg-[#eeece4] px-[5px] py-[1px] text-[10px] text-[#343633]"
              >
                {`待补：${field}`}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function GenericSopFlowStepView({
  block,
  siblings,
  sendText,
  disabled = false,
}: SceneBlockProps) {
  const step = readStep(block);
  const current = currentStepOf(siblings);
  const steps = siblings.filter((item) => item.kind === 'step').map(readStep);

  return (
    <div className={CARD_CLASS} data-scene-module="generic.sop_flow">
      <div className="border-b border-[#e7dfd3] bg-[linear-gradient(135deg,#f0faf8_0%,#fbfbfa_100%)] px-[14px] py-[11px]">
        <h3 className="mb-[2px] text-[13px] font-semibold tracking-[-0.01em] text-[#18181a]">
          {`办理进度 · 第 ${Math.min(step.index + 1, step.total)} / ${step.total} 步`}
        </h3>
        <div className="text-[11.5px] text-[#9a9b95]">
          {current ? STATUS_TEXT[current.status] : STATUS_TEXT[step.status]}
        </div>
      </div>

      <div className="flex flex-col px-[14px] py-[12px]">
        {steps.map((item, index) => (
          <StepRow
            key={`${item.index}:${item.name}`}
            step={item}
            isLast={index === steps.length - 1}
            highlighted={current ? item.index === current.index : index === steps.length - 1}
          />
        ))}
      </div>

      {/* 待补字段的出口：按钮发一句自然语言，走新一轮（PRD §5.3 铁律）。
          这里不发结构化值 —— 后端 P0 的 sop_flow 通道不消费表单提交。 */}
      {step.missing.length > 0 && (
        <div className="flex items-center gap-[7px] border-t border-[#e7dfd3] bg-[#fbfaf6] px-[14px] py-[11px]">
          <span className="text-[11px] text-[#9a9b95]">直接回复即可补充</span>
          <div className="ml-auto flex gap-[7px]">
            <button
              type="button"
              className={SCENE_SECONDARY_BUTTON_CLASS}
              disabled={disabled}
              onClick={() => sendText(`我来补${step.missing.join('、')}`)}
            >
              {`补充${step.missing[0]}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default defineSceneModule({
  meta: {
    module_key: 'generic.sop_flow',
    module_version: 1,
    supported_scene_types: ['sop_flow'],
    summary: '步骤条 + 当前步说明 + 待补字段，多轮推进直到流程走完。',
    required_slots: [],
    params_schema: [],
    entry_behavior: 'send_text',
    display_name: '通用流程',
    // 类型层 sop_flow 已经是 needs_table: 'none'，模块不声明（只能收紧不能放宽）。
  },
  StepView: GenericSopFlowStepView,
});