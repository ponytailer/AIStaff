/**
 * `result` 块的通用取值工具（`generic.table_match` 用；`travel.itinerary` 有自己的
 * 更严格的一套在 `modules/travel.itinerary/itineraryData.ts`）。
 *
 * 后端 `result` 块的形状（arch §2.2，已冻结）：
 * ```json
 * { "total": 5, "max_items": 3,
 *   "items": [{ "row_id": "...", "values": {...}, "score": 0,
 *               "days_dev": 0, "budget_dev": 0, "source_table": "滑雪价目.xlsx" }] }
 * ```
 *
 * **不许在这个文件里做任何「重算」**：`score` / `days_dev` / `budget_dev` 都是
 * matcher 算好的值，前端重新推一遍就会和试跑面板对不上（那是最伤信任的一类不一致）。
 * 这里只做「把值按列语义摆到该摆的位置」。
 */

/** 把任意值安全转成一行可显示的文本（`null` / 对象 / 数组都不抛）。 */
export function fieldText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map((item) => fieldText(item)).filter(Boolean).join('、');
  if (typeof value === 'object') return '';
  return String(value);
}

/** 标题列的候选列名（顺序即优先级）。中文表最常见的几种叫法。 */
export const TITLE_COLUMN_CANDIDATES = ['计划内容', '标题', '名称', '方案名称', '产品名称', '标题内容'];

/** 内部注入键前缀（`__row_id__` / `__source_table_name__`）—— 永远不当业务列渲染。 */
export function isInternalKey(key: string): boolean {
  return key.startsWith('__');
}

/** 命中行的业务列（已剥掉 `__` 内部键）。 */
export function rowValues(hit: Record<string, unknown>): Record<string, unknown> {
  const raw = hit?.values;
  if (!raw || typeof raw !== 'object') return {};
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isInternalKey(key)) continue;
    values[key] = value;
  }
  return values;
}

/** 标题：优先 module 参数指定的列，其次候选列名，最后第一个非空值。 */
export function rowTitle(values: Record<string, unknown>, configured?: string): string {
  const key = String(configured || '').trim();
  if (key) {
    const text = fieldText(values[key]);
    if (text) return text;
  }
  for (const candidate of TITLE_COLUMN_CANDIDATES) {
    const text = fieldText(values[candidate]);
    if (text) return text;
  }
  for (const [colKey, value] of Object.entries(values)) {
    const text = fieldText(value);
    if (text && text.length <= 40) return `${colKey}：${text}`;
  }
  return '（无标题）';
}

export type FieldPair = { key: string; text: string };

/**
 * 除标题外的 3~4 个字段，用于列表项的副信息。
 *
 * `limit` 上限刻意是 4：demo 的结果列表按 4 列宽度调过版，多一列会换行把
 * 「选这个」按钮挤下去（contract §0 纪律 3 说的「demo 排版按那 5 行长度调」）。
 */
export function rowFields(
  values: Record<string, unknown>,
  title: string,
  limit = 4,
): FieldPair[] {
  const out: FieldPair[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (out.length >= limit) break;
    const text = fieldText(value);
    if (!text) continue;
    // 与标题同一个值的列不再重复显示（中文表常有「计划内容」和「名称」两列同值）。
    if (text === title) continue;
    out.push({ key, text });
  }
  return out;
}

/** 命中行来自哪张表（多表能力的可见证据，contract §1.2）。 */
export function sourceTableOf(hit: Record<string, unknown>): string {
  const direct = fieldText(hit?.source_table);
  if (direct) return direct;
  const values = hit?.values;
  if (values && typeof values === 'object') {
    return fieldText((values as Record<string, unknown>).__source_table_name__);
  }
  return '';
}

export type ResultHit = { raw: Record<string, unknown>; title: string; fields: FieldPair[]; sourceTable: string; score: number | null };

/** 把 `result` 块的 `data.items` 转成可渲染的列表（坏数据逐项跳过，不整块失败）。 */
export function resultHits(
  data: Record<string, unknown>,
  configuredTitleColumn?: string,
): ResultHit[] {
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const out: ResultHit[] = [];
  for (const row of rawItems) {
    if (!row || typeof row !== 'object') continue;
    const hit = row as Record<string, unknown>;
    const values = rowValues(hit);
    const title = rowTitle(values, configuredTitleColumn);
    out.push({
      raw: hit,
      title,
      fields: rowFields(values, title),
      sourceTable: sourceTableOf(hit),
      score: typeof hit.score === 'number' && Number.isFinite(hit.score) ? hit.score : null,
    });
  }
  return out;
}

/** 结果条数：优先 `data.total`（后端给的总数），缺失才退到 `items.length`。 */
export function resultTotal(data: Record<string, unknown>): number {
  const total = Number(data.total);
  if (Number.isFinite(total) && total >= 0) return Math.trunc(total);
  return Array.isArray(data.items) ? data.items.length : 0;
}

/** 「选这个」/「看详情」发出去的话。铁律：交互一律走 sendText（PRD §5.3）。 */
export function selectText(title: string): string {
  return `就选${title}`;
}

export function detailText(title: string): string {
  return `看看${title}的详情`;
}