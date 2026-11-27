import { useEffect, useMemo, useState, type ReactNode } from 'react';

import SlotFormCard from '@/pages/chat/components/SlotFormCard';
import { parseA2UIForm } from '@/pages/chat/chatHelpers';
import { normalizeFormData } from '@/pages/chat/messageBlockSlots';
import { componentForKind, loadSceneModule } from '@/scenes/registry';
import type { SceneModule, SceneUiBlock } from '@/scenes/types';
import type { SceneSlot } from '@/api/scenes';

/**
 * 场景的**三段预览**：胶囊 → 表单 → 结果卡。
 *
 * ## 为什么不是一张示意图
 *
 * 用户要判断的是「我这个场景长什么样」。画一张示意图就等于 Demo 一个样、
 * 实际另一个样 —— 正是本项目明确要避免的事（视觉契约 §0 第 3 条：
 * 每个 module 完成后用同一份数据对照）。所以这里全部用**真组件**渲染：
 * 结果卡来自 module 的 `ResultCard`，表单来自聊天的 `SlotFormCard`，
 * 胶囊按 `SceneChips` 的视觉契约逐值复刻。
 *
 * ## 为什么预览要覆盖三段，而不是只有结果卡
 *
 * 原先只有结果卡。但用户在聊天里实际经历的是三步：
 *
 * 1. 输入框上方看到一颗胶囊（点进去）；
 * 2. 弹出表单填条件（或直接发一句话）；
 * 3. 看到结果卡。
 *
 * 只预览第 3 步的话，管理员调槽位时**看不到表单会被排成什么样** —— 而槽位
 * 恰恰是定义器里最常改的一块（label / 单位 / 必填）。改了 label 预览纹丝不动，
 * 用户只能保存 → 开聊天 → 点一次才知道效果，那就不叫「直观」。
 *
 * ## 为什么不传 `sendText`
 *
 * 预览态下点「选这个」不该发消息。`sendText` 传空函数即可 —— module 的铁律是
 * 「所有交互都归到 sendText」，但没人规定它必须真的发出去。传一个 no-op 比
 * 传 `undefined` 安全：后者会让 module 里的 `sendText(...)` 直接抛 TypeError。
 *
 * ## 为什么从 `SceneEditor` 里搬出来
 *
 * 场景管理页的检查器右列也要画同一个预览（`scene-manager-demo.html`
 * `.insp-col` 第二节）。两边各写一份的话，一处改了 module 契约、
 * 另一处就会静默停在旧形状 —— 而预览恰恰是「不许漂」的那部分。
 */

/**
 * 预览用的样例数据 —— **按场景类型给不同形状**。
 *
 * ## 为什么不能只有一份
 *
 * 原先是写死的行程样例（经典雪山五日 / 亚布力 / 4 人 / 5 天 / 3000）。
 * 用户建「客房送物」时看到的也是这份数据：回执卡上写着「亚布力」「4 人」
 * 「3000」，既不是他的业务、也判断不了自己配的话术对不对 ——
 * 「预览」本该回答「我配完是什么样」，一份与配置无关的样例提供不了这个答案。
 *
 * 现在按 `module_key` 分派：行程给行程样例，表单提交给一张**通用回执**
 * （字段名用 `labels` 里的中文，值用中性占位）。认不出的类型回落到行程
 * —— 那是目前视觉契约的唯一基准，至少能看出卡片家族长什么样。
 */

/** 行程推荐的样例（`travel.itinerary`）。形状严格按 arch §2.2 的 `kind=result` 契约。 */
const ITINERARY_BLOCK: SceneUiBlock = {
  kind: 'result',
  module_key: '',
  module_version: 0,
  fallback_text: '',
  data: {
    total: 1,
    max_items: 1,
    items: [
      {
        row_id: 'preview-1',
        score: 0,
        source_table: '滑雪套餐价目表',
        values: {
          计划内容: '经典雪山五日',
          目的地: '亚布力',
          人数: 4,
          天数: 5,
          预算: 3000,
          日程: [
            { title: '抵达亚布力', description: '哈尔滨接站，入住雪场酒店。', tags: ['含接站', '含晚餐'], phase: '抵达' },
            { title: '初级道练习', description: '上午教练带练，下午自由滑。', tags: ['含雪票', '含教练'], phase: '初级' },
            { title: '进阶训练', description: '中级道压弯与回转技巧。', tags: ['含教练'], phase: '进阶' },
            { title: '自由滑行', description: '全天自由安排，可选雪地摩托。', tags: ['自由活动'], phase: '自由' },
            { title: '返程', description: '早餐后送站。', tags: ['含送站'], phase: '返程' },
          ],
        },
      },
    ],
  },
};

/**
 * 表单提交的样例（`generic.tool_submit`）。
 *
 * 字段刻意用**场景配的槽位 label**（调用方传 `params` 时一并传 `slotLabels`），
 * 这样「我配的字段会怎么显示」能直接看出来。没有槽位信息时用一组中性占位。
 *
 * `data.labels` 一起给：回执卡靠它把英文 key 翻成中文，预览里也得有，
 * 否则用户看到的是 `order_no`、`eta_minutes`，跟他配的中文名对不上。
 */
function toolSubmitBlock(overrides?: {
  title?: string;
  subtitle?: string;
  noField?: string;
  slotLabels?: Record<string, string>;
}): SceneUiBlock {
  const labels = overrides?.slotLabels ?? {};
  const values: Record<string, unknown> = {
    // 单号字段：用户配了就用他的，否则给一个「像单号」的占位
    [overrides?.noField || 'order_no']: 'RD20261126001',
  };
  // 槽位字段：有 label 的按 label 出，没配则给两个通用占位
  const slotEntries = Object.entries(labels);
  if (slotEntries.length > 0) {
    for (const [key, label] of slotEntries) {
      if (key === (overrides?.noField || 'order_no')) continue;
      values[key] = `示例${label}`;
    }
  } else {
    values.item = '示例物品';
    values.quantity = 2;
  }

  return {
    kind: 'result',
    module_key: '',
    module_version: 0,
    fallback_text: '',
    data: {
      total: 1,
      max_items: 1,
      items: [{ row_id: 'preview-1', score: 0, source_table: '', values }],
      // 回执卡读块级 labels 做中文名。这里把「单号字段」也补上中文名，
      // 否则预览里单号那一行的标签会退回英文 key。
      labels: {
        ...labels,
        [overrides?.noField || 'order_no']: '单号',
      },
    },
  };
}

/** 按 module 选样例。未知类型回落到行程（视觉契约的基准）。 */
export function previewBlockFor(
  moduleKey: string,
  overrides?: {
    title?: string;
    subtitle?: string;
    noField?: string;
    slotLabels?: Record<string, string>;
  },
): SceneUiBlock {
  if (moduleKey === 'generic.tool_submit') return toolSubmitBlock(overrides);
  return ITINERARY_BLOCK;
}

/** @deprecated 用 `previewBlockFor()` —— 保留仅为兼容既有 import。 */
export const PREVIEW_BLOCK: SceneUiBlock = ITINERARY_BLOCK;

export default function ScenePreviewCard({
  moduleKey,
  /**
   * 场景的 `ui_config.params` —— **必须传**，这是「预览」有意义的前提。
   *
   * 传空对象时卡片会用代码兜底话术（如「已提交」），看起来是能出图的；
   * 但用户改过的结论句、单号标签全都不会体现。那就退回到
   * 「Demo 一个样、实际另一个样」—— 正是这个组件存在的理由所反对的事。
   */
  params,
  /**
   * 槽位 key → 中文名。回执卡靠块级 `data.labels` 翻字段名，预览也要有，
   * 否则用户看到 `room_no` / `item`，跟他刚配的中文名对不上。
   */
  slotLabels,
  /** 是否显示「样例数据预览」这行说明。检查器右栏自己有分组标题，就不再叠一层。 */
  showCaption = true,
}: {
  moduleKey: string;
  params?: Record<string, unknown>;
  slotLabels?: Record<string, string>;
  showCaption?: boolean;
}) {
  const [module, setModule] = useState<SceneModule | null>(null);
  const [failed, setFailed] = useState(false);

  /**
   * 样例数据跟着配置走。
   *
   * `receipt_no_field` 是用户明确指定的单号字段 —— 预览里必须用同一个字段名，
   * 否则用户填了 `waybill_no`，预览卡片上却显示 `order_no`，会以为配置没生效。
   */
  const block = useMemo(() => {
    const raw = params?.receipt_no_field;
    const noField = typeof raw === 'string' ? raw.trim() : '';
    return previewBlockFor(moduleKey, { noField, slotLabels });
  }, [moduleKey, params, slotLabels]);

  useEffect(() => {
    let alive = true;
    setModule(null);
    setFailed(false);
    if (!moduleKey) return;
    void (async () => {
      const mod = await loadSceneModule(moduleKey);
      if (!alive) return;
      if (mod) setModule(mod);
      else setFailed(true);
    })();
    return () => {
      alive = false;
    };
  }, [moduleKey]);

  if (!moduleKey) {
    return (
      <p className="m-0 rounded-[10px] bg-[#fbfaf6] px-[12px] py-[10px] text-[12px] text-[#9a9b95]">
        先选一个场景类型，这里会显示用户实际看到的卡片。
      </p>
    );
  }

  // 未知 module / chunk 加载失败：明确说「没有这个界面组件」，
  // 而不是显示空白 —— 空白看起来像「加载中」，用户会一直等。
  if (failed) {
    return (
      <p className="m-0 rounded-[10px] bg-[#fff2e5] px-[12px] py-[10px] text-[12px] leading-[18px] text-[#b45309]">
        没有找到「{moduleKey}」的界面组件，聊天里会退化成纯文本。
      </p>
    );
  }

  if (!module) {
    return <p className="m-0 text-[12px] text-[#9a9b95]">加载预览…</p>;
  }

  const Card = module.ResultCard;
  if (!Card) {
    return (
      <p className="m-0 rounded-[10px] bg-[#fbfaf6] px-[12px] py-[10px] text-[12px] leading-[18px] text-[#9a9b95]">
        这个场景类型的回答是纯文本，没有卡片界面。
        {module.meta.summary ? `（${module.meta.summary}）` : ''}
      </p>
    );
  }

  return (
    <div className="rounded-[12px] border border-dashed border-[#cfc5b7] bg-[#fbfaf6] p-[10px]">
      {/* 说明这只是一份样例：用真组件必然要喂数据，不标注会被误认成真结果 */}
      {showCaption && (
        <p className="m-0 mb-[8px] text-[10.5px] text-[#9a9b95]">
          样例数据预览 · 用户在聊天里看到的效果
        </p>
      )}
      <Card
        block={block}
        siblings={[block]}
        params={params ?? {}}
        sendText={() => {}}
        submitSlots={() => {}}
        openExternal={() => {}}
        disabled
      />
    </div>
  );
}

/* ============================================================
   表单态预览（点开胶囊后用户填条件的那张表）
   ============================================================ */

/**
 * 把定义器的槽位草稿转成**后端同形**的表单描述（`build_slot_form()` 的输出形状）。
 *
 * ## 为什么要在这里复刻后端的 `_slot_form_block()`
 *
 * 聊天里那张表单是**后端**产的（`channels.py::_slot_form_block` → 复用
 * `build_slot_form()`）。定义器里用户还没保存，后端无从生成，只能在前端按同一
 * 份规则算一遍：
 *
 * - `label` 拼单位：「人数」+「人」→「人数（人）」，除非 label 自己已经带括号
 *   （后端 `if raw_label and not re.search(r"[（(]", raw_label)` 同一条规则）；
 * - **额外带 `unit` 键**：后端会额外塞 `field["unit"] = unit`，
 *   `ItinerarySlotForm.isMoneyField()` 靠它认出「预算」那一格。漏了它，
 *   预览里预算会退化成文本框，跟聊天里对不上；
 * - `type` 取槽位声明的类型，没声明按 `number` 猜（场景槽位几乎都是数值条件）；
 * - `required` 默认 true —— 与后端「缺必填槽位才产表单」的语义一致；
 * - `placeholder` 取槽位的 `prompt`（后端 `if spec.get("prompt")` 覆盖同一格）。
 *
 * ## 这是**唯一的**已知前端复刻点，所以注释写在这里
 *
 * 两侧规则一旦分叉，表现是「定义器预览里标签是『人数』、聊天里是『人数（人）』」
 * 这种极难察觉的漂移。改后端的拼 label 规则时，务必回来同步这一个函数。
 *
 * 返回**扁平对象**而不是 `A2UIForm`：`kind` 用后端的 `slot_form`（真实链路的
 * 那个值），交给 `parseA2UIForm()` 收窄 —— 而不是自己手搓一个 `kind: "form"`
 * 的近似物。两条路各写一份解析正是本项目反复踩的坑。
 */
export function previewFormDataFor(
  slots: SceneSlot[],
  title: string,
  subtitle?: string,
): Record<string, unknown> | null {
  const fields = slots
    .filter((slot) => String(slot.key ?? '').trim() !== '')
    .map((slot) => {
      const key = String(slot.key).trim();
      const rawLabel = String(slot.label ?? '').trim() || key;
      const unit = String(slot.unit ?? '').trim();
      // 单位拼进 label：与后端一致的「人数（人）」写法。
      // 已带括号的 label 不再拼第二遍（后端同一条正则）。
      const label = unit && !/[（(]/.test(rawLabel)
        ? `${rawLabel}（${unit}）`
        : rawLabel;
      const prompt = String(slot.prompt ?? '').trim();
      return {
        name: key,
        label,
        type: slot.type === 'text' ? 'text' : 'number',
        required: slot.required !== false,
        placeholder: prompt || `请输入${label}`,
        // 后端 `_slot_form_block` 会额外挂上 `unit`；定制 module 靠它区分
        // 「金额字段」与「普通数字字段」。少了它，预览的表单控件形态会变。
        ...(unit ? { unit } : {}),
      };
    });
  if (fields.length === 0) return null;
  return {
    // `slot_form`：`parseA2UIForm()` 的准入条件就是这个值（legacy 通道也用它）。
    // 写 `form` 会让解析直接返回 null —— 而那个 null 会被当成「没配槽位」。
    kind: 'slot_form',
    title,
    subtitle,
    submit_label: '开始匹配',
    fields,
  };
}

/**
 * `previewFormFor` 曾经在这里，把槽位草稿转成 `SlotFormCard` 认的 `A2UIForm`。
 *
 * 2026-11-26 删除：`SceneFormPreview` 改成「按 module 的 `SlotForm` 渲染」之后
 * （行程场景要用它自己那三个下拉），这条路径在生产代码里**没有调用方**了 ——
 * 兜底分支直接 `parseA2UIForm(normalizeFormData(data))`，与聊天端
 * `MessageBubble.renderFormForScene` 走同一个解析。
 *
 * 留着一个无人调用的导出只会让下一个人以为「预览有两种渲染方式」，
 * 于是可能照着它写第三条。真要那份数据，用 `previewFormDataFor()`。
 */

/**
 * 「点开胶囊后填条件」的表单预览。
 *
 * ## 渲染器必须按 module 走，不能一律 `SlotFormCard`
 *
 * 聊天里那张表单**不是**由平台统一渲染的：`SceneBlockList` 按 `module_key` 查注册表，
 * 拿到 module 之后按 `kind` 取 `SlotForm.SlotForm` 组件。于是：
 *
 * | module | 聊天里那张表的实际组件 | 控件 |
 * |---|---|---|
 * | `travel.itinerary` | `TravelItinerarySlotForm` | 三个原生下拉（人数 / 天数 / 预算） |
 * | `generic.tool_submit` | `GenericToolSubmitSlotForm` → `renderForm` → `SlotFormCard` | 文本 / 数字输入框 |
 * | `generic.table_match` | 同上 | 同上 |
 *
 * 所以预览也必须是「先拿 module 的 `SlotForm`，没有才回落 `SlotFormCard`」。
 * 一律用 `SlotFormCard` 会出现**同一个槽位配置、预览一个样、聊天另一个样**：
 * 行程场景预览里是三个输入框，真到聊天里是三个下拉。那正是用户反复提的问题。
 *
 * ## 兜底路径为什么必须存在
 *
 * `SlotForm` 是可选实现（`SceneModule` 里 `SlotForm?`）。module 没实现它时，
 * 聊天端的 `SceneModuleSurface` 会落到 `fallback_text`；但预览不该显示
 * 「没有界面组件」这种半错误态 —— 定义器里用户关心的是自己配的字段。
 * 所以这里回落 `SlotFormCard`，并明确注释「这是兜底、不是真实路径」。
 *
 * `disabled` 让它只读：预览里能点会让人以为填了就能提交。
 */
export function SceneFormPreview({
  moduleKey,
  slots,
  title,
  subtitle,
  showCaption = true,
}: {
  /** 场景当前选的 module。决定用哪个 `SlotForm` 渲染 —— 与聊天端同一份判断。 */
  moduleKey: string;
  slots: SceneSlot[];
  title: string;
  subtitle?: string;
  showCaption?: boolean;
}) {
  const data = useMemo(
    () => previewFormDataFor(slots, title, subtitle),
    [slots, title, subtitle],
  );
  const [module, setModule] = useState<SceneModule | null>(null);

  useEffect(() => {
    let alive = true;
    setModule(null);
    if (!moduleKey) return;
    void (async () => {
      const mod = await loadSceneModule(moduleKey);
      if (alive) setModule(mod);
    })();
    return () => {
      alive = false;
    };
  }, [moduleKey]);

  if (!data) {
    return (
      <p className="m-0 rounded-[10px] bg-[#fbfaf6] px-[12px] py-[10px] text-[12px] leading-[18px] text-[#9a9b95]">
        还没有配槽位。配了「要问用户什么」，这里就会显示用户点开场景后看到的表单。
      </p>
    );
  }

  return (
    <div className="rounded-[12px] border border-dashed border-[#cfc5b7] bg-[#fbfaf6] p-[10px]">
      {showCaption && (
        <p className="m-0 mb-[8px] text-[10.5px] text-[#9a9b95]">
          表单预览 · 点开场景后先填这张表
        </p>
      )}
      <FormPreviewBody moduleKey={moduleKey} module={module} data={data} />
    </div>
  );
}

/** 分隔出来只为一件事：`data` 非空之后才允许调 `hooks`。 */
function FormPreviewBody({
  moduleKey,
  module,
  data,
}: {
  moduleKey: string;
  module: SceneModule | null;
  data: Record<string, unknown>;
}) {
  // 与 `SceneBlockList` 完全同一条判断：`kind="form"` → module 的 `SlotForm`。
  // 直接复用 `componentForKind` 而不是自己写 `module.SlotForm`：映射表只有一处，
  // 将来 `form` 这种 kind 若改名，这里自动跟上。
  const SlotForm = module ? componentForKind(module, 'form') : undefined;

  if (SlotForm) {
    const block: SceneUiBlock = {
      kind: 'form',
      module_key: moduleKey,
      module_version: module?.meta.module_version ?? 0,
      fallback_text: '',
      data,
    };
    return (
      <SlotForm
        block={block}
        siblings={[block]}
        params={{}}
        sendText={() => {}}
        submitSlots={() => {}}
        openExternal={() => {}}
        disabled
      />
    );
  }

  // 兜底：module 没实现 `SlotForm`（或还没加载完）→ 平台通用表单。
  const form = parseA2UIForm(normalizeFormData(data));
  if (!form) {
    return (
      <p className="m-0 text-[12px] text-[#9a9b95]">表单数据解析失败，聊天里会显示兜底文本。</p>
    );
  }
  return (
    <SlotFormCard
      form={{ ...form, subtitle: typeof data.subtitle === 'string' ? data.subtitle : undefined }}
      onSubmit={() => {}}
      disabled
      // `hideHeader`：预览外层已有分组标题，再叠一层卡头会出现两个标题。
      hideHeader
    />
  );
}

/* ============================================================
   胶囊预览（输入框上方那颗入口按钮）
   ============================================================ */

/**
 * 聊天输入框上方那颗场景胶囊。
 *
 * 逐值复刻 `SceneChips.tsx` 的 `CHIP_CLASS`（视觉契约 §6）：圆角 full、
 * `px-[11px] py-[5px]`、11.5px、`#ded7cc` 描边。**故意不 import 那个组件**：
 * 它会自己发请求取胶囊列表，预览里只需要画一颗按钮。
 *
 * 样式漂移的风险由专门的测试盯着（`ScenePreviewCard.test.tsx` 里断言关键类名
 * 与 `SceneChips` 一致）——不靠「记得同步」。
 */
export function SceneChipPreview({
  icon,
  label,
  showCaption = true,
}: {
  icon?: string;
  label: string;
  showCaption?: boolean;
}) {
  const text = String(label ?? '').trim() || '这个场景';
  return (
    <div className="rounded-[12px] border border-dashed border-[#cfc5b7] bg-[#fbfaf6] p-[10px]">
      {showCaption && (
        <p className="m-0 mb-[8px] text-[10.5px] text-[#9a9b95]">
          入口胶囊 · 员工在输入框上方点它
        </p>
      )}
      <span
        data-preview-chip
        className={
          'inline-flex items-center gap-[5px] rounded-full border border-[#ded7cc] '
          + 'bg-white px-[11px] py-[5px] text-[11.5px] text-[#343633]'
        }
      >
        {icon ? <span aria-hidden="true">{icon}</span> : null}
        {text}
      </span>
    </div>
  );
}