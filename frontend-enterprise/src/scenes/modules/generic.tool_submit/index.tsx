import { defineSceneModule } from '../../define';
import { SceneEmptyCard } from '../../shared/SceneEmptyCard';
import { fieldText, resultHits, resultTotal } from '../../shared/rowData';
import type { SceneBlockProps } from '../../types';
import { GENERIC_TOOL_SUBMIT_DEFAULTS, genericToolSubmitParams } from './params';

/**
 * `generic.tool_submit` —— 「收表单 → 调接口 → 回复用户」的通用**界面**。
 *
 * 这是四步通用模板的界面层（模板本身见
 * `app/scene_modules/channels._run_tool_submit`）：
 *
 * ```
 * 1. 意图匹配触发        ← resolve_scene_hit（关键词 / 胶囊）
 * 2. 发表单收信息        ← form 块（缺必填槽位时才发）
 * 3. 调接口              ← ToolExecutor 调 scene.tool_api_json.tool_name
 * 4. 回复用户            ← result 块（回执）+ text
 * ```
 *
 * **场景不含业务逻辑，业务全在被调用的工具里** —— 换个业务只改
 * `tool_api_json`，不写代码。这个 module 只负责把三块画出来。
 *
 * ## 为什么复用 `result` 块的形状，而不是造一个新 kind
 *
 * `kind` 说的是「什么事」，不是「长什么样」（PRD §7.5）。「提交成功拿到一张
 * 回执」在语义上就是一条结果 —— 后端 `_run_tool_submit` 把回执塞成
 * `items: [{values: {...}}]`，与命中行同形，于是能复用 `resultHits()` 的
 * 容错（坏数据逐项跳过，不整块失败）。
 *
 * 造 `receipt` 这个新 kind 的代价：后端 `BlockKind`、前端 `BLOCK_KINDS`、
 * `componentForKind`、`constants.test.ts` 四处都要动，而收益只是「名字更像」。
 *
 * ## 与 `generic.table_match` 的视觉关系
 *
 * 共用同一套外框与按钮类（契约 §1.1 / §1.2）。两者在截图里应该是同一个
 * 家族的卡片：一个是「筛出几条给你选」，一个是「这条已经办完了」。
 */

/** 与其它 generic card 同一个外框（契约 §1.1）。 */
const CARD_CLASS =
  'overflow-hidden rounded-[14px] border border-[#ded7cc] bg-white '
  + 'shadow-[0_1px_2px_rgba(17,17,17,0.04),0_1px_8px_rgba(70,76,94,0.06)]';

function paramText(params: Record<string, unknown>, key: string, fallback: string): string {
  const raw = params[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
}

/**
 * `form` 块 → 平台槽位表单。
 *
 * 与 `generic.table_match` 完全同一条路径（经 `renderForm` 复用 `SlotFormCard`）：
 * 后端 `_slot_form_block()` 产的就是 `build_slot_form()` 的输出。自己画一套会让
 * 「场景表单」与「SOP 表单」的校验、提交口径分裂成两套 —— 那是长期维护灾难。
 */
export function GenericToolSubmitSlotForm({ block, renderForm }: SceneBlockProps) {
  if (renderForm) return <>{renderForm(block.data ?? {})}</>;
  return (
    <div
      className="rounded-[14px] border border-[#ded7cc] bg-white px-[14px] py-[13px] text-[12.5px] leading-[1.6] text-[#343633]"
      data-scene-form-fallback="generic.tool_submit"
    >
      {block.fallback_text || '请补充信息后继续。'}
    </div>
  );
}

/**
 * 单号识别 —— **不写死字段名**。
 *
 * ## 曾经的做法（已废弃）
 *
 * 一个常量数组 `['order_no','ticket_id','receipt_id','booking_no','appointment_no']`
 * 挨个试。它只覆盖了「我们想到过的五种业务」：接口改成 `waybill_no`（运单）、
 * `case_no`（工单）、`ref`、`serial`，或中文 key「单号」，就一个都命中不了 ——
 * 而单号恰恰是用户后续报查的唯一凭据，丢了它这张回执就废了一半。
 *
 * ## 现在的三级来源
 *
 * 1. **场景配置指定的字段**（`receipt_no_field`）—— 唯一无歧义的方式。
 *    用户在最懂自己接口的地方填一次，之后永远对。
 * 2. **按通用特征猜**：key 里带 `no` / `id` / `code` / `sn` / `ref` 这几个词根，
 *    或者中文 key 含「单号」「编号」「流水」。比枚举字段名覆盖得广得多 ——
 *    它匹配的是**命名意图**，不是具体名字。
 * 3. 都没有 → 不显示单号行。**宁可不显示，也不猜错**：把「金额」当单号
 *    标成「单号」比不显示更糟。
 */
const NO_KEY_HINTS = ['no', 'id', 'code', 'sn', 'ref', 'serial'];
const NO_KEY_CJK = ['单号', '编号', '流水', '票号'];

/** 这些 key 长得像单号但其实是别的意思，要排除。 */
const NO_KEY_EXCLUDE = ['quantity', 'qty', 'count', 'valid', 'paid', 'deleted', 'enabled'];

function looksLikeNoKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (NO_KEY_EXCLUDE.some((word) => lower === word || lower.includes(word))) return false;
  if (NO_KEY_CJK.some((word) => key.includes(word))) return true;
  // 按词根切分：`order_no` → ['order','no']，`orderNo` → ['orderno']
  const parts = lower.split(/[_\-. ]+/).filter(Boolean);
  if (parts.some((part) => NO_KEY_HINTS.includes(part))) return true;
  // 驼峰形式：末尾是 No / Id / Code 也算（`waybillNo`）
  return /(no|id|code|sn|ref|serial)$/.test(lower) && lower.length > 2;
}

function receiptNoOf(
  values: Record<string, unknown>,
  configuredField: string,
): { key: string; text: string } | null {
  // ① 用户显式指定 —— 优先，且**只认它**（指定了就不要再猜别的）
  if (configuredField) {
    const text = fieldText(values[configuredField]);
    return text ? { key: configuredField, text } : null;
  }
  // ② 按命名特征猜：取第一个「像单号且有值」的字段
  for (const [key, value] of Object.entries(values)) {
    if (!looksLikeNoKey(key)) continue;
    const text = fieldText(value);
    if (text) return { key, text };
  }
  return null;
}

/** 块级 `data.labels`（`{字段 key: 中文名}`）→ 只留下非空字符串项。 */
function readLabels(data: Record<string, unknown>): Record<string, string> {
  const raw = data.labels;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) out[key] = text;
  }
  return out;
}

/**
 * 回执字段的显示顺序 —— 按「用户关心的先后」，不是接口 JSON 的键序。
 *
 * 直接 `Object.entries(values)` 的后果：接口 JSON 里 `order_no` 之后紧跟
 * `room_no`、`item`、`quantity`、`eta_minutes`，看着没问题；但只要接口换了
 * 字段顺序（或加了字段），「多久能到」就会掉到第三行去 —— 而它往往是用户
 * 扫一眼回执最想确认的东西。
 *
 * 不在表里的字段排最后，**保持彼此的原始顺序**：接口新加的字段不至
 * 于被排到核心字段前面，也不会因为排序把它们打乱。
 */
const RECEIPT_KEY_PRIORITY = [
  'room_no',
  'item',
  'quantity',
  'eta_minutes',
  'guest_name',
  'note',
];

function orderedEntries(values: Record<string, unknown>): [string, unknown][] {
  const priorityOf = (key: string): number => {
    const index = RECEIPT_KEY_PRIORITY.indexOf(key);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  // `sort` 在 V8 里是稳定排序，所以同优先级（都是 MAX）的保持原序。
  return Object.entries(values).sort(([a], [b]) => priorityOf(a) - priorityOf(b));
}

/**
 * 提交回执。
 *
 * 只画三样：结论（卡头）、单号（有就单独一行，它是用户后续报查的唯一凭据）、
 * 其余字段（扁平列出）。**不画「再来一单」这类按钮** —— 提交类场景的终态是
 * 「办完了」，再点一次大概率是重复下单，按钮应该由业务方明确要求时才加。
 *
 * ## 字段名为什么用后端给的 `labels`
 *
 * `room_no` / `eta_minutes` 这类 key 是接口的参数名，直接摆给用户看是
 * 「一坨 JSON」。后端从场景的 `slots_json` 里取管理员填好的中文名（那是
 * 唯一事实来源 —— 内置字典注定只能翻一部分业务），以块级 `data.labels`
 * 下发。对不上的（用了 `param_map`、或接口自己加的字段）退回显示原始 key：
 * 不好看，但能看出是哪个字段，比编一个错的中文名强。
 */
export function GenericToolSubmitResultCard({
  block,
  params,
}: SceneBlockProps) {
  const data = block.data ?? {};
  const hits = resultHits(data, '');
  const total = resultTotal(data);

  // 没有 items 的 result 块：退化成文本，不装作「办完了」（同 generic.table_match）。
  if (hits.length === 0) {
    return (
      <div className={CARD_CLASS} data-scene-module="generic.tool_submit">
        <div className="px-[14px] py-[11px] text-[12px] leading-[1.6] text-[#343633]">
          {block.fallback_text || '没有可展示的结果。'}
        </div>
      </div>
    );
  }

  const title = paramText(params, 'receipt_title', GENERIC_TOOL_SUBMIT_DEFAULTS.receipt_title);
  /*
   * 卡头副标题与单号标签都是**话术**，归场景自己填（`params` 来自场景的
   * `ui_config.params`，员工在定义器里改）。
   *
   * 为什么不像以前那样写死：
   * - 副标题原本硬编码「请保留下面的单号，便于后续查询」/「已处理 N 项」。
   *   客房送物可以说「师傅 20 分钟内上门」，报修可以说「已派单给张师傅」，
   *   预约可以说「凭预约码到前台取号」—— 同一张卡不同业务说的完全不是一回事。
   * - 单号标签原本只能从 `receipt_no_label` 取，且默认「单号」。"受理单号" /
   *   "运单号" / "工单编号" 都是这个词的不同叫法，必须能改。
   */
  const subtitle = paramText(params, 'receipt_subtitle', '');
  const configuredNoField = paramText(params, 'receipt_no_field', '');
  const configuredNoLabel = paramText(params, 'receipt_no_label', '');

  // 一条回执：取第一项。`total` 只是保持形状一致，不参与显示 ——
  // 「共 1 条」对提交类回执是废话。
  const values = hits[0].raw.values;
  const flat = (values && typeof values === 'object' ? values : {}) as Record<string, unknown>;
  const labels = readLabels(data);

  const receiptNo = receiptNoOf(flat, configuredNoField);
  const rows = orderedEntries(flat)
    .map(([key, value]) => ({ key, label: labels[key] || key, text: fieldText(value) }))
    .filter((row) => Boolean(row.text) && (!receiptNo || row.key !== receiptNo.key));

  // 副标题的兜底仍然保留（用户没填时给一句有意义的话），但它是兜底不是规定
  const subtitleText = subtitle || (receiptNo ? '请保留下面的单号，便于后续查询' : `已处理 ${total} 项`);

  return (
    <div className={CARD_CLASS} data-scene-module="generic.tool_submit">
      {/* 卡头：渐变方向必须是 135deg（契约 §1.2 / §7.1 第 1 条）。 */}
      <div className="border-b border-[#e7dfd3] bg-[linear-gradient(135deg,#f0faf8_0%,#fbfbfa_100%)] px-[14px] py-[11px]">
        <h3 className="mb-[2px] text-[13px] font-semibold tracking-[-0.01em] text-[#18181a]">
          {title}
        </h3>
        <div className="text-[11.5px] text-[#9a9b95]">{subtitleText}</div>
      </div>

      <div className="px-[14px] py-[11px]">
        {receiptNo && (
          <div className="mb-[8px] flex items-baseline gap-[8px]">
            <span className="text-[10px] tracking-[0.02em] text-[#9a9b95]">
              {configuredNoLabel || labels[receiptNo.key] || '单号'}
            </span>
            <span className="font-mono text-[13px] font-semibold text-[#0f766e]">
              {receiptNo.text}
            </span>
          </div>
        )}
        {rows.length > 0 && (
          <div className="flex flex-wrap gap-x-[16px] gap-y-[3px]">
            {rows.map((row) => (
              <span key={row.key} className="text-[11.5px] leading-[1.6] text-[#343633]">
                <span className="text-[10px] tracking-[0.02em] text-[#9a9b95]">{`${row.label} `}</span>
                <span className="font-mono text-[12px]">{row.text}</span>
              </span>
            ))}
          </div>
        )}
        {/*
          这里原本有一颗「查看进度」按钮（`progress_text` / `progress_query` 可配）。
          2026-11-26 移除，用户原话：「移除查看进度的按钮，因为点了也没啥实际的
          作用。」

          ## 为什么是删掉，而不是把默认值改成空串

          那颗按钮做的事是 `sendText('帮我查一下刚才那单的进度')` —— 起一轮**普通
          对话**，让模型自己去理解「刚才那单」。但模型手上没有这张回执的上下文：
          接口返回的 `order_no` 只在卡片里，不在会话槽位里，也没有对应的查单工具。
          于是它只能回一句「请提供单号」或者编一段进度。**点了确实没有作用**，
          而且比没有按钮更糟 —— 用户以为系统能查，试完才发现是空的。

          真要支持查进度，得有「按单号查」的工具接口（`tool_api_json` 配第二个
          工具），那是另一个功能，不是一颗按钮。在那之前，摆一颗假装能查的按钮
          是在骗用户。

          ## 为什么不保留成「可配置但默认关闭」

          留着 `progress_text` / `progress_query` 两个参数项，定义器里就会多出
          两个输入框，管理员改了**没有任何效果**（渲染它的代码没了）—— 正是
          用户反复强调的「同一个东西出现在不同地方、行为却不一样」。所以两个
          参数项一并删除，`GENERIC_TOOL_SUBMIT_DEFAULTS` 里也不留尾巴。

          `sendText` 仍是本组件的入参（卡内的兜底路径会用到），不要因为它
          在这里不再被引用就当成死参数删掉。
        */}
      </div>
    </div>
  );
}

/**
 * 失败态 —— 复用通用空卡。
 *
 * 后端在失败时给 `on_empty: "none"` 且 `suggestions: []`，因为这里的失败
 * 与 `table_match` 的「条件太窄」完全不同：这是外部接口问题，给「放宽条件」
 * 那类建议只会误导。`SceneEmptyCard` 判 `on_empty === 'none'` 会把整个建议区收掉。
 */
export function GenericToolSubmitEmptyState({
  block,
  sendText,
  submitSlots,
  canSubmitSlots,
  disabled = false,
}: SceneBlockProps) {
  return (
    <SceneEmptyCard
      block={block}
      sendText={sendText}
      submitSlots={submitSlots}
      canSubmitSlots={canSubmitSlots}
      disabled={disabled}
      dataModule="generic.tool_submit.empty"
    />
  );
}

export default defineSceneModule({
  meta: {
    module_key: 'generic.tool_submit',
    module_version: 1,
    supported_scene_types: ['tool_submit'],
    summary: '收表单 → 调配置好的接口 → 回复一张回执。业务逻辑全在接口里。',
    // 空的 `required_slots`：这个 module 不预设任何字段 —— 字段完全由场景的
    // `slots_json` 决定（客房送物要房号和物品，工单提交要标题和描述）。
    // 写死任何一组都会让别的业务被迫带上无关字段。
    required_slots: [],
    params_schema: genericToolSubmitParams,
    entry_behavior: 'open_form',
    display_name: '通用表单提交',
    // 类型层 tool_submit 已是 needs_table: 'none'，模块不声明（只能收紧不能放宽）。
  },
  SlotForm: GenericToolSubmitSlotForm,
  ResultCard: GenericToolSubmitResultCard,
  EmptyState: GenericToolSubmitEmptyState,
});