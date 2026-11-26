import type { ComponentType, ReactNode } from 'react';

/**
 * 场景 v3 插件的类型契约（`docs/scenes/scene-v2-arch.md` §3.1 + team-lead 裁决）。
 *
 * 一句话：**场景 = 一个前端 module**。module 是一个目录（目录名 === module_key），
 * 导出 `meta` 和最多四个渲染组件。平台只负责「解析块 → 查注册表 → 挂载」。
 *
 * 关键的三个不变式（违反任一条都会静默降级成纯文本，不报错）：
 * 1. 目录名 === `meta.module_key`，点号命名（`travel.itinerary`）；
 * 2. `meta` 七项必填（`defineSceneModule` 在类型层兜住）；
 * 3. `kind` 只能取 `BlockKind` 里的值，**不许造新 kind**（可少实现，不可多造）。
 */

export type SceneType = 'table_match' | 'sop_flow' | 'handoff' | 'script';

export const SCENE_TYPES: SceneType[] = ['table_match', 'sop_flow', 'handoff', 'script'];

/**
 * block 的语义类型 —— **不是 UI 形态**，是「这块说的是什么事」。
 * 渲染成什么样由 module 的代码决定（同一个 kind 可以是列表、时间轴或表格）。
 */
export type BlockKind = 'text' | 'result' | 'empty' | 'step' | 'handoff' | 'form';

export const BLOCK_KINDS: BlockKind[] = ['text', 'result', 'empty', 'step', 'handoff', 'form'];

export function isBlockKind(value: unknown): value is BlockKind {
  return typeof value === 'string' && (BLOCK_KINDS as string[]).includes(value);
}

/**
 * 后端产出的一块 UI。字段与 `backend/app/scene_modules/types.py` 的 `SceneUiBlock` 一一对应。
 *
 * `data` 的形状由 `kind` 定死（arch §2.2）。module 只读不造，也不许往里塞 UI 描述字段
 * （没有 title / color / layout）。**这是「代码驱动」与「配置驱动」的分界线。**
 *
 * ## ⚠️ 名称与类型都有两个，别找错
 *
 * | 类型 | 在哪 | `kind` 类型 | 职责 |
 * |---|---|---|---|
 * | **`SceneUiBlock`**（本类型） | `src/scenes/types.ts` | `BlockKind`（收窄枚举） | **渲染契约**，交给 module |
 * | `A2UIBlock` | `src/pages/chat/chatTypes.ts` | `string`（容错） | 消息 metadata 的**容器**，来自后端 JSON |
 *
 * 两者**不能互相赋值**（`string → BlockKind` 就是 `TS2322`），转换点在
 * `src/pages/chat/messageBlockSlots.ts` 的 `toSceneBlock()`。为什么不能合成一个：
 * metadata 必须容忍未知 kind（后端可能先上线新 kind），而 module 的入参必须收窄
 * （否则 module 内部要写一堆 `default` 分支）。**容错与收窄是两个相反的要求，
 * 只能靠一个显式转换点隔开。**
 *
 * 文档（PRD）里写的是 `SceneUIBlock`（`UI` 全大写），代码是 `SceneUiBlock`（`Ui` 驼峰）。
 * **在代码里 grep `SceneUIBlock` 是零命中**——这不是缺文件，是拼写不同。
 */
export type SceneUiBlock = {
  kind: BlockKind;
  /** 结构化业务数据。形状由 kind 决定（result / empty / step / handoff / form / text）。 */
  data?: Record<string, unknown>;
  /** 用哪个 module 渲染（后端从 scene 带过来）。缺失 → 走 kind 的框架内置渲染。 */
  module_key?: string;
  module_version?: number;
  /** 场景实例 id，回传给平台（表单提交时要续跑同一个实例）。 */
  scene_id?: string;
  /** block 级兜底文本；空则用场景级 fallback_text。 */
  fallback_text?: string;
  /** 旧 a2ui 通道双写残留的字段名（容错用；metadata 来自后端，必须容忍脏数据）。 */
  [extra: string]: unknown;
};

/** 模块要求场景提供哪些输入（对话里要问终端用户的字段）。 */
export type SceneRequiredSlot = {
  key: string;
  label: string;
  type: 'number' | 'text' | 'date' | 'select' | 'boolean';
  required?: boolean;
  unit?: string;
};

/** 定义器「场景界面」区块据此渲染 module 参数表单（新增 module 时定义器零改动）。 */
export type SceneParamField =
  | { key: string; label: string; type: 'text' | 'textarea'; placeholder?: string }
  | { key: string; label: string; type: 'boolean'; default?: boolean }
  /** 从表列里选一个；`help` 是一行说明。 */
  | { key: string; label: string; type: 'column'; help?: string };

/**
 * 数据表数量档位 —— **与后端 `backend/app/scene_modules/constants.py` 逐字一致**。
 *
 * 三档对应三处唯一判断（不要写特例分支）：
 *
 * | needs_table | 渲染表区块 | 数量下限 | 缺表时发布 |
 * |---|---|---|---|
 * | `none`     | 不渲染 | 0  | 不校验 |
 * | `optional` | 渲染   | 0  | warning，不阻断 |
 * | `required` | 渲染   | ≥1 | 阻断 |
 *
 * ⚠️ 本项目**只允许这一个字段表达表数量档位**。历史上曾并存过 `table_range`
 * （`'0..N' | '0'`）与 `min_tables`，两者与 `needs_table` 并存时会互相矛盾：
 * 一侧读到 `undefined` 就被静默当成「不用表」→ `table_match` 的数据表区块
 * 整块不渲染且不报错 → 表现是「新建查表场景没有传表入口」。
 */
export type NeedsTable = 'none' | 'optional' | 'required';

/** 档位严格程度。module 层「只能收紧不能放宽」靠它比较（arch §4.1.3）。 */
export const NEEDS_TABLE_ORDER: Record<NeedsTable, number> = {
  none: 0,
  optional: 1,
  required: 2,
};

/**
 * module 元信息。**七项必填 + 两项可选**。
 *
 * 为什么必填：`summary` 与 `required_slots` 本期就有两个界面真读它
 * （员工档案下拉 / 定义器区块），否则市场化时要重写所有存量 module 的 meta。
 */
export type SceneModuleMeta = {
  /** 全局唯一，`<域>.<场景>`，**=== 目录名**（PRD §15.2）。 */
  module_key: string;
  /** 代码版本（改 bug 就升）。 */
  module_version: number;
  /**
   * 这个 module 服务哪些场景类型。定义器的 module 下拉据此过滤（PRD §6.1），
   * 过滤是「事前不可选」，不是「选了报错」。
   *
   * ⚠️ 用数组是为了让 `modulesForSceneType()` 能 `.includes()` 过滤，**不是**
   * 允许一个 module 服务多种类型：P0 每个 module 只声明 1 个（有断言锁着）。
   * 一条 `data` 的消费形状只对应一种结果结构，真要复用请拆两个 module 共享
   * `shared/` —— 否则 module 内部会出现两套互斥分支（arch §4.1.4）。
   *
   * 为什么不用单值：单值从类型上也拦不住「module 内部写 `if (kind === 'handoff')`」，
   * 它约束的是 meta 字段而不是实现，属于约定问题；而 `.includes()` 的语义是
   * 「过滤」，改成 `===` 会让 `modulesForSceneType()` 名不副实。约定问题用断言
   * 解决比用类型解决更准。
   */
  supported_scene_types: SceneType[];
  /** 能力摘要，一句话。员工档案下拉 + 列表页「能力」列**真读它**。 */
  summary: string;
  /** 它需要场景提供哪些输入（缺 → 发布阻断；多 → 只 warning）。 */
  required_slots: SceneRequiredSlot[];
  /** 定义器渲染参数表单的依据。 */
  params_schema: SceneParamField[];
  /** 入口点击行为，平台按枚举执行。 */
  entry_behavior: 'open_form' | 'send_text';
  /** 可选：人读的显示名。下拉里全是 key 时管理员看不懂。 */
  display_name?: string;
  /**
   * 可选：本 module 对数据表的额外要求。**只能收紧不能放宽** ——
   * 类型层给 `optional`，module 声明 `required` 有效（定制 module 没表画不出空态）；
   * 反向不生效。实际档位一律用 `effectiveNeedsTable()` 算，不要直接读它。
   */
  needs_table?: NeedsTable;
};

/**
 * 平台统一传给 module 的 props（PRD §5.4：回调只给三个，给得越少降级越好保证）。
 *
 * 每个 kind 一个组件 props，形状相同 —— 便于 module 内部复用一份局部状态
 * （比如比较模式下的选中项），不需要拆多份 context。
 */
export type SceneBlockProps = {
  /** 这一块的数据（形状按 kind 定）。 */
  block: SceneUiBlock;
  /** 同一轮的全部块 —— 需要跨块联动（如引言要知道结果有几条）时用。 */
  siblings: SceneUiBlock[];
  /** module 自己的参数（来自 scene.ui_config_json.params，已按 params_schema 校验）。 */
  params: Record<string, unknown>;
  /** 发一句话走新一轮。**所有交互最终都归到它**（PRD §5.3 铁律）。 */
  sendText: (text: string) => void;
  /** 提交结构化槽位取值（框架写槽，不让模型解析自然语言）。 */
  submitSlots: (values: Record<string, unknown>) => void;
  /**
   * `submitSlots` 是否**真的可用**。
   *
   * 为什么不能靠 `if (submitSlots)` 判断：`SceneBlockList` 会把所有回调
   * 兜底成 no-op（防止 module 里出现 `is not a function` 把整卡崩掉），
   * 所以它在分享页 / 历史回看里也**非空**，只是调了什么都不做。
   * 于是「点了建议按钮没反应」这类问题在类型上完全看不出来。
   *
   * 需要判断的场景：空结果卡的建议按钮 —— 有提交能力时走「改槽重跑」，
   * 没有时退回 `sendText`（发一句话，而不是静默失败）。
   * 不传视为 `false`，让最保守的路径成为默认。
   */
  canSubmitSlots?: boolean;
  /** 打开外链（分享页 / 历史回看时为 no-op）。 */
  openExternal: (url: string) => void;
  /** 只读态（分享页 / 历史回看 / 场景已归档）。 */
  disabled?: boolean;
  /**
   * 框架内置渲染器（由 `SceneBlockList` 注入，**不是** module 自己传的）。
   *
   * 为什么放在 props 里而不是让 module 直接 import `SlotFormCard`：`src/scenes/` 是
   * 框架无关层，`src/pages/chat/components/` 是它的上层容器。反向 import 会让
   * scenes 依赖 chat，以后在别的容器（工作台、分享页）复用就炸，也会让
   * `registry.test.ts` 把整个聊天页拉进测试图。
   *
   * 典型用法：`generic.table_match` 的 `SlotForm` 拿到 `form` block 后直接
   * `return <>{renderForm(form)}</>`，把「表单长什么样」这件事留给平台，
   * 保证场景表单与 SOP 表单**是同一个组件、同一套校验、同一个提交口径**。
   */
  renderBuiltin?: (block: SceneUiBlock) => ReactNode;
  /** 「场景表单」渲染器：`data` 是 `build_slot_form()` 的输出。 */
  renderForm?: (data: Record<string, unknown>) => ReactNode;
};

export type SlotFormProps = SceneBlockProps;
export type ResultCardProps = SceneBlockProps;
export type EmptyStateProps = SceneBlockProps;
export type StepViewProps = SceneBlockProps;

/**
 * 一个 module 的导出形状 —— **一个 meta + 最多四个组件**。
 *
 * `kind → 组件` 映射（唯一合法映射，不要扩）：
 * - `form`   → `SlotForm`
 * - `result` → `ResultCard`
 * - `empty`  → `EmptyState`
 * - `step`   → `StepView`
 * - `text` / `handoff` → **无组件**，框架渲染 `data.content` 或 `fallback_text`
 *
 * 「可少实现、不可多造 kind」：没实现 `EmptyState` 时降级渲染 `fallback_text`，
 * 不要为了「空态好看」去造一个新 kind —— 那会让后端的 BlockKind 枚举与前端漂移。
 */
export type SceneModule = {
  meta: SceneModuleMeta;
  SlotForm?: ComponentType<SlotFormProps>;
  ResultCard?: ComponentType<ResultCardProps>;
  EmptyState?: ComponentType<EmptyStateProps>;
  StepView?: ComponentType<StepViewProps>;
};

/** 场景实例的完整信息（chips / 试跑面板用）。 */
export type SceneInstanceRef = {
  scene_id: string;
  name: string;
  module_key: string;
  module_version: number;
  scene_type: SceneType;
};

/**
 * 入口胶囊。来自 `GET /api/chat/scenes?tenant_id=&agent_id=`。
 *
 * ## 逐字对齐后端，不要在这里「补充」字段
 *
 * 唯一事实来源是 `backend/app/scenes/schema.py` 的 `SceneModuleRead`，
 * 由 `backend/app/scene_modules/chips.py` 的 `list_scene_chips()` 构造。
 * 九个字段一个不多一个不少：
 *
 * | 字段 | 后端有无 | 说明 |
 * |---|---|---|
 * | `scene_id` | ✓ | |
 * | `module_key` | ✓ | 空串表示老场景没写 module（前端要降级） |
 * | `module_version` | ✓ | |
 * | `label` | ✓ | 三级回落算出的**展示文案** |
 * | `icon` | ✓ | 空串 = 不画图标，不要回落到某个默认 emoji |
 * | `send_text` | ✓ | `send_text` 型入口点下去发的话 |
 * | `slots` | ✓ | 字段定义，**后端已合并** module + 实例覆盖 |
 * | `scene_name` | ✓ | 场景原始名，比 `label` 长，只配放 `title` |
 * | `scene_type` | ✓ | |
 * | ~~`entry_behavior`~~ | **✗** | 见下 |
 *
 * ## 为什么没有 `entry_behavior`
 *
 * 入口行为由 module 的 `meta.entry_behavior` 声明（PRD §19 第 6 条），
 * **后端不持有这个事实**——后端没有 module 的 meta（`chips.py:33-37` 写着
 * 「刻意没有 `on_click`」）。抄一份进 DB 会让「改了代码线上行为没变」，
 * 而且两处都看不到对方。
 *
 * 所以前端要用 `module_key` 去 `loadModule()` 查 meta 才知道是弹表单还是发文本。
 * 本类型上放一个 `entry_behavior` 字段的后果是：它永远 `undefined`，
 * 而 `open_form` / `send_text` 会被静默当成 `undefined` 处理掉——
 * 正是「类型看着有、运行时没有」的静默故障。
 */
export type SceneChip = {
  scene_id: string;
  /** `=== 目录名`。空串 = 老场景，前端按「纯文本入口」降级，不要抛错。 */
  module_key: string;
  module_version: number;
  /** 展示文案（`shortcut_json.label` → `trigger_json.shortcut_label` → 场景名）。 */
  label: string;
  /** 空串 = 不画图标。 */
  icon: string;
  /** `send_text` 型入口点下去发的话；空串则由父级回落用 `label`。 */
  send_text: string;
  /** 入口点开后立刻要画的字段定义。后端已合并，前端不要自己再合并一次。 */
  slots: Array<Record<string, unknown>>;
  /** 场景原始名。比 `label` 长，只配放 `title`（hover 才看）。 */
  scene_name: string;
  scene_type: string;
};

/**
 * 场景类型元数据。
 *
 * `needs_table` 是**唯一事实来源**：表区块渲不渲染由它推出来（见下方构建函数），
 * 不另写一份 `blocks.tables` 字面量 —— 两个能互相矛盾的字段迟早会矛盾。
 */
export type SceneTypeMeta = {
  type: SceneType;
  label: string;
  icon: string;
  tagline: string;
  /** 表数量档位。**不要在这里出现 `table_range` / `min_tables`。** */
  needs_table: NeedsTable;
  /** 该类型下哪些区块要渲染（不渲染，不是置灰）。除 `slotsReadOnly` 外全部由档位推导。 */
  blocks: {
    tables: boolean;
    matchStrategy: boolean;
    slots: boolean;
    /** 槽位只展示、编辑禁用（script 类型）。 */
    slotsReadOnly: boolean;
  };
};

/**
 * 构建类型元信息：`tables` / `matchStrategy` 由 `needs_table` 推导。
 *
 * 推导规则 —— 有表才有「匹配策略」，所以两者同真同假：
 * - `none`     → 都不渲染
 * - `optional` / `required` → 都渲染
 *
 * 这样「`table_match` 的档位是 optional、表区块却不渲染」这种自相矛盾的状态
 * 在类型层面就写不出来。
 */
function buildTypeMeta(spec: {
  type: SceneType;
  label: string;
  icon: string;
  tagline: string;
  needs_table: NeedsTable;
  slotsReadOnly?: boolean;
}): SceneTypeMeta {
  const hasTables = spec.needs_table !== 'none';
  return {
    type: spec.type,
    label: spec.label,
    icon: spec.icon,
    tagline: spec.tagline,
    needs_table: spec.needs_table,
    blocks: {
      tables: hasTables,
      matchStrategy: hasTables,
      slots: true,
      slotsReadOnly: spec.slotsReadOnly === true,
    },
  };
}

/**
 * 类型层元信息。
 *
 * `label` / `icon` / `needs_table` 三项必须与
 * `backend/app/scene_modules/constants.py` 的 `SCENE_TYPE_META` 逐字一致
 * （由 `src/scenes/__tests__/constants.test.ts` 兜住）；`tagline` 是纯前端展示文案。
 */
export const SCENE_TYPE_META: Record<SceneType, SceneTypeMeta> = {
  table_match: buildTypeMeta({
    type: 'table_match',
    label: '查表推荐',
    icon: '📊',
    tagline: '收条件 → 从表里筛出候选 → 列出结果',
    needs_table: 'optional',
  }),
  sop_flow: buildTypeMeta({
    type: 'sop_flow',
    label: '流程办理',
    icon: '🧭',
    tagline: '步骤条推进，多轮直到流程走完',
    needs_table: 'none',
  }),
  handoff: buildTypeMeta({
    type: 'handoff',
    label: '转人工',
    icon: '🙋',
    tagline: '收信息 → 摘要 → 转给指定的人',
    needs_table: 'none',
  }),
  script: buildTypeMeta({
    type: 'script',
    label: '固定话术',
    icon: '💬',
    tagline: '关键词命中直出，零模型零逻辑',
    needs_table: 'none',
    slotsReadOnly: true,
  }),
};

/**
 * 取类型元信息。未知/空类型回落到 `table_match`。
 *
 * 与后端 `needs_table_of()`（未知 → `"none"`）的差异只在「手工改库写入了
 * 非法 scene_type」时出现：后端此时放行保存，前端此时按 table_match 渲染，
 * 也就是给管理员一个能改的界面而不是空白编辑页。正常 API 路径下不可能触发
 * （`scene_type` 有枚举校验）。
 */
export function sceneTypeMeta(type: string | undefined): SceneTypeMeta {
  const key = (type ?? 'table_match') as SceneType;
  return SCENE_TYPE_META[key] ?? SCENE_TYPE_META.table_match;
}

/** 类型层的表数量下限：只有 `required` 档要求 ≥1，其余为 0。 */
export function minTablesForType(type: string | undefined): number {
  return sceneTypeMeta(type).needs_table === 'required' ? 1 : 0;
}

/** 表数量上限 —— 与后端 `MAX_TABLES_PER_SCENE` 一致（性能护栏，与档位无关）。 */
export const MAX_TABLES_PER_SCENE = 20;

/**
 * 类型档位与 module 档位取**更严**的那个。
 *
 * module 层只能收紧不能放宽（arch §4.1.3）：
 * - `optional → required` 允许 —— 定制 module 没表画不出空态（`travel.itinerary`）
 * - `required → optional` 不允许 —— 会把阻断降成 warning
 * - `optional → none` 不允许 —— 会让传表区块静默消失
 *
 * 实现直接取 max，「相信 module」的反向情况自动不成立，不需要逐个写特例分支。
 */
export function effectiveNeedsTable(
  type: string | undefined,
  moduleNeeds?: NeedsTable,
): NeedsTable {
  const base = sceneTypeMeta(type).needs_table;
  if (!moduleNeeds) return base;
  return NEEDS_TABLE_ORDER[base] >= NEEDS_TABLE_ORDER[moduleNeeds] ? base : moduleNeeds;
}

/**
 * 表数量是否构成发布阻断。**返回文案数组，空数组 = 可发布** ——
 * 与后端 `table_count_issues()` 语义一致。
 *
 * warning 走 `tableCountWarnings()`，**不混进这个通道**：混进来前端会渲染成
 * 「不能发布」，正好退回本次重构要消灭的「缺表阻断」。
 *
 * ## 第三个参数不是「可选装饰」，是 `required` 唯一的来源
 *
 * 类型层四档里**没有** `required`（见 `SCENE_TYPE_META`），它只可能来自
 * module 声明（`travel.itinerary` 就是）。所以档位必须用
 * `effectiveNeedsTable(type, moduleNeeds)` 现算，**不能**只读
 * `sceneTypeMeta(type).needs_table` —— 那只看得见类型那半边。
 *
 * 漏传 `moduleNeeds` 的后果是「定制 module 缺表也能发布」，而发布出去后
 * 这个 module 画不出空态，用户看到的是白块。所以调用点手里有 module meta
 * 就必须传。
 */
export function tableCountIssues(
  type: string | undefined,
  count: number,
  moduleNeeds?: NeedsTable,
): string[] {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  // 上限必须先判：倒了会被最后的 return [] 放过，而 table_match 是唯一能传多表的类型。
  if (n > MAX_TABLES_PER_SCENE) {
    return [`一个场景最多 ${MAX_TABLES_PER_SCENE} 张表，当前 ${n} 张`];
  }
  if (effectiveNeedsTable(type, moduleNeeds) === 'required' && n === 0) {
    return ['这个场景至少需要 1 张数据表'];
  }
  return [];
}

/**
 * 不阻断、但要在定义器/发布检查里提示的问题。与 `tableCountIssues()` 严格互补。
 *
 * 档位同样走 `effectiveNeedsTable()`：module 收紧到 `required` 后，0 张表
 * 是**阻断**，此时不能再返回「发布后只会提示未配表」——那是把阻断说成提示，
 * 两条通道同时命中会让界面既报错又安抚，读起来像 bug。
 */
export function tableCountWarnings(
  type: string | undefined,
  count: number,
  moduleNeeds?: NeedsTable,
): string[] {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  const needs = effectiveNeedsTable(type, moduleNeeds);
  if (needs === 'optional' && n === 0) {
    return ['这个场景还没有数据表，发布后用户触发时只会提示未配表'];
  }
  if (needs === 'none' && n > 0) {
    return [
      `当前场景类型不使用数据表，${n} 张表已保留但不会生效（切换回查表推荐可继续使用）`,
    ];
  }
  return [];
}