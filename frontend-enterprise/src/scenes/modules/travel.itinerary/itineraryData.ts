import type { SceneUiBlock } from '../../types';
import {
  COLUMN_CANDIDATES,
  TITLE_COLUMN_CANDIDATES,
  TRAVEL_ITINERARY_PARAM_DEFAULTS,
} from './params';

/**
 * `travel.itinerary` 的数据读取层（纯函数，无 React）。
 *
 * 单独抽出来的理由：这些函数里全是「看起来对、实际会错」的判断 ——
 * 「score 缺失时算不算完全吻合」「日程列是 JSON 还是竖线分隔」「价格要不要千分位」。
 * 混在 JSX 里就只能靠点界面验证。
 *
 * 硬约束（arch §2.2）：module **只读不造** `data`，不产任何 UI 描述字段。
 */

/** 后端 `kind=result` 的 `data` 形状（arch §2.2，冻结级别：result 冻结）。 */
export type ItineraryHit = {
  row_id: string;
  values: Record<string, unknown>;
  score: number;
  source_table: string;
};

const EMPTY_HIT: ItineraryHit = { row_id: '', values: {}, score: 0, source_table: '' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 从 block 里取出命中行数组。形状不对时返回空数组，不抛错（metadata 必须容错）。 */
export function itineraryHits(block: SceneUiBlock): ItineraryHit[] {
  const items = block.data?.items;
  if (!Array.isArray(items)) return [];
  const hits: ItineraryHit[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const values = isRecord(raw.values) ? raw.values : {};
    const score = typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : 0;
    const sourceTable = typeof raw.source_table === 'string'
      ? raw.source_table
      : (typeof raw.sourceTable === 'string' ? raw.sourceTable : '');
    hits.push({
      row_id: typeof raw.row_id === 'string' ? raw.row_id : '',
      values,
      score,
      source_table: sourceTable,
    });
  }
  return hits;
}

/** 第一条命中（这个 module 一屏只画一条；多条由上层追问引导）。 */
export function primaryHit(block: SceneUiBlock): ItineraryHit {
  return itineraryHits(block)[0] ?? EMPTY_HIT;
}

function paramString(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * 取某语义列的值。
 *
 * 顺序：管理员显式配的列 → 表头同名候选 → 空。**不猜别的**：猜错列比空着更糟，
 * 空着用户还能看出「这里该有值」，取错列则会显示一个看起来合理但错误的数据。
 */
export function columnValue(
  hit: ItineraryHit,
  params: Record<string, unknown>,
  paramKey: string,
  candidates: string[],
): { key: string; value: unknown } {
  const configured = typeof params[paramKey] === 'string' ? String(params[paramKey]).trim() : '';
  if (configured && configured in hit.values) {
    return { key: configured, value: hit.values[configured] };
  }
  for (const candidate of candidates) {
    if (candidate in hit.values) return { key: candidate, value: hit.values[candidate] };
  }
  return { key: '', value: undefined };
}

/** 数字列转数值。`"3000"` / `"3,000"` / `"3000元"` 都要认（脏表是常态）。 */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[,，\s]/g, '').replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value.trim();
  return '';
}

export type ItineraryHeader = {
  title: string;
  destination: string;
  days: number | null;
  /** 天 4 晚 = 天数 - 1（contract §1.2 的副标题格式）。 */
  nights: number | null;
  sourceTable: string;
};

/** 卡头：标题 / 目的地 / 天数 / 来源表。 */
export function itineraryHeader(
  hit: ItineraryHit,
  params: Record<string, unknown>,
): ItineraryHeader {
  const titleOverride = paramString(params, 'card_title_template', '');
  const titleFromColumn = columnValue(hit, params, 'title_column', TITLE_COLUMN_CANDIDATES);
  const title = titleOverride || displayValue(titleFromColumn.value);
  const destination = displayValue(
    columnValue(hit, params, 'destination_column', COLUMN_CANDIDATES.destination).value,
  );
  const days = toNumber(columnValue(hit, params, 'days_column', COLUMN_CANDIDATES.days).value);
  return {
    title,
    destination,
    days,
    nights: days !== null && days > 1 ? days - 1 : null,
    sourceTable: hit.source_table,
  };
}

/**
 * 副标题：`{目的地} · {N} 天 {N-1} 晚 · 来自「{来源表名}」`（contract §1.2）。
 *
 * 缺项就整段跳过而不是留一个空 ` · `；`show_source_table=false` 时省掉最后一段
 * （多表时必须显示 —— 那是多表能力的可见证据，但租户可以选择藏起来）。
 */
export function subtitleText(header: ItineraryHeader, params: Record<string, unknown>): string {
  const segments: string[] = [];
  if (header.destination) segments.push(header.destination);
  if (header.days !== null && header.days > 0) {
    segments.push(header.nights !== null ? `${header.days} 天 ${header.nights} 晚` : `${header.days} 天`);
  }
  const showSource = params.show_source_table === undefined
    ? TRAVEL_ITINERARY_PARAM_DEFAULTS.show_source_table
    : Boolean(params.show_source_table);
  if (showSource && header.sourceTable) segments.push(`来自「${header.sourceTable}」`);
  return segments.join(' · ');
}

export type ItineraryMeta = { people: string; days: string; budget: string; match: MatchLabel };

export type MatchLabel = {
  text: string;
  /** `success` → `#138a55`；`warning` → `#b45309`（contract §1.3）。 */
  tone: 'success' | 'warning';
};

/**
 * 「匹配度」按 `score` 动态算（contract §1.3，**不许写死**）：
 * - `score === 0` → 完全吻合（绿）
 * - `0 < score <= 0.3` → 接近（绿）
 * - `score > 0.3` → 有偏差（橙）
 *
 * score 缺失时按 0 处理：后端 `result.items[].score` 是冻结字段，缺失只能是脏数据，
 * 显示「完全吻合」比显示「有偏差」风险更低（后者会让用户误以为要自己再筛一遍）。
 */
export function matchLabel(score: number): MatchLabel {
  if (!Number.isFinite(score) || score <= 0) return { text: '完全吻合', tone: 'success' };
  if (score <= 0.3) return { text: '接近', tone: 'success' };
  return { text: '有偏差', tone: 'warning' };
}

function withUnit(value: unknown, unit: string): string {
  const number = toNumber(value);
  if (number !== null) return `${number} ${unit}`;
  const text = displayValue(value);
  return text ? `${text} ${unit}` : '';
}

/** 元信息条：人数 / 天数 / 预算 / 匹配度。 */
export function itineraryMeta(
  hit: ItineraryHit,
  params: Record<string, unknown>,
): ItineraryMeta {
  return {
    people: withUnit(columnValue(hit, params, 'people_column', COLUMN_CANDIDATES.people).value, '人'),
    days: withUnit(columnValue(hit, params, 'days_column', COLUMN_CANDIDATES.days).value, '天'),
    budget: withUnit(columnValue(hit, params, 'budget_column', COLUMN_CANDIDATES.budget).value, '元'),
    match: matchLabel(hit.score),
  };
}

export type ItineraryDay = {
  /** `D1` / `D2` … */
  indexLabel: string;
  /** 徽标下那行小字（活动类型：抵达/初级/进阶/自由/返程）。P0 无日程列时为空串。 */
  phase: string;
  title: string;
  description: string;
  tags: string[];
};

const PHASE_PATTERN = /^(抵达|返程|初级|进阶|中级|自由|休息|出发|游玩|体验|抵达日|返程日)$/;

function splitTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => displayValue(item)).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw.split(/[,，、/]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function dayFromRecord(raw: Record<string, unknown>, index: number): ItineraryDay {
  const phaseRaw = displayValue(raw.phase ?? raw.type ?? raw.activity_type ?? raw['类型']);
  return {
    indexLabel: `D${index + 1}`,
    phase: PHASE_PATTERN.test(phaseRaw) ? phaseRaw : '',
    title: displayValue(raw.title ?? raw['标题'] ?? raw.name ?? raw['名称']),
    description: displayValue(raw.description ?? raw.desc ?? raw['描述'] ?? raw['说明']),
    tags: splitTags(raw.tags ?? raw['标签']),
  };
}

/**
 * 解析日程列（`params.schedule_column` 指定的那一列）。
 *
 * 支持两种常见形态（都是管理员真的会从 excel 里拷出来的样子）：
 * 1. **JSON 数组**：`[{"title":"抵达亚布力","description":"…","tags":["含接站"]}, …]`
 * 2. **竖线分隔的每行一天**：`抵达亚布力|哈尔滨接站…|含接站,含晚餐` 换行重复
 *
 * 解析不出来就返回空数组 —— **空数组时仍然画出 N 个空日程行**（见 `itineraryDays`），
 * 因为「徽标尺寸不变」是 contract §1.4 的硬要求：尺寸一变整条竖线就歪。
 */
export function parseSchedule(raw: unknown): ItineraryDay[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item, index) => dayFromRecord(item, index));
  }
  if (typeof raw !== 'string') return [];
  const text = raw.trim();
  if (!text) return [];

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parseSchedule(parsed);
    } catch {
      // 落到竖线解析：JSON 写坏了不该让整张卡消失
    }
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  return lines.map((line, index) => {
    const [title = '', description = '', rawTags = '', rawPhase = ''] = line.split('|');
    const phase = rawPhase.trim() || (PHASE_PATTERN.test(title.trim().slice(0, 2)) ? title.trim().slice(0, 2) : '');
    return {
      indexLabel: `D${index + 1}`,
      phase: PHASE_PATTERN.test(phase) ? phase : '',
      title: title.trim(),
      description: description.trim(),
      tags: splitTags(rawTags),
    };
  });
}

/**
 * 画出逐日时间轴。
 *
 * **天数优先取「天数」列，日程数组只提供内容**：这样「列说 5 天、日程只写了 3 天」
 * 时仍然画 5 行（后两行内容为空），而不是画 3 行 —— 用户看到「5 天 4 晚」却只有
 * 3 个徽标会以为模块坏了。
 *
 * 天数、日程都没有时返回空数组（整段不渲染，卡片退化成「卡头 + 元信息 + 价格」）。
 */
export function itineraryDays(
  hit: ItineraryHit,
  params: Record<string, unknown>,
): ItineraryDay[] {
  const schedule = parseSchedule(
    columnValue(hit, params, 'schedule_column', COLUMN_CANDIDATES.schedule).value,
  );
  const days = toNumber(columnValue(hit, params, 'days_column', COLUMN_CANDIDATES.days).value);
  const total = Math.max(days ?? 0, schedule.length);
  if (total <= 0) return [];
  const out: ItineraryDay[] = [];
  for (let index = 0; index < total; index += 1) {
    const day = schedule[index];
    out.push(day ?? {
      indexLabel: `D${index + 1}`,
      // 没有日程字段时这一行**留空但徽标尺寸不变**（contract §1.4）。
      phase: '',
      title: '',
      description: '',
      tags: [],
    });
  }
  return out;
}

/** 价格：`¥3,000`（千分位走 `toLocaleString('zh-CN')`，**不是 `¥3000`**）。 */
export function priceText(hit: ItineraryHit, params: Record<string, unknown>): string {
  const { value } = columnValue(hit, params, 'price_column', COLUMN_CANDIDATES.budget);
  const amount = toNumber(value);
  if (amount === null) return '';
  return `¥${amount.toLocaleString('zh-CN')}`;
}

/** 价格说明（`params.price_note`，租户可改）。 */
export function priceNote(params: Record<string, unknown>): string {
  return paramString(params, 'price_note', TRAVEL_ITINERARY_PARAM_DEFAULTS.price_note);
}

export function actionLabels(params: Record<string, unknown>): { primary: string; secondary: string } {
  return {
    primary: paramString(params, 'primary_action_label', TRAVEL_ITINERARY_PARAM_DEFAULTS.primary_action_label),
    secondary: paramString(
      params,
      'secondary_action_label',
      TRAVEL_ITINERARY_PARAM_DEFAULTS.secondary_action_label,
    ),
  };
}

/**
 * 「选这个」发出去的那句话。
 *
 * 铁律（PRD §5.3）：**调 `sendText('就选经典雪山五日')` 走新一轮，不许直接改状态**。
 * 只有这样才能保证所有交互在会话日志里可回放、可审计。
 */
export function selectText(title: string): string {
  const name = title.trim();
  return name ? `就选${name}` : '就选这个';
}

/** 「看详情」发出去的那句话（P0 不发请求做弹窗，同样走一轮对话）。 */
export function detailText(title: string): string {
  const name = title.trim();
  return name ? `看看${name}的详情` : '看看这个的详情';
}