import { useMemo, useState } from 'react';

import { SCENE_PRIMARY_BUTTON_CLASS } from '../../shared/buttons';
import type { SceneBlockProps, SceneUiBlock } from '../../types';

/**
 * `travel.itinerary` 的条件表单。
 *
 * ## 为什么不复用平台的 `SlotFormCard`
 *
 * 三个字段的候选值是**业务取值**（人数 1-8、天数 3-7、预算 1k~4k+），
 * `SlotFormCard` 只能把 `type:"number"` 画成 `<input type="number">` —— 用户
 * 得自己敲数字，且敲出来的值（比如 37 人、99999 元）在表里必然查不到。
 * module 的价值就是「代码驱动比配置驱动多做了什么」（见 `index.tsx` 头注释），
 * 所以这里**不调 `renderForm`**，自己画。
 *
 * 代价是必须自己保证提交口径与 `SlotFormCard` 一致：提交的是
 * `{people:4, days:5, budget:3000}`，数字是 **number 而不是字符串**
 * （后端 matcher 按数值比区间，字符串会被判成不可转换）。
 *
 * ## 三个字段的控件为什么统一成下拉（2026-11-26）
 *
 * 演变过程记一下，避免有人「优化」回去：
 *
 * 1. 最早人数/天数是 demo 的横向分段按钮（1-8 八颗、3-7 五颗平铺），预算
 *    是「¥ 输入框 + 2k/3k/4k/6k 快选」两排；
 * 2. 用户要求「改成下拉选项吧，不要平铺了，然后表单里改成文字和选项在一行」；
 * 3. 再要求「预算也改成下拉，1k 2k 3k 4k 4k+」。
 *
 * 现在三个字段是同一种控件（原生 `select`），标签统一在左、控件在右同一行。
 * **同一张表里不再存在「某种字段是两排、别的字段是一排」的差异** —— 那正是
 * 之前标签对齐要打 `pt-[7px]` 补丁的根源（见 `FIELD_ROW_CLASS` 注释）。
 *
 * ## `appearance-none` 不影响键盘操作
 *
 * 这里用的是**原生 `<select>`**，`appearance-none` 只去掉浏览器默认外观，
 * 方向键 / Alt+↓ / 首字母跳转全部保留（那是元素行为，不是外观）。这与用 div
 * 伪装下拉不同，后者才需要自己补一整套键盘事件。
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

/**
 * 一个字段 = 一行「标签 + 控件」。
 *
 * `items-center` 现在是对的：三个字段都是**单排** 34px 下拉，标签自然与控件
 * 同中线，不需要任何 padding 补丁。
 *
 * 这里曾经要 `items-start` + 标签 `pt-[7px]`，因为预算那格是「¥ 输入 + 快选
 * 胶囊」两排 —— `items-center` 会把预算标签推到两排整体的中点，实测比前两行
 * 低 16px。2026-11-26 预算也改成下拉后，两排字段不存在了，那个补丁随之删除。
 * **留着它会变成一个没有理由的魔术数字**（而且和单排控件的实际中线差 0）。
 *
 * 错误提示是独立的 grid item（`col-start-1 col-end-[-1]`），占第二行，
 * 不参与这一行的垂直居中，所以标红时标签也不会被推下去。
 *
 * `max-[380px]:grid-cols-1` 是给窄屏的兜底：极窄时标签压到控件上面一行，
 * 否则「天数（天）*」加一个下拉会挤成两行字。
 */
const FIELD_ROW_CLASS =
  'grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-[12px] gap-y-[5px] '
  + 'max-[380px]:grid-cols-1 max-[380px]:gap-y-[6px]';

const LABEL_CLASS =
  'flex shrink-0 items-center gap-[3px] whitespace-nowrap text-[12px] '
  + 'font-medium text-[#4a4b45]';
const REQUIRED_CLASS = 'text-[#c0392b]';

/** 字段控件的列容器。错误提示**不在**这里 —— 它跨满整行（见 `ERROR_ROW_CLASS`）。 */
const CONTROL_CLASS = 'flex min-w-0 flex-col gap-[5px]';

/**
 * 原生下拉的外观。
 *
 * 用 `appearance-none` + 自绘箭头，是为了和预算输入框同一个视觉（34px 高、
 * 10px 圆角、`#ded7cc` 边框）；直接用系统默认外观会出现「同一张表里两个
 * 控件长得不像一家人」。原生元素的键盘操作不受影响（见头注释）。
 *
 * `pr-[28px]` 给右侧箭头留位，避免长选项文案压到箭头底下。
 */
const SELECT_CLASS =
  'h-[34px] w-full min-w-0 appearance-none rounded-[10px] border border-[#ded7cc] bg-white '
  + 'pl-[10px] pr-[28px] text-[13px] text-[#18181a] outline-none transition-colors '
  + 'focus:border-[#18181a] disabled:cursor-not-allowed disabled:opacity-50';

/** 下拉右侧箭头。`pointer-events-none` 让点击穿透到 `<select>` 本身。 */
const SELECT_CHEVRON_CLASS =
  'pointer-events-none absolute right-[9px] top-1/2 -translate-y-1/2 text-[#9a9b95]';

/** 错误提示：占满整行（跨标签与控件两列），不把布局挤歪。 */
const ERROR_ROW_CLASS = 'col-start-1 col-end-[-1] text-[11px] text-[#c0392b]';

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
 * 下拉选项：`label` 是给人看的，`value` 是提交给后端的数字。
 *
 * **两者必须能不同**，预算那一档就是活例子：`4k+` 显示「4k+」（下不封顶），
 * 提交的却是 5000。后端 matcher 按「与基准数的**绝对相对偏差**」排序
 * （`matcher.py` 的 `budget_dev = abs(budget_base - r.nb.num) / budget_base`），
 * 没有区间/下限概念，所以「至少 4k」只能落成一个具体数：
 *
 * - 提交 4000 → 与「4k」那一档完全等价，用户选哪个结果都一样（假选项）；
 * - 提交 9999 → 所有行的预算偏差都趋近 1，预算等于退出排序（丢了信息）；
 * - 提交 5000 → 排序偏向 4800 这类高价方案，符合「4k 以上、越贵也给我看」
 *   的直觉。样本价目表最高 4800，5000 能覆盖到。
 *
 * 这个取值是**产品决定**，不是技术推导；换成别的数据源后若价格区间变了，
 * 应该回来重新校准这一档。
 */
type SelectOption = { label: string; value: number };

const PEOPLE_OPTIONS: SelectOption[] = [1, 2, 3, 4, 5, 6, 7, 8]
  .map((n) => ({ label: String(n), value: n }));
/** 天数带单位显示（「4 天」）；人数不带 —— 加「人」会和标签「人数（人）」重复。 */
const DAYS_OPTIONS: SelectOption[] = [3, 4, 5, 6, 7]
  .map((n) => ({ label: `${n} 天`, value: n }));
const BUDGET_OPTIONS: SelectOption[] = [
  { label: '1k', value: 1000 },
  { label: '2k', value: 2000 },
  { label: '3k', value: 3000 },
  { label: '4k', value: 4000 },
  // 见上方 `SelectOption` 注释：显示 4k+，提交 5000。
  { label: '4k+', value: 5000 },
];

/** 哪些字段走下拉，以及它的选项。返回空数组 = 不是下拉字段。 */
function selectOptionsFor(field: FormField): SelectOption[] {
  if (field.name === 'people') return PEOPLE_OPTIONS;
  if (field.name === 'days') return DAYS_OPTIONS;
  if (isMoneyField(field)) return BUDGET_OPTIONS;
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
          const selectOptions = selectOptionsFor(field);
          const errorText = errors[field.name];

          return (
            <div className={FIELD_ROW_CLASS} key={field.name}>
              <label className={LABEL_CLASS} htmlFor={`itinerary-${field.name}`}>
                {field.label}
                {field.required && <span className={REQUIRED_CLASS}>*</span>}
              </label>

              <div className={CONTROL_CLASS}>
                {/* 人口 / 天数 / 预算：统一走原生下拉。
                    预算原先是「¥ 输入框 + 2k/3k/4k/6k 快选」两排，用户要求
                    「预算也改成下拉，1k 2k 3k 4k 4k+」，于是三种字段的控件
                    终于变成同一种东西 —— 同一张表里不再有「两排的字段」。 */}
                {selectOptions.length > 0 && (
                  <div className="relative min-w-0">
                    <select
                      id={`itinerary-${field.name}`}
                      disabled={disabled}
                      className={SELECT_CLASS}
                      // `''` 而不是 `undefined`：受控 select 在无选中项时要显式
                      // 交给占位 option，否则浏览器会默认选中第一项，看起来像
                      // 「已经帮你选了」。
                      value={value === undefined || value === null ? '' : String(value)}
                      onChange={(event) => {
                        const raw = event.target.value;
                        setValue(field.name, raw === '' ? undefined : Number(raw));
                      }}
                    >
                      <option value="" disabled>
                        {field.placeholder || '请选择'}
                      </option>
                      {selectOptions.map((option) => (
                        // value 用数字而不是下标：提交载荷要的是 3000 而不是 2，
                        // `handleSubmit` 里那条 `Number(value)` 因此保持不变。
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <svg
                      className={SELECT_CHEVRON_CLASS}
                      width="11"
                      height="11"
                      viewBox="0 0 12 12"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M2.5 4.5 6 8l3.5-3.5"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                )}

                {/* 兜底：场景改了槽位、出现认不出的字段时，退化成行内文本框，
                    保证不出一个提交了也没人认的空表。 */}
                {selectOptions.length === 0 && (
                  <input
                    id={`itinerary-${field.name}`}
                    type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                    disabled={disabled}
                    className="h-[34px] w-full min-w-0 rounded-[10px] border border-[#ded7cc] bg-white px-[10px] text-[13px] text-[#18181a] outline-none focus:border-[#18181a] placeholder:text-[#b3b4ae]"
                    placeholder={field.placeholder || `请输入${field.label}`}
                    value={value === undefined || value === null ? '' : String(value)}
                    onChange={(event) => setValue(field.name, event.target.value)}
                  />
                )}
              </div>

              {/* 错误提示跨满整行：只挂在控件下面会让「请填写」贴着右边、和
                  标签错位；跨行后它落在整张表左边缘，读起来是这一行的结论。 */}
              {errorText && <span className={ERROR_ROW_CLASS}>{errorText}</span>}
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