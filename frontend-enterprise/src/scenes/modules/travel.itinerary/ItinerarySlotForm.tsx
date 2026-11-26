import { useMemo, useState } from 'react';

import { SCENE_PRIMARY_BUTTON_CLASS } from '../../shared/buttons';
import type { SceneBlockProps, SceneUiBlock } from '../../types';

/**
 * `travel.itinerary` 的条件表单 —— 逐值照抄 `docs/scenes/scene-demo.html`。
 *
 * ## 为什么不复用平台的 `SlotFormCard`
 *
 * demo 里人数/天数是**分段按钮**（1-8、3-7 天），预算带「¥ + 输入 + 元」和
 * 2k/3k/4k/6k 快选。`SlotFormCard` 只能把 `type:"number"` 画成 `<input type="number">`，
 * 做不出这两样 —— 而这两样正是这个场景「三秒填完」的全部体验来源。
 *
 * module 的价值就是「代码驱动比配置驱动多做了什么」（见 `index.tsx` 头注释），
 * 所以这里**不调 `renderForm`**，自己画。代价是必须自己保证提交口径与
 * `SlotFormCard` 一致：提交的是 `{people:4, days:5, budget:3000}`，数字是
 * **number 而不是字符串**（后端 matcher 按数值比区间，字符串会被判成不可转换）。
 *
 * ## 字段来源
 *
 * 不硬编码三个字段名，而是从 `block.data.fields`（`build_slot_form()` 的输出）
 * 里读 —— 场景改了槽位（比如加一个「出发日期」），这里加不上去，但至少**不会
 * 画出一个提交了也没人认的表单**。认不出的字段按行内文本框兜底渲染。
 *
 * 视觉基准：`scene-v3-visual-contract.md` §1（外框 14 圆角 / 1px `#ded7cc`）
 * 与 `dashboard` 的既有卡片家族。所有字号写死字面值，不依赖主题字号。
 */

/** 与 `ItineraryCard` 同一套外框（同一个视觉家族，两处各写一份会漂）。 */
const CARD_CLASS =
  'overflow-hidden rounded-[14px] border border-[#ded7cc] bg-white '
  + 'shadow-[0_1px_2px_rgba(17,17,17,0.04),0_1px_8px_rgba(70,76,94,0.06)]';

const FIELD_CLASS = 'flex flex-col gap-[7px]';
const LABEL_CLASS = 'flex items-center gap-[3px] text-[12px] font-medium text-[#4a4b45]';
const REQUIRED_CLASS = 'text-[#c0392b]';

/** demo `.seg`：横向等分、8px 圆角、选中反白。 */
const SEG_ROW_CLASS = 'flex flex-wrap gap-[5px] rounded-[10px] bg-[#f6f3ec] p-[3px]';
const SEG_BASE_CLASS =
  'min-w-[38px] flex-1 rounded-[8px] px-[8px] py-[6px] text-[12px] leading-[1.4] '
  + 'text-[#4a4b45] transition-colors hover:bg-white/70 disabled:cursor-not-allowed '
  + 'disabled:opacity-50';
const SEG_ACTIVE_CLASS = 'bg-[#18181a] font-semibold text-white hover:bg-[#18181a]';

/** demo `.money`：前置 ¥、后置元，整体看起来是一个输入框。 */
const MONEY_ROW_CLASS =
  'flex items-center gap-[6px] rounded-[10px] border border-[#ded7cc] bg-white px-[10px] py-[7px] '
  + 'focus-within:border-[#18181a]';
const MONEY_INPUT_CLASS =
  'min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[13px] text-[#18181a] '
  + 'outline-none placeholder:text-[#b3b4ae]';

/** demo `.quick`：2k/3k/4k/6k 快选小胶囊。 */
const QUICK_ROW_CLASS = 'flex flex-wrap gap-[5px]';
const QUICK_BTN_CLASS =
  'rounded-full border border-[#e2dbd0] bg-[#fbf9f5] px-[9px] py-[3px] text-[11px] '
  + 'text-[#6b6c66] transition-colors hover:border-[#18181a] hover:text-[#18181a] '
  + 'disabled:cursor-not-allowed disabled:opacity-50';

/** 字段的取值（number 一律存 number，不让字符串漏到提交载荷里）。 */
type FieldValue = string | number | boolean | undefined;

/** 从 `build_slot_form()` 的 fields 里读一项，读不到给安全默认。 */
type FormField = {
  name: string;
  label: string;
  type: string;
  unit: string;
  required: boolean;
  placeholder: string;
};

function readFields(block: SceneUiBlock): FormField[] {
  const data = block.data ?? {};
  const raw = Array.isArray(data.fields) ? data.fields : [];
  const out: FormField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) continue;
    out.push({
      name,
      label: typeof row.label === 'string' && row.label ? row.label : name,
      type: typeof row.type === 'string' ? row.type : 'text',
      unit: typeof row.unit === 'string' ? row.unit : '',
      required: row.required !== false,
      placeholder: typeof row.placeholder === 'string' ? row.placeholder : '',
    });
  }
  return out;
}

/**
 * 分段候选值。
 *
 * 人数 1-8、天数 3-7 是 demo 的选择，**不是**业务约束 —— 但它们是「一眼能选完」
 * 的关键：做成 1-30 的横排会换行成三行，做成下拉则多一次点击。
 * 超出范围的取值靠下面的输入框兜底（`allowCustom`），不会把用户卡死。
 */
const PEOPLE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];
const DAYS_OPTIONS = [3, 4, 5, 6, 7];
const BUDGET_QUICK = [2000, 3000, 4000, 6000];

function segOptionsFor(name: string): number[] {
  if (name === 'people') return PEOPLE_OPTIONS;
  if (name === 'days') return DAYS_OPTIONS;
  return [];
}

function isMoneyField(field: FormField): boolean {
  return field.name === 'budget' || field.unit === '元';
}

function isEmpty(value: FieldValue): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
}

export function TravelItinerarySlotForm({ block, submitSlots, disabled }: SceneBlockProps) {
  /**
   * 为什么要 `useState`：分段按钮必须知道当前选中项才能反白，否则「点了没反应」。
   * 提交成功后整块会被后端下一轮的 `result` 块替换掉，所以这里不需要处理
   * 「重挂后丢值」——那种情况在消息流里意味着历史回看，回看时本就不该可编辑。
   */
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const fields = useMemo(() => readFields(block), [block]);
  const title = typeof block.data?.title === 'string' && block.data.title
    ? block.data.title
    : '请补充条件';
  /**
   * 卡头副标题**由后端下发**（`channels.py::_slot_form_block` 的 `subtitle`）。
   *
   * 原先是写死的「填好这几项，我按条件逐条筛方案」。写死带来两个问题：
   * 1. 员工在定义器里改了场景文案，这里不会变 —— 「同一个东西在不同地方不一样」；
   * 2. 它把「按方案表比对」这个**具体策略**写进了通用句，换成别的数据源就说不通。
   *
   * 兜底串保留但仍取短句、中性词：后端正常都会给（三级兜底），走到这里说明
   * 收到了老版本后端或某个没用 `_slot_form_block` 的通道，此时不该再猜策略。
   */
  const subtitle = typeof block.data?.subtitle === 'string' && block.data.subtitle
    ? block.data.subtitle
    : '填好这几项，我接着往下办';
  const submitLabel = typeof block.data?.submit_label === 'string' && block.data.submit_label
    ? block.data.submit_label
    : '开始匹配';

  const setValue = (name: string, next: FieldValue) => {
    setValues((current) => ({ ...current, [name]: next }));
    setErrors((current) => {
      if (!current[name]) return current;
      const rest = { ...current };
      delete rest[name];
      return rest;
    });
  };

  const handleSubmit = () => {
    if (disabled) return;
    const nextErrors: Record<string, string> = {};
    for (const field of fields) {
      if (field.required && isEmpty(values[field.name])) nextErrors[field.name] = '请填写';
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.name];
      if (isEmpty(value)) continue;
      // 数字字段转 number：matcher 按数值比区间，字符串会被判成不可转换
      // （`unit_by_slot` 那条校验会直接把这个值扔掉）。
      payload[field.name] =
        field.type === 'number' || isMoneyField(field) ? Number(value) : value;
    }
    submitSlots(payload);
  };

  if (fields.length === 0) {
    // 后端没给字段（理论上不会：`_slot_form_block` 只在有缺槽时才产块）。
    // 不画一个空表，退回让用户直接说。
    return (
      <div className={CARD_CLASS}>
        <div className="px-[14px] py-[12px] text-[12px] text-[#6b6c66]">
          {block.fallback_text || '请直接回复你的条件。'}
        </div>
      </div>
    );
  }

  return (
    <div className={CARD_CLASS}>
      {/* 卡头：图标 + 标题 + 一句副标题（demo 的 .card-head 结构）。
          刻意不带「步骤」概念 —— 这不是 SOP，是一次性的条件收集。 */}
      <div className="flex items-center gap-[9px] border-b border-[#efe9df] bg-gradient-to-br from-[#fdfcf9] to-[#f7f3ea] px-[14px] py-[11px]">
        <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[8px] bg-[#e1f1ed] text-[13px] text-[#0f766e]">
          🎿
        </span>
        <span className="flex min-w-0 flex-col gap-[1px]">
          <span className="truncate text-[13px] font-semibold text-[#18181a]">{title}</span>
          <span className="truncate text-[11px] text-[#9a9b95]" title={subtitle}>
            {subtitle}
          </span>
        </span>
      </div>

      <div className="flex flex-col gap-[12px] px-[14px] py-[13px]">
        {fields.map((field) => {
          const value = values[field.name];
          const segOptions = segOptionsFor(field.name);

          return (
            <div className={FIELD_CLASS} key={field.name}>
              <label className={LABEL_CLASS} htmlFor={`itinerary-${field.name}`}>
                {field.label}
                {field.required && <span className={REQUIRED_CLASS}>*</span>}
              </label>

              {/* ① 人数 / 天数：分段按钮（demo `.seg`） */}
              {segOptions.length > 0 && (
                <>
                  <div className={SEG_ROW_CLASS} role="group" aria-label={field.label}>
                    {segOptions.map((option) => {
                      const active = Number(value) === option;
                      return (
                        <button
                          key={option}
                          type="button"
                          disabled={disabled}
                          aria-pressed={active}
                          className={`${SEG_BASE_CLASS} ${active ? SEG_ACTIVE_CLASS : ''}`}
                          onClick={() => setValue(field.name, option)}
                        >
                          {field.name === 'days' ? `${option} 天` : option}
                        </button>
                      );
                    })}
                  </div>
                  {errors[field.name] && (
                    <span className="text-[11px] text-[#c0392b]">{errors[field.name]}</span>
                  )}
                </>
              )}

              {/* ② 预算：¥ 前缀 + 输入 + 元 + 快选（demo `.money` + `.quick`） */}
              {segOptions.length === 0 && isMoneyField(field) && (
                <>
                  <div className={MONEY_ROW_CLASS}>
                    <span className="shrink-0 text-[12px] text-[#9a9b95]">¥</span>
                    <input
                      id={`itinerary-${field.name}`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      disabled={disabled}
                      className={MONEY_INPUT_CLASS}
                      placeholder={field.placeholder || '3000'}
                      value={value === undefined || value === null ? '' : String(value)}
                      onChange={(event) => {
                        const raw = event.target.value;
                        setValue(field.name, raw === '' ? undefined : Number(raw));
                      }}
                    />
                    {field.unit && (
                      <span className="shrink-0 text-[12px] text-[#9a9b95]">{field.unit}</span>
                    )}
                  </div>
                  <div className={QUICK_ROW_CLASS}>
                    {BUDGET_QUICK.map((amount) => (
                      <button
                        key={amount}
                        type="button"
                        disabled={disabled}
                        className={QUICK_BTN_CLASS}
                        onClick={() => setValue(field.name, amount)}
                      >
                        {amount / 1000}k
                      </button>
                    ))}
                  </div>
                  {errors[field.name] && (
                    <span className="text-[11px] text-[#c0392b]">{errors[field.name]}</span>
                  )}
                </>
              )}

              {/* ③ 其它字段（场景改了槽位时）：行内文本框兜底，保证不出空表 */}
              {segOptions.length === 0 && !isMoneyField(field) && (
                <>
                  <input
                    id={`itinerary-${field.name}`}
                    type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                    disabled={disabled}
                    className="h-[34px] rounded-[10px] border border-[#ded7cc] bg-white px-[10px] text-[13px] text-[#18181a] outline-none focus:border-[#18181a] placeholder:text-[#b3b4ae]"
                    placeholder={field.placeholder || `请输入${field.label}`}
                    value={value === undefined || value === null ? '' : String(value)}
                    onChange={(event) => setValue(field.name, event.target.value)}
                  />
                  {errors[field.name] && (
                    <span className="text-[11px] text-[#c0392b]">{errors[field.name]}</span>
                  )}
                </>
              )}
            </div>
          );
        })}

        {/* 原先这里有一行说明：「条件直接作为结构化数据提交，不靠模型从
            「三k」「三千」里猜数字。」用户明确要求不展示 —— 表单本身已经
            说明了一切，这行字只是噪音。NOTE_CLASS 常量随之删除。 */}

        <button
          type="button"
          disabled={disabled}
          onClick={handleSubmit}
          className={`${SCENE_PRIMARY_BUTTON_CLASS} w-full justify-center`}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}