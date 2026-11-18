/**
 * 「待回答」桌面通知。
 *
 * 为什么需要：待回答的红标只活在页面里。用户切去别的标签、或最小化窗口去开会时，
 * 红标再红也没人看见——而这恰恰是最该被提醒的时刻。这里用 Notification API 把
 * 提醒推到系统通知中心。
 *
 * 三条硬约束：
 *
 * 1. **权限只能由用户手势申请**。浏览器在非用户手势里调 `requestPermission()`
 *    会被静默拒绝（Chrome 直接返回 'denied' 且不再弹窗），所以申请入口放在
 *    「待回答」弹窗的按钮上，不在轮询里偷偷申请。
 * 2. **同一条只提醒一次**。轮询 15s 一轮，不做去重等于每 15 秒弹同一批通知，
 *    用户会去关权限。已提醒过的 handoff id 记在 localStorage 里。
 * 3. **不能因为提醒把功能搞崩**。Notification 在无痕模式、iframe、部分企业策略下
 *    会直接抛异常；整个模块对异常静默，绝不影响轮询与红标。
 */

const STORAGE_KEY = 'staffdeck.handoff.notified';

/** 记住已提醒过的 id，避免重复弹。上限截断防止无限增长。 */
const MAX_REMEMBERED = 500;

type Notifiable = {
  id: string;
  pending_question?: string | null;
  context_summary?: string | null;
  requester_display_name?: string | null;
  /** 五段式简报，比老字段更适合当通知正文。 */
  brief?: { ask?: string | null } | null;
};

export type HandoffNotificationSupport =
  | 'supported'
  | 'unsupported'
  | 'granted'
  | 'denied'
  | 'default';

export function handoffNotificationSupport(): HandoffNotificationSupport {
  if (typeof window === 'undefined') return 'unsupported';
  // 不看 `'Notification' in window`：某些环境（无痕、iframe、被企业策略禁用、
  // 测试里 stub 成 undefined）该键存在但值是 undefined，直接读 .permission 会崩。
  const api = window.Notification as typeof Notification | undefined;
  if (!api || typeof api.permission !== 'string') return 'unsupported';
  const permission = api.permission;
  if (permission === 'granted') return 'granted';
  if (permission === 'denied') return 'denied';
  return 'default';
}

/**
 * 申请通知权限。**必须由用户点击触发**，否则浏览器会静默拒绝。
 * 返回申请后的最终状态。
 */
export async function requestHandoffNotificationPermission(): Promise<HandoffNotificationSupport> {
  const current = handoffNotificationSupport();
  if (current === 'unsupported' || current !== 'default') return current;
  try {
    const result = await window.Notification.requestPermission();
    return result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'default';
  } catch {
    return 'default';
  }
}

function readNotified(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeNotified(ids: Set<string>): void {
  try {
    const list = Array.from(ids).slice(-MAX_REMEMBERED);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 隐私模式下 localStorage 可能直接抛异常：提醒失效可以接受，轮询不能受影响。
  }
}

/** 通知正文：优先五段式简报里的「问」，退回老字段。 */
function notificationBody(handoff: Notifiable): string {
  const ask = (handoff.brief?.ask || handoff.pending_question || handoff.context_summary || '').trim();
  if (!ask) return '有新的问题需要你来回答';
  // 通知泡显示空间很窄，长文本截断，完整内容点开看。
  return ask.length > 80 ? `${ask.slice(0, 80)}…` : ask;
}

/**
 * 为**新出现**的待回答弹桌面通知，返回本次实际弹出的条数。
 *
 * @param handoffs 当前轮询拿到的全部待回答
 * @param onOpen   点击通知时执行（通常是打开待回答弹窗或直接进会话）
 */
export function notifyNewHandoffs(
  handoffs: Notifiable[],
  onOpen?: (handoffId: string) => void,
): number {
  if (handoffNotificationSupport() !== 'granted') return 0;
  if (!Array.isArray(handoffs) || handoffs.length === 0) return 0;

  const notified = readNotified();
  const fresh = handoffs.filter((item) => item && item.id && !notified.has(item.id));
  if (fresh.length === 0) return 0;

  // 一次轮询可能冒出十几条（批量转人工），逐条弹会刷屏。
  // 只弹最新的三条，其余折成一条汇总，且汇总不占 id 去重额度。
  const detail = fresh.slice(0, 3);
  const restCount = fresh.length - detail.length;
  let shown = 0;

  for (const handoff of detail) {
    try {
      const requester = (handoff.requester_display_name || '').trim();
      const notification = new window.Notification(
        restCount > 0 && handoff === detail[0]
          ? `${fresh.length} 条新的待回答`
          : requester
            ? `${requester} 的问题待回答`
            : '有新的待回答',
        {
          body: notificationBody(handoff),
          tag: `staffdeck-handoff-${handoff.id}`,
        },
      );
      notification.onclick = () => {
        try {
          window.focus();
          onOpen?.(handoff.id);
          notification.close();
        } catch {
          // 忽略：点击回调失败不影响已弹出的通知。
        }
      };
      notified.add(handoff.id);
      shown += 1;
    } catch {
      // 单条失败（例如系统禁用通知）不该中断其余条目。
    }
  }

  // 超过 3 条的剩余部分也要记账，否则下一轮又会被当成新的重复弹。
  for (const handoff of fresh.slice(3)) {
    notified.add(handoff.id);
  }

  writeNotified(notified);
  return shown;
}

/** 测试与「全部已读」场景用：清空去重记忆。 */
export function resetHandoffNotificationMemory(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}