import type { ChatAttachmentRead, ChatMessage } from '@/types';

export type SessionSlot = {
  serverMessages: ChatMessage[];
  realtimeMessages: ChatMessage[];
};

export type StreamSlot = {
  loading: boolean;
  phase: string;
  timer: number | null;
  accumulated: string;
  turnId: string | null;
  cancelledTurnId: string | null;
  abortController: AbortController | null;
  relayRecoveryStartedAt: number | null;
  relayRecoveryTurnId: string | null;
};

export type TraceSkill = {
  skillId: string;
  name?: string;
  stepId?: string;
  state?: string;
};

export type TraceTool = {
  toolId: string;
  toolCallId?: string;
  toolName: string;
  rawToolName?: string;
  success?: boolean;
  isError?: boolean;
  content?: unknown;
};

export type CotTraceIconName = 'advance' | 'execute' | 'generated' | 'judge' | 'loading' | 'select' | 'tool';

export type MCPAppViewDescriptor = {
  server_id: string;
  resource_uri: string;
  tool_name: string;
  visibility: string[];
  mime_type: string;
  tenant_id?: string | null;
  agent_id?: string | null;
  session_id?: string | null;
  active_skill_id?: string | null;
  initial_result?: unknown;
  initial_meta?: Record<string, unknown>;
};

export type TraceLine = {
  id: string;
  kind: 'thinking' | 'decision' | 'skill' | 'tool' | 'code' | 'knowledge';
  text: string;
  detail?: string;
  code?: string;
  language?: string;
  output?: string;
  outputLanguage?: string;
  outputTitle?: string;
  state: 'running' | 'completed' | 'failed';
  collapsible?: boolean;
  icon?: CotTraceIconName;
  placeholder?: boolean;
  provisional?: boolean;
  depth?: number;
  mcpApp?: MCPAppViewDescriptor;
  /** 步骤耗时（毫秒）。历史轮次来自后端事件投影，实时轮次由前端计时。 */
  durationMs?: number;
  /** 前端实时计时起点（毫秒时间戳）。 */
  startedAt?: number;
  /** 前端实时计时终点（毫秒时间戳）。 */
  completedAt?: number;
};

export type TurnTrace = {
  lines: TraceLine[];
  startedAt: number;
  completedAt?: number;
  /** 整轮耗时（毫秒）。历史轮次来自后端事件投影。 */
  durationMs?: number;
  /** 首 token 耗时（毫秒）：消息发出 → 第一个答案字符。后端流式调用才有。 */
  firstTokenMs?: number;
};

export type ComposerAttachment = ChatAttachmentRead & {
  uploadStatus: 'uploading' | 'ready' | 'error';
  uploadKey: string;
};

/**
 * A2UI：后端在「需要用户补充信息」时随助手消息下发的**表单描述**。
 * 用户提交的是结构化取值，后端直接写槽，不再让模型去解析一段自然语言。
 */
export type A2UIFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'time'
  | 'datetime'
  | 'boolean'
  | 'select'
  | 'confirm';

export type A2UIFieldOption = {
  value: string | number | boolean;
  label: string;
};

export type A2UIField = {
  name: string;
  label: string;
  type: A2UIFieldType;
  required?: boolean;
  placeholder?: string;
  options?: A2UIFieldOption[];
};

export type A2UIForm = {
  /**
   * 表单种类。**故意是 `string` 而不是 `'slot_form'` 字面量**：
   *
   * 场景 v3 之后，消息里可能同时有多套「块协议」——老的 `a2ui`（`kind: 'slot_form'`）、
   * 新的 `ui_blocks`（`kind: 'form' | 'result' | ...`）、以及将来 module 自己声明的
   * 其它 kind。类型收窄到 `'slot_form'` 会让「收到一个合法但未知的 kind」变成类型错误，
   * 而运行期它必须能被安全忽略（渲染成兜底文本），不能抛。
   *
   * ⚠️ 放宽这个类型**不等于**要删 `chatHelpers.tsx` 里 `form.kind !== 'slot_form'`
   * 那行收窄 —— 那是 legacy 通道的准入条件，与本类型无关（详见该处注释）。
   */
  kind: string;
  skill_id?: string;
  step_id?: string;
  step_name?: string;
  title?: string;
  /**
   * 卡头副标题：标题下面那句短说明（「填好这几项，我按方案表逐条比对」）。
   *
   * 与 `step_name` **不是**同一个东西，不要合并：
   * - `step_name` 是 SOP 语义（「确认开具信息」），由步骤执行器给；
   * - `subtitle` 是场景语义（「填完会发生什么」），由场景配置给。
   *
   * 两者同时在的场景没有（SOP 步骤不走场景表单），所以渲染优先级不影响行为，
   * 但类型上必须分开 —— 合并会让「SOP 步骤名」有机会被当成场景文案展示出来。
   */
  subtitle?: string;
  submit_label?: string;
  fields: A2UIField[];
};

/**
 * 消息内的一块 UI 的统一形态（场景 v3）。
 *
 * 字段与后端 `app/scene_modules/types.py:SceneUiBlock.to_dict()` **一一对应**，
 * 另外多认两个 legacy 键（`id` / `type`）—— 消息 metadata 来自后端，必须容忍脏数据。
 *
 * ## 与 `BuiltinBlockKind` 的关系
 *
 * - `kind` 取 `BlockKind`（text/result/empty/step/handoff/form）= 后端产出的语义块，
 *   有 `module_key` 就去注册表找 module 渲染，没有就走框架内置渲染器；
 * - `kind` 取框架内置值（`suggested_actions` / `scheduled_task_draft` / `dispatch` /
 *   `team_progress` / `harness_artifacts` / `knowledge_citations`）= **后端永不产出**，
 *   由前端从既有 metadata 键合成，渲染器也在前端。
 *
 * 分发规则只有一条：**有 `module_key` 查注册表，否则走内置**。
 */
export type A2UIBlock = {
  /** 语义 kind 或框架内置 kind。**不收紧成联合类型**（见 `A2UIForm.kind` 的理由）。 */
  kind: string;
  /** 结构化业务数据。形状由 kind 定死；module 只读不造。 */
  data?: Record<string, unknown>;
  /** 用哪个 scene module 渲染。缺失 → 走框架内置渲染器。 */
  module_key?: string;
  module_version?: number;
  /** 场景实例 id（表单提交时要续跑同一个实例）。 */
  scene_id?: string;
  /** 块级兜底文本；空则用场景级 fallback_text。 */
  fallback_text?: string;
  /** 框架内置块自带的内容（`suggested_actions` 的 actions 等直接挂在块上）。 */
  [extra: string]: unknown;
};

export const A2UI_FIELD_TYPES: ReadonlySet<string> = new Set([
  'text',
  'number',
  'date',
  'time',
  'datetime',
  'boolean',
  'select',
  'confirm',
]);


export type ComposerInteractionMode = 'normal' | 'scheduled_task';
export type DraftScheduleType = 'once' | 'daily' | 'weekly' | 'monthly';

export function createEmptySlot(): SessionSlot {
  return { serverMessages: [], realtimeMessages: [] };
}

export function createStreamSlot(): StreamSlot {
  return {
    loading: false,
    phase: '',
    timer: null,
    accumulated: '',
    turnId: null,
    cancelledTurnId: null,
    abortController: null,
    relayRecoveryStartedAt: null,
    relayRecoveryTurnId: null,
  };
}

export function createTurnTrace(): TurnTrace {
  return { lines: [], startedAt: Date.now() };
}
