import { api, TENANT_ID } from './client';
import type { SceneType } from '@/scenes/types';

/**
 * 场景（Scene）的前端类型与接口。
 *
 * 字段与 `backend/app/scenes/schema.py` 一一对应。改这里必须同步改后端，
 * 否则「定义器保存成功但某个字段悄悄丢了」这种 bug 极难发现 ——
 * 后端 Pydantic 对未知字段是忽略而不是报错。
 */

export type SceneStatus = 'draft' | 'published' | 'archived';

export type SceneColumnType = 'number' | 'text' | 'url' | 'date';

export type SceneColumn = {
  key: string;
  label: string;
  type: SceneColumnType;
  /** 该列通常带的单位（人/天/元），导入时用来校验列映射是否正确 */
  unit: string;
  aliases: string[];
  required: boolean;
  filterable: boolean;
  order: number;
};

export type SceneQualityIssue = {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  column: string;
  row_count: number;
};

export type SceneTableRead = {
  id: string;
  tenant_id: string;
  name: string;
  source_filename: string;
  columns: SceneColumn[];
  /** 导入时检出的质量问题，必须在界面上明确告知 */
  quality: SceneQualityIssue[];
  row_count: number;
  status: string;
  created_at: string;
  updated_at: string;
};

export type SceneTablePreviewRow = {
  row_index: number;
  values: Record<string, unknown>;
};

export type SceneTablePreview = {
  table: SceneTableRead;
  rows: SceneTablePreviewRow[];
};

/** 触发条件。shortcut=true 时聊天输入框上方会出现快捷按钮。 */
export type SceneTrigger = {
  shortcut: boolean;
  shortcut_label: string;
  examples: string[];
  keywords: string[];
  require_slots: boolean;
  bypass_llm_router: boolean;
};

/** 槽位定义：要问用户哪些字段，以及对应表里哪一列。 */
export type SceneSlot = {
  key: string;
  label?: string;
  /** 表里的列 key。留空则按 key 同名 / 别名兜底匹配。 */
  target?: string;
  type?: 'number' | 'text';
  unit?: string;
  required?: boolean;
  /** 反问用户时的问法。留空由后端按 label 生成。 */
  prompt?: string;
};

export type SceneMatchAction = {
  days_weight: number;
  budget_weight: number;
  days_tolerance: number;
  max_score: number;
  top_k: number;
  rule_weight: number;
  use_decision_model: boolean;
  on_empty: 'nearest' | 'clarify' | 'nothing';
};

/**
 * 命中后的回答方式。
 * - template：把行数据套进模板，稳定可控（默认）
 * - llm：把命中的行作为上下文交给模型组织语言，更自然但不可预测
 */
export type SceneRespondAction = {
  mode?: 'template' | 'llm';
  template?: string;
  intro?: string;
  /** 命中多行时最多展示几条 */
  max_items?: number;
};

/** 快捷按钮的落点：填表单 / 直接发一句 / 打开链接。 */
export type SceneShortcut = {
  action?: 'form' | 'message' | 'url';
  message?: string;
  url?: string;
};

/**
 * 场景详情。对应后端 `backend/app/scenes/schema.py:178` 的 `SceneRead`。
 *
 * ## ⚠️ 表归属是 `table_ids`（数组），没有 `table_id`
 *
 * 场景 v3 起，一个场景私有 **0..N** 张表（PRD §4.3.1）。所以：
 *
 * | 用途 | 字段名 | 语义 |
 * |---|---|---|
 * | **读**（响应） | `table_ids: string[]` | 按 `order_index` 升序。**空数组是合法状态** |
 * | **建/改**（请求） | `tables: string[]` | 有序，顺序即合并池的 `order_index` |
 *
 * 历史包袱：曾经有过单值 `table_id`。它已被彻底删除——留着它会让
 * `if (!scene.table_id) 阻断发布` 这类判断**恒为真**（字段恒 `undefined`），
 * 表现是「任何场景都发布不了」，而所有测试夹具都还写着 `table_id` 所以测试全绿。
 * 这是本项目踩过的最贵的一个静默故障，不要把 `table_id` 加回来。
 */
export type SceneRead = {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  icon: string;
  status: SceneStatus;
  // ---- v3 模块实例身份 ----
  /** 四选一。决定走 `channels` 的哪个处理通道。 */
  scene_type: SceneType;
  /** 前端渲染目录名。**空串 = 老场景没写 module，前端按纯文本降级**。 */
  module_key: string;
  module_version: number;
  /**
   * `{schema_version, params, fallback_text}`。**不含 module_key 冗余**（决策 2）：
   * module 身份只由 `module_key` + `module_version` 两个字段表达，
   * 在 ui_config 里再抄一份会出现「改了 ui_config 线上渲染没变」。
   */
  ui_config: {
    schema_version?: number;
    /** module 私有参数（来自 module 的 `params_schema`） */
    params?: Record<string, unknown>;
    /** 渲染不出来时的纯文本兜底（非 UI 渠道只吃文本） */
    fallback_text?: string;
  };
  /** 模块私有参数，框架只透传不解释。 */
  module_config: Record<string, unknown>;
  // ---- 数据表 ----
  /** 归属于本场景的表 id，按 `order_index` 升序。空数组合法。 */
  table_ids: string[];
  // ---- 既有配置 ----
  trigger: Partial<SceneTrigger>;
  slots: SceneSlot[];
  match_action: Partial<SceneMatchAction>;
  respond_action: SceneRespondAction;
  shortcut: SceneShortcut;
  /** sop_flow 的步骤配置。 */
  flow: Record<string, unknown>;
  /** handoff 的参数。 */
  handoff: Record<string, unknown>;
  /** script 的话术表。 */
  scripts: Array<Record<string, unknown>>;
  /** 这个场景挂在哪些员工上（由后端反查 AgentResourceBinding 得出） */
  agent_ids: string[];
  /**
   * 定义器侧提示（表数量档位不满足等）。**只提示不放行**——
   * 真正的阻断在 create/update 里已经 400 了，这里给前端做角标文案。
   * 不要把 `warnings` 渲染成阻断样式，那正好会把「不该阻断的」变成阻断。
   */
  warnings: string[];
  created_at: string;
  updated_at: string;
};

export type SceneHit = {
  row_id: string;
  values: Record<string, unknown>;
  score: number;
  days_dev: number;
  budget_dev: number;
  fused: number | null;
};

export type SceneStep = {
  key: string;
  label: string;
  detail: string;
  from: number;
  to: number;
  dropText: string;
  ratio: number;
};

export type SceneRunResult = {
  scene_id: string;
  hits: SceneHit[];
  ranked: SceneHit[];
  steps: SceneStep[];
  total: number;
  normalized_count: number;
  unconvertible: number;
  gate_out: number;
  reranked: boolean;
  model_used: boolean;
  invalid_budget: boolean;
  /** 空结果时的一句话解释（已量化差距，不是「没找到」） */
  empty_reason: string;
  run_id: string;
};

/**
 * 新建场景。对应后端 `SceneCreateRequest`（`schema.py:111`）。
 *
 * `tables` 是**有序**表 id 列表——顺序即合并池的 `order_index`，
 * **不能换成 set**。允许为空：`table_match` 是 `optional` 档，
 * 「先建场景、绑员工、后补表」是管理员最自然的操作顺序（PRD §10.3 第 11 条）。
 */
export type SceneCreateInput = {
  name: string;
  description?: string;
  icon?: string;
  /** 四选一，决定走 `channels` 的哪个处理通道。缺省 `table_match`。 */
  scene_type?: SceneType;
  /** 前端渲染目录名。留空则后端按 `scene_type` 预填 `generic.*`。 */
  module_key?: string;
  /** 0..N 张私有数据表（**有序**）。空数组合法。 */
  tables?: string[];
  status?: SceneStatus;
  agent_id?: string | null;
  trigger?: Partial<SceneTrigger>;
  slots?: SceneSlot[];
  match_action?: Partial<SceneMatchAction>;
  respond_action?: SceneRespondAction;
  shortcut?: SceneShortcut;
  ui_config?: SceneRead['ui_config'];
  module_config?: Record<string, unknown>;
  /** sop_flow 的步骤配置。类型切换时旧类型的配置必须保留，所以各占一个字段。 */
  flow?: Record<string, unknown>;
  /** handoff 的参数。 */
  handoff?: Record<string, unknown>;
  /** script 的话术表。 */
  scripts?: Array<Record<string, unknown>>;
};

/**
 * 改场景。所有字段不传 = 不改。
 *
 * ⚠️ `tables` 是**「传了才动」**：不传（`undefined`）= 不改表归属，
 * 传 `[]` = **清空全部表**。这两个语义不同，不要为了「保险」一律传 `[]`——
 * 那会把管理员已有的表悄悄清掉。清空是有意义的操作（切到 `script` 后不再用表），
 * 所以不禁止，但要由调用方明确表达意图。
 */
export type SceneUpdateInput = Partial<Omit<SceneCreateInput, 'agent_id'>>;

// ============================================================
// 接口
// ============================================================

export function listScenes(params: { agent_id?: string; status?: string } = {}): Promise<SceneRead[]> {
  const query = new URLSearchParams({ tenant_id: TENANT_ID });
  if (params.agent_id) query.set('agent_id', params.agent_id);
  if (params.status) query.set('status', params.status);
  return api.get<SceneRead[]>(`/api/enterprise/scenes?${query.toString()}`);
}

/** 员工档案页「场景」tab 的数据源。 */
export function listScenesForAgent(agentId: string): Promise<SceneRead[]> {
  return api.get<SceneRead[]>(
    `/api/enterprise/scenes/by-agent/${encodeURIComponent(agentId)}?tenant_id=${encodeURIComponent(TENANT_ID)}`,
  );
}

export function getScene(id: string): Promise<SceneRead> {
  return api.get<SceneRead>(
    `/api/enterprise/scenes/${encodeURIComponent(id)}?tenant_id=${encodeURIComponent(TENANT_ID)}`,
  );
}

export function createScene(input: SceneCreateInput): Promise<SceneRead> {
  return api.post<SceneRead>('/api/enterprise/scenes', { tenant_id: TENANT_ID, ...input });
}

export function updateScene(id: string, input: SceneUpdateInput): Promise<SceneRead> {
  return api.put<SceneRead>(`/api/enterprise/scenes/${encodeURIComponent(id)}`, {
    tenant_id: TENANT_ID,
    ...input,
  });
}

export function deleteScene(id: string): Promise<{ deleted: boolean; id: string }> {
  return api.delete<{ deleted: boolean; id: string }>(
    `/api/enterprise/scenes/${encodeURIComponent(id)}?tenant_id=${encodeURIComponent(TENANT_ID)}`,
  );
}

/** 整体覆盖「这个场景挂在哪几个员工上」。 */
export function setSceneAgents(id: string, agentIds: string[]): Promise<SceneRead> {
  return api.put<SceneRead>(`/api/enterprise/scenes/${encodeURIComponent(id)}/agents`, {
    tenant_id: TENANT_ID,
    agent_ids: agentIds,
  });
}

export function runScene(
  id: string,
  slots: Record<string, unknown>,
  opts: { use_decision_model?: boolean; persist?: boolean } = {},
): Promise<SceneRunResult> {
  return api.post<SceneRunResult>(`/api/enterprise/scenes/${encodeURIComponent(id)}/run`, {
    tenant_id: TENANT_ID,
    slots,
    ...opts,
  });
}

// ============================================================
// 数据表
// ============================================================

export function listSceneTables(): Promise<SceneTableRead[]> {
  return api.get<SceneTableRead[]>(
    `/api/enterprise/scenes/tables?tenant_id=${encodeURIComponent(TENANT_ID)}`,
  );
}

export function getSceneTable(id: string, limit = 50): Promise<SceneTablePreview> {
  return api.get<SceneTablePreview>(
    `/api/enterprise/scenes/tables/${encodeURIComponent(id)}?tenant_id=${encodeURIComponent(
      TENANT_ID,
    )}&limit=${limit}`,
  );
}

/**
 * 上传 xlsx/csv 建表。
 *
 * 解析与入库在一次调用里完成，响应里带 quality —— 用户能在同一个弹窗里
 * 看到「这列有 12 行解析不了」，再决定是改表还是继续。
 */
export function importSceneTable(file: File, name = ''): Promise<SceneTablePreview> {
  const query = new URLSearchParams({ tenant_id: TENANT_ID });
  if (name) query.set('name', name);
  return api.uploadWithProgress<SceneTablePreview>(
    '/api/enterprise/scenes/tables/import',
    file,
    query.toString(),
  );
}

// ============================================================
// 默认值（与后端 DEFAULT_TRIGGER / DEFAULT_MATCH_ACTION 保持一致）
// ============================================================

export const DEFAULT_TRIGGER: SceneTrigger = {
  shortcut: true,
  shortcut_label: '',
  examples: [],
  keywords: [],
  require_slots: true,
  bypass_llm_router: true,
};

export const DEFAULT_MATCH_ACTION: SceneMatchAction = {
  days_weight: 1.5,
  budget_weight: 1.0,
  days_tolerance: 1,
  max_score: 2.0,
  top_k: 3,
  rule_weight: 0.5,
  use_decision_model: false,
  on_empty: 'nearest',
};

/**
 * 表里的三个「语义槽位」。
 *
 * 不叫「固定槽位」而叫语义槽位，是因为它们对应 matcher 的三个分层：
 * 人数=硬约束、天数=±容差、预算=相对偏差排序。换名字会让匹配层拿不到值，
 * 所以定义器里这三个 key 不允许改（只允许改它指向哪一列）。
 */
export const SEMANTIC_SLOTS: { key: string; label: string; unit: string; hint: string }[] = [
  { key: 'people', label: '人数', unit: '人', hint: '硬约束：填 4 只出 4 人的行' },
  { key: 'days', label: '天数', unit: '天', hint: '上下浮动 1 天仍算命中' },
  { key: 'budget', label: '预算', unit: '元', hint: '按相对偏差排序，越接近越靠前' },
];