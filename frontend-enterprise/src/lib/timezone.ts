import { getDateLocale } from '@/i18n';

const FALLBACK_TIME_ZONE = 'Asia/Shanghai';

export function getClientTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

export function parseBackendDateTime(value?: string): Date {
  const text = String(value || '').trim();
  if (!text) return new Date('');
  // 纯日期字符串本就被当作 UTC 解析，无需补时区后缀
  if (!text.includes('T')) return new Date(text);
  // 后端时间戳为 naive UTC（无 Z 后缀），缺失时按 UTC 解析而非本地时间
  if (/([zZ]|[+-]\d{2}:\d{2})$/.test(text)) return new Date(text);
  return new Date(`${text}Z`);
}

export function formatClientDateTime(value?: string, emptyText = '-'): string {
  if (!value) return emptyText;
  const date = parseBackendDateTime(value);
  if (Number.isNaN(date.getTime())) return emptyText;
  return date.toLocaleString(getDateLocale(), {
    hour12: false,
    timeZone: getClientTimeZone(),
  });
}

/**
 * 紧凑的「月/日 时:分」（如 `10/19 16:34`），给分享有效期这类窄位置用。
 *
 * 必须走 `parseBackendDateTime`：后端是 naive UTC，`new Date('...T08:34:00')`
 * 会按本地时间解析，东八区下整体早 8 小时，把「今天 16:34 到期」显示成 08:34。
 */
export function formatClientMonthDayTime(value?: string, emptyText = '-'): string {
  if (!value) return emptyText;
  const date = parseBackendDateTime(value);
  if (Number.isNaN(date.getTime())) return emptyText;
  return new Intl.DateTimeFormat(getDateLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: getClientTimeZone(),
  }).format(date);
}

/**
 * 「年/月/日 时:分」（如 `2026/10/19 16:34`），给密钥创建时间、最后使用时间这类列表行用。
 *
 * 同样必须走 `parseBackendDateTime`：后端是 naive UTC，裸 `new Date` 在东八区会早 8 小时。
 */
export function formatClientYearMonthDayTime(
  value?: string | null,
  emptyText = '-',
): string {
  if (!value) return emptyText;
  const date = parseBackendDateTime(value);
  if (Number.isNaN(date.getTime())) return emptyText;
  return new Intl.DateTimeFormat(getDateLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: getClientTimeZone(),
  }).format(date);
}

/**
=======
 * 把 `Date` 转成客户端时区的 `YYYY-MM-DD`。
 *
 * 给 `<input type="date">` 的 value、日期列这类必须固定格式的位置用。「今天」请写
 * `toClientDateISO(new Date())`，不要用 `new Date().toISOString().slice(0, 10)` ——
 * 那是 UTC 日期，东八区早上 8 点前会算成昨天。
 */
export function toClientDateISO(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 后端时间戳 → 客户端时区的 `YYYY-MM-DD`。
 *
 * 纯日期串（`YYYY-MM-DD`）没有时刻信息，原样返回，避免被时区推到前一天。
 */
export function formatClientDateISO(value?: string | null, emptyText = '-'): string {
  const text = String(value ?? '').trim();
  if (!text) return emptyText;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = parseBackendDateTime(text);
  if (Number.isNaN(date.getTime())) return emptyText;
  return toClientDateISO(date);
}

/*
 * 只取日期部分（`YYYY/M/D`）的本地化格式化。
 *
 * 替代各处 `value.slice(0, 10)` 的写法：后端存的是 naive UTC，直接截字符串会把
 * 「本地凌晨」的时间戳显示成前一天（如本地 09-23 02:00 = UTC 09-22 18:00）。
 * 纯日期串（不含 `T`）本身没有时刻信息，按 UTC 输出以免被时区推前一天。
 */
export function formatClientDate(value?: string, emptyText = '-'): string {
  if (!value) return emptyText;
  const text = String(value).trim();
  const date = parseBackendDateTime(text);
  if (Number.isNaN(date.getTime())) return emptyText;
  return date.toLocaleDateString(getDateLocale(), {
    timeZone: text.includes('T') ? getClientTimeZone() : 'UTC',
  });
}

/**
 * 只要「时:分」（24 小时制）的紧凑格式化，给消息气泡、右栏这类窄位置用。
 *
 * 必须走 `parseBackendDateTime`：后端 `utc_now()` 写的是 naive UTC（无 Z 后缀），
 * 裸 `new Date('2026-11-18T01:01:00')` 会按本地时间解析，东八区下整条消息
 * 的时间戳都早 8 小时（线上：09:01 的回复显示成 01:01）。
 *
 * 解析不了返回空串：历史脏数据不该在气泡上占一个「--:--」。
 */
export function formatClientClock(value?: string | null): string {
  if (!value) return '';
  const date = parseBackendDateTime(String(value));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(getDateLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: getClientTimeZone(),
  });
}

/**
 * 「11月18日 09:01」这样的日期 + 时刻，给右栏、列表行这类需要日期上下文的位置。
 *
 * 与 `formatClientClock` 同源，同样必须走 `parseBackendDateTime`。
 */
export function formatClientMonthDayClock(value?: string | null, emptyText = ''): string {
  if (!value) return emptyText;
  const date = parseBackendDateTime(String(value));
  if (Number.isNaN(date.getTime())) return emptyText;
  // 拆成 parts 再自己拼「11月18日 09:01」：直接让 Intl 输出中文格式在不同
  // 浏览器/ICU 版本下会漂成「11/18」（实测 zh-CN + month:numeric）。
  const parts = new Intl.DateTimeFormat('en-CA', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: getClientTimeZone(),
  }).formatToParts(date);
  const at = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || '';
  const month = at('month').replace(/^0/, '');
  const day = at('day').replace(/^0/, '');
  const hour = at('hour').padStart(2, '0');
  const minute = at('minute').padStart(2, '0');
  return `${month}月${day}日 ${hour}:${minute}`;
}
