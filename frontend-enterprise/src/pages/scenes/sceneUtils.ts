import type { SceneQualityIssue, SceneRead, SceneRunResult, SceneSlot, SceneStatus } from '@/api/scenes';
import type { NeedsTable } from '@/scenes/types';
import { tableCountIssues } from '@/scenes/types';

/**
 * 场景页面的纯逻辑层。
 *
 * 单独抽出来是为了能测：这些函数里全是「看起来对、实际会错」的判断，
 * 比如「槽位没映射到列」到底算不算问题、「空结果」到底该怎么解释。
 * 混在 JSX 里就只能靠点界面验证，改一次配置要重跑一遍手工回归。
 */

export const STATUS_META: Record<SceneStatus, { label: string; tone: 'green' | 'orange' | 'gray' }> = {
  published: { label: '已发布', tone: 'green' },
  draft: { label: '草稿', tone: 'orange' },
  archived: { label: '已归档', tone: 'gray' },
};

export function statusMeta(status: string) {
  return STATUS_META[status as SceneStatus] ?? { label: status || '未知', tone: 'gray' as const };
}

export type SlotMappingIssue = {
  key: string;
  level: 'error' | 'warning';
  message: string;
};

/**
 * 检查槽位与表列的映射关系。
 *
 * 三种情况必须区分开：
 * 1. 槽位指向了一个**表里不存在**的列 → error。保存下去的结果是「永远匹配不到」，
 *    而界面上看不出任何异常（用户以为配好了）。
 * 2. 三个语义槽位**缺了某个** → warning 而不是 error。方案允许只按部分维度筛
 *    （比如只按人数推荐），但缺了预算就没法排序，得让用户知道损失了什么。
 * 3. 多个槽位指向**同一列** → error。人数和天数都指向「人数」列时，
 *    匹配会拿同一个值当两个维度用，结果荒谬但不会报错。
 */
export function checkSlotMappings(
  slots: SceneSlot[],
  columnKeys: string[],
  semanticKeys: string[],
): SlotMappingIssue[] {
  const issues: SlotMappingIssue[] = [];
  const known = new Set(columnKeys);
  const used = new Map<string, string[]>();

  for (const slot of slots) {
    const target = (slot.target || slot.key || '').trim();
    if (!target) {
      issues.push({ key: slot.key, level: 'error', message: '槽位没有指向任何列' });
      continue;
    }
    if (columnKeys.length > 0 && !known.has(target)) {
      issues.push({
        key: slot.key,
        level: 'error',
        message: `表里没有「${target}」这一列，这个槽位永远不会命中`,
      });
    }
    const bucket = used.get(target) ?? [];
    bucket.push(slot.key);
    used.set(target, bucket);
  }

  for (const [target, keys] of used) {
    if (keys.length > 1) {
      issues.push({
        key: keys.join(','),
        level: 'error',
        message: `「${target}」这一列被多个槽位共用（${keys.join('、')}），匹配会拿同一个值当多个维度用`,
      });
    }
  }

  for (const semantic of semanticKeys) {
    if (!slots.some((slot) => slot.key === semantic)) {
      issues.push({
        key: semantic,
        level: 'warning',
        message: semantic === 'budget' ? '没配预算槽位，结果只能按天数排序' : `没配「${semantic}」槽位`,
      });
    }
  }
  return issues;
}

/** 导入质量里 level=error 的必须拦住，warning 允许继续但要显示。 */
export function splitQuality(quality: SceneQualityIssue[]): {
  blocking: SceneQualityIssue[];
  warnings: SceneQualityIssue[];
} {
  return {
    blocking: quality.filter((item) => item.level === 'error'),
    warnings: quality.filter((item) => item.level !== 'error'),
  };
}

export function qualityLevelText(level: SceneQualityIssue['level']): string {
  return level === 'error' ? '必须修复' : level === 'warning' ? '建议检查' : '提示';
}

/**
 * 判断一个场景是否「配得完整、可以发布」。
 *
 * 这里刻意不把「没绑员工」算作问题：场景可以先建好，之后在员工档案里挂。
 * 但「没配槽位」和「没配回答方式」发布出去就是这个场景永远答不出东西。
 *
 * ## 表数量为什么不在这里判
 *
 * 表数量阻断**必须**走
 * `tableCountIssues(scene_type, table_ids.length, moduleNeeds)`，
 * 因为档位是「类型档位」与「module 档位」取更严的那个（PRD §4.3.1 三档）：
 *
 * | scene_type | needs_table | 0 张表时 |
 * |---|---|---|
 * | `table_match` | `optional` | **不阻断**（只 warning） |
 * | `sop_flow` / `handoff` / `script` | `none` | **不阻断** |
 *
 * 曾经这里写的是 `if (!scene.table_id) blockers.push('还没选数据表')`。
 * 后果：`table_id` 字段在 v3 已被删除、恒 `undefined`，于是**任何场景都发布不了**，
 * 连 `script` 这种本来就不该要表的类型也被卡住。所以现在把表数量判断
 * 完全交给 `tableCountIssues()`，本函数只负责非表类阻断。
 *
 * ## `moduleNeeds` 为什么必须有
 *
 * 「0 张表能不能发布」在不同 module 下答案不同：`generic.table_match` 是
 * `optional`（0 张表只 warning），`travel.itinerary` 声明了 `required`
 * （没表画不出空态，必须阻断）。类型层四档里没有 `required`，它只能来自
 * module —— 所以这个参数漏传，`required` 那条路就永远走不到。
 *
 * 传 `undefined` = 按类型档位判（最宽松，P0 默认）。调用点手里有 module meta 时
 * 请传 `effectiveNeedsTable(scene.scene_type, meta.needs_table)`。
 */
export function publishBlockers(
  scene: Pick<SceneRead, 'table_ids' | 'scene_type' | 'slots' | 'respond_action'>,
  columnKeys: string[],
  moduleNeeds?: NeedsTable,
): string[] {
  const blockers: string[] = [];
  // 阻断只来自 tableCountIssues；warning（比如 table_match 缺表建议补）
  // 由调用方另行渲染，**不要**在这里 push 进去。
  blockers.push(
    ...tableCountIssues(scene.scene_type, (scene.table_ids ?? []).length, moduleNeeds),
  );
  if (!scene.slots || scene.slots.length === 0) blockers.push('还没配置要问用户的字段（槽位）');
  const issues = checkSlotMappings(scene.slots ?? [], columnKeys, []);
  if (issues.some((issue) => issue.level === 'error')) {
    blockers.push('有槽位指向了表里不存在的列');
  }
  const respond = scene.respond_action ?? {};
  if (respond.mode === 'template' && !(respond.template || '').trim()) {
    blockers.push('回答模板是空的');
  }
  return blockers;
}

/**
 * 把「试跑没结果」翻译成一句可操作的话。
 *
 * 后端已经给了 ``empty_reason``（量化到哪一层），这里只做兜底与补全：
 * 后端没给原因时不能显示「暂无结果」——那是把问题丢回给用户。
 */
export function explainRunResult(result: SceneRunResult | null): string {
  if (!result) return '';
  if (result.hits.length > 0) return '';
  if (result.empty_reason) return result.empty_reason;
  if (result.total === 0) return '这张表里没有数据行，先去导入数据。';
  return '按这组条件没有能对上的行，可以放宽预算或减少人数再试。';
}

/**
 * 试跑的漏斗步骤要不要显示。
 *
 * from 和 to 都等于 total 的步骤是「没筛掉任何东西」，显示出来会让漏斗看起来
 * 很吵（5 行 → 5 行 → 5 行）。但第一步必须留，否则用户看不到总行数。
 */
export function visibleSteps(steps: SceneRunResult['steps']): SceneRunResult['steps'] {
  return steps.filter((step, index) => index === 0 || step.to !== step.from);
}

/** 命中率展示：0 行时不能显示 0%，那读起来像「一条都没匹配上」而不是「本来就没数据」。 */
export function hitRatioText(hitCount: number, total: number): string {
  if (total <= 0) return '—';
  return `${Math.round((hitCount / total) * 100)}%`;
}

/**
 * 模板占位符替换。试跑面板要能预览「命中后会怎么答」，否则模板写错只能等线上。
 *
 * 只用 ``{{列名}}`` 一种语法：不用 ``{列名}`` 是因为正文里出现 JSON 片段时
 * 单花括号太容易误伤，用户会看到 ``{`` 被吃掉。
 */
export function renderTemplate(template: string, values: Record<string, unknown>): string {
  if (!template) return '';
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawKey: string) => {
    const key = rawKey.trim();
    if (!(key in values)) return match;
    const value = values[key];
    return value === null || value === undefined ? '' : String(value);
  });
}

/** 模板里引用了但这一行没有的列 —— 提示用户占位符写错了，而不是静默留空。 */
export function unknownTemplateKeys(template: string, columnKeys: string[]): string[] {
  const known = new Set(columnKeys);
  const out = new Set<string>();
  for (const match of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const key = match[1].trim();
    if (key && !known.has(key)) out.add(key);
  }
  return [...out];
}

/** 表单输入 → 数值。空串返回 null（不是 0），避免把「没填」当成「填了 0」。 */
export function parseSlotInput(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** 员工绑定的展示文案。0 个员工 ≠ 加载中，两者不能长得一样。 */
export function bindingText(agentIds: string[], agentNames: Record<string, string>): string {
  if (agentIds.length === 0) return '未绑定员工';
  const names = agentIds.map((id) => agentNames[id] ?? id);
  if (names.length <= 2) return `已绑定 ${names.join('、')}`;
  return `已绑定 ${names[0]} 等 ${names.length} 个员工`;
}