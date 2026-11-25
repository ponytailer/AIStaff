import { defineSceneModule } from '../../define';
import { SceneEmptyCard } from '../../shared/SceneEmptyCard';
import {
  SCENE_PRIMARY_BUTTON_CLASS,
  SCENE_SECONDARY_BUTTON_CLASS,
} from '../../shared/buttons';
import { detailText, resultHits, resultTotal, selectText } from '../../shared/rowData';
import type { SceneBlockProps } from '../../types';
import { GENERIC_TABLE_MATCH_DEFAULTS, genericTableMatchParams } from './params';

/**
 * `generic.table_match` —— 通用查表**界面**。
 *
 * 注意分工：**匹配算法不在这个 module 里**，它由后端 `table_match` 通道
 * （`app/scene_modules/channels._run_table_match` → `app.scenes.matcher.run_match`）
 * 产出 `form` / `result` / `empty` 三种块。这个 module 只负责把块画出来。
 * 这是「后端只产出发生了什么，前端代码决定怎么画」的分界线（PRD §7.5）。
 *
 * 它是「不写代码也能建场景」的保底路径：能力上限低（一张列表），但必需 ——
 * 没有它，新建场景就必须先有一次前端开发，连「跑通一条链路看看效果」都做不到。
 *
 * 视觉规格：契约 §1（外框 / 卡头 / 按钮）+ §2（空结果卡）。
 * 刻意与 `travel.itinerary` 共用同一套外框与按钮类，只是把「逐日时间轴」
 * 换成「N 条列表」——两者在截图里应该是同一个家族的卡片。
 */

/** 与行程卡同一个外框（契约 §1.1）：写两份会漂成两种卡片。 */
const CARD_CLASS =
  'overflow-hidden rounded-[14px] border border-[#ded7cc] bg-white '
  + 'shadow-[0_1px_2px_rgba(17,17,17,0.04),0_1px_8px_rgba(70,76,94,0.06)]';

function paramText(params: Record<string, unknown>, key: string, fallback: string): string {
  const raw = params[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
}

function paramBool(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const raw = params[key];
  return typeof raw === 'boolean' ? raw : fallback;
}

/**
 * `form` 块 → 平台槽位表单。
 *
 * **直接复用平台的 `SlotFormCard`**（经 `renderForm` 注入），不自己画一套：
 * 后端 `_slot_form_block()` 产的就是 `build_slot_form()` 的输出，而 `SlotFormCard`
 * 已经在消费同一个形状（`kind` / `fields` / `title` / `submit_label`）。
 * 自己画会让「场景表单」与「SOP 表单」的校验、提交口径分裂成两套。
 *
 * `renderForm` 缺失时（分享页静态渲染 / 单测里没有聊天容器）退回 `fallback_text`，
 * 道理同 `SceneBlockList` 的 render prop：scenes 层不能反向 import chat 层。
 */
export function GenericTableMatchSlotForm({ block, renderForm }: SceneBlockProps) {
  if (renderForm) return <>{renderForm(block.data ?? {})}</>;
  return (
    <div
      className="rounded-[14px] border border-[#ded7cc] bg-white px-[14px] py-[13px] text-[12.5px] leading-[1.6] text-[#343633]"
      data-scene-form-fallback="generic.table_match"
    >
      {block.fallback_text || '请补充信息后继续。'}
    </div>
  );
}

/** 一条命中：标题 + 3~4 个字段 + 来源表名 + 两颗按钮。 */
function HitRow({
  title,
  fields,
  sourceTable,
  showSource,
  primaryLabel,
  secondaryLabel,
  disabled,
  onSelect,
  onDetail,
}: {
  title: string;
  fields: { key: string; text: string }[];
  sourceTable: string;
  showSource: boolean;
  primaryLabel: string;
  secondaryLabel: string;
  disabled: boolean;
  onSelect: () => void;
  onDetail: () => void;
}) {
  return (
    <div className="border-b border-[#e7dfd3] px-[14px] py-[11px] last:border-b-0">
      <div className="mb-[4px] text-[12.5px] font-semibold text-[#18181a]">{title}</div>
      {fields.length > 0 && (
        <div className="flex flex-wrap gap-x-[14px] gap-y-[2px]">
          {fields.map((field) => (
            <span key={field.key} className="text-[11.5px] leading-[1.6] text-[#343633]">
              <span className="text-[10px] tracking-[0.02em] text-[#9a9b95]">{`${field.key} `}</span>
              <span className="font-mono text-[12px]">{field.text}</span>
            </span>
          ))}
        </div>
      )}
      <div className="mt-[7px] flex items-center gap-[7px]">
        {showSource && sourceTable ? (
          <span className="text-[11px] text-[#9a9b95]">{`来自「${sourceTable}」`}</span>
        ) : null}
        <div className="ml-auto flex gap-[7px]">
          <button
            type="button"
            className={SCENE_SECONDARY_BUTTON_CLASS}
            disabled={disabled}
            onClick={onDetail}
          >
            {secondaryLabel}
          </button>
          {/* 铁律：交互一律走 sendText 起新一轮，**不许直接改状态**（PRD §5.3）。 */}
          <button
            type="button"
            className={SCENE_PRIMARY_BUTTON_CLASS}
            disabled={disabled}
            onClick={onSelect}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GenericTableMatchResultCard({
  block,
  params,
  sendText,
  disabled = false,
}: SceneBlockProps) {
  const data = block.data ?? {};
  const hits = resultHits(data, typeof params.title_column === 'string' ? params.title_column : '');
  const total = resultTotal(data);
  const primaryLabel = paramText(
    params,
    'primary_action_label',
    GENERIC_TABLE_MATCH_DEFAULTS.primary_action_label,
  );
  const secondaryLabel = paramText(
    params,
    'secondary_action_label',
    GENERIC_TABLE_MATCH_DEFAULTS.secondary_action_label,
  );
  const showSource = paramBool(
    params,
    'show_source_table',
    GENERIC_TABLE_MATCH_DEFAULTS.show_source_table,
  );

  // 空 items 的 result 块：退化成文本，不抢 EmptyState 的语义（同 travel.itinerary）。
  if (hits.length === 0) {
    return (
      <div className={CARD_CLASS} data-scene-module="generic.table_match">
        <div className="px-[14px] py-[11px] text-[12px] leading-[1.6] text-[#343633]">
          {block.fallback_text || '没有可展示的结果。'}
        </div>
      </div>
    );
  }

  return (
    <div className={CARD_CLASS} data-scene-module="generic.table_match">
      {/* 卡头：渐变方向必须是 135deg（契约 §1.2 / §7.1 第 1 条）。 */}
      <div className="border-b border-[#e7dfd3] bg-[linear-gradient(135deg,#f0faf8_0%,#fbfbfa_100%)] px-[14px] py-[11px]">
        <h3 className="mb-[2px] text-[13px] font-semibold tracking-[-0.01em] text-[#18181a]">
          为你找到以下方案
        </h3>
        <div className="text-[11.5px] text-[#9a9b95]">
          {`共 ${total} 条符合条件，下面是最贴合的 ${hits.length} 条`}
        </div>
      </div>

      <div className="flex flex-col">
        {hits.map((hit, index) => (
          <HitRow
            key={String(hit.raw.row_id ?? `hit-${index}`)}
            title={hit.title}
            fields={hit.fields}
            sourceTable={hit.sourceTable}
            showSource={showSource}
            primaryLabel={primaryLabel}
            secondaryLabel={secondaryLabel}
            disabled={disabled}
            onSelect={() => sendText(selectText(hit.title))}
            onDetail={() => sendText(detailText(hit.title))}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 空结果卡 —— **必须真做**（team-lead 明确要求）。
 *
 * 只有一段「没找到」会让用户卡死在这一轮：他不知道是表里没有、还是条件太窄、
 * 也不知道下一步能做什么。三个信息都得给：
 * 1. 结论（没有找到）；
 * 2. 原因（`data.reason`，后端已量化到「卡在哪一层」）；
 * 3. 漏斗（`data.steps`，**每一步的真实数字**；前端重算会和试跑面板对不上）+ 两个可点的建议。
 */
export function GenericTableMatchEmptyState({ block, sendText, disabled = false }: SceneBlockProps) {
  return (
    <SceneEmptyCard
      block={block}
      sendText={sendText}
      disabled={disabled}
      dataModule="generic.table_match.empty"
    />
  );
}

export default defineSceneModule({
  meta: {
    module_key: 'generic.table_match',
    module_version: 1,
    supported_scene_types: ['table_match'],
    summary: '收条件 → 从表里筛出候选 → 列出结果，支持空结果时说明卡在哪一步。',
    required_slots: [
      { key: 'people', label: '人数', type: 'number', required: true, unit: '人' },
      { key: 'days', label: '天数', type: 'number', required: true, unit: '天' },
      { key: 'budget', label: '预算', type: 'number', required: true, unit: '元' },
    ],
    params_schema: genericTableMatchParams,
    entry_behavior: 'open_form',
    display_name: '通用查表',
    // 刻意**不**声明 needs_table：类型层 `table_match` 是 `optional`，
    // 0 张表可发布（只 warning）。收紧到 required 会让「先建场景、绑员工、后补表」
    // 这条最自然的操作顺序走不通（PRD §10.3 第 11 条）。
  },
  SlotForm: GenericTableMatchSlotForm,
  ResultCard: GenericTableMatchResultCard,
  EmptyState: GenericTableMatchEmptyState,
});