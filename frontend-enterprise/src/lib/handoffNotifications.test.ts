// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handoffNotificationSupport,
  notifyNewHandoffs,
  requestHandoffNotificationPermission,
  resetHandoffNotificationMemory,
} from './handoffNotifications';

type SpawnedNotification = {
  title: string;
  options?: NotificationOptions;
  onclick: (() => void) | null;
  close: () => void;
};

let spawned: SpawnedNotification[] = [];

/** 用可控的假 Notification 替换全局实现，同时保留 permission 与静态方法。 */
function installNotification(permission: NotificationPermission) {
  spawned = [];
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => permission);
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(title: string, options?: NotificationOptions) {
      spawned.push({ title, options, onclick: null, close: this.close });
      // onclick 由调用方在构造后赋值，这里用 getter 同步回记录对象。
      Object.defineProperty(this, 'onclick', {
        get: () => null,
        set: (value: (() => void) | null) => {
          const last = spawned[spawned.length - 1];
          if (last) last.onclick = value;
        },
      });
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return FakeNotification as unknown as typeof Notification;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('handoff 桌面通知', () => {
  it('未授权时安静返回，不创建任何通知', () => {
    installNotification('default');

    expect(handoffNotificationSupport()).toBe('default');
    expect(notifyNewHandoffs([{ id: 'h1' }])).toBe(0);
    expect(spawned).toHaveLength(0);
  });

  it('同一条待回答只提醒一次，重复轮询不刷屏', () => {
    installNotification('granted');
    const rows = [{ id: 'h1', pending_question: '这个怎么处理？' }];

    expect(notifyNewHandoffs(rows)).toBe(1);
    // 轮询第二轮拿到同一批数据 —— 不该再弹
    expect(notifyNewHandoffs(rows)).toBe(0);
    expect(spawned).toHaveLength(1);
  });

  it('新出现的条目才提醒，已提醒过的跳过', () => {
    installNotification('granted');
    notifyNewHandoffs([{ id: 'h1' }]);

    expect(notifyNewHandoffs([{ id: 'h1' }, { id: 'h2' }])).toBe(1);
    expect(spawned.map((item) => item.options?.tag)).toEqual([
      'staffdeck-handoff-h1',
      'staffdeck-handoff-h2',
    ]);
  });

  it('一次冒出很多条时只弹前三条，其余记账不再重复', () => {
    installNotification('granted');
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: `h${index}` }));

    expect(notifyNewHandoffs(rows)).toBe(3);
    // 剩余 7 条已记账，下一轮不会当成新的
    expect(notifyNewHandoffs(rows)).toBe(0);
  });

  it('正文优先用五段式简报的 ask，超长截断', () => {
    installNotification('granted');
    const longAsk = '很长的描述'.repeat(30);

    notifyNewHandoffs([{ id: 'h1', brief: { ask: longAsk } }]);

    const body = spawned[0].options?.body || '';
    expect(body.endsWith('…')).toBe(true);
    expect(body.length).toBeLessThanOrEqual(81);
  });

  it('正文回退顺序：brief.ask → pending_question → context_summary → 兜底文案', () => {
    installNotification('granted');

    notifyNewHandoffs([{ id: 'a', brief: { ask: '来自简报' }, pending_question: '老字段' }]);
    notifyNewHandoffs([{ id: 'b', pending_question: '老字段问题' }]);
    notifyNewHandoffs([{ id: 'c', context_summary: '摘要' }]);
    notifyNewHandoffs([{ id: 'd' }]);

    expect(spawned.map((item) => item.options?.body)).toEqual([
      '来自简报',
      '老字段问题',
      '摘要',
      '有新的问题需要你来回答',
    ]);
  });

  it('点击通知会把窗口拉到前台并回调对应 id', () => {
    installNotification('granted');
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const onOpen = vi.fn();

    notifyNewHandoffs([{ id: 'h1' }], onOpen);
    spawned[0].onclick?.();

    expect(focus).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith('h1');
    expect(spawned[0].close).toHaveBeenCalled();
  });

  it('浏览器不支持 Notification 时不报错', () => {
    vi.stubGlobal('Notification', undefined);

    expect(handoffNotificationSupport()).toBe('unsupported');
    expect(notifyNewHandoffs([{ id: 'h1' }])).toBe(0);
  });

  it('构造通知抛异常时不影响其余条目', () => {
    installNotification('granted');
    const RealNotification = window.Notification;
    let calls = 0;
    vi.stubGlobal(
      'Notification',
      class extends (RealNotification as unknown as { new (t: string, o?: NotificationOptions): object }) {
        constructor(title: string, options?: NotificationOptions) {
          calls += 1;
          // 第一条炸，第二条正常 —— 模拟部分通知被系统策略拦截
          if (calls === 1) throw new Error('blocked');
          super(title, options);
        }
      },
    );

    expect(() => notifyNewHandoffs([{ id: 'h1' }, { id: 'h2' }])).not.toThrow();
    expect(spawned).toHaveLength(1);
  });

  it('权限申请返回浏览器给的结果，并在异常时保守返回 default', async () => {
    installNotification('default');
    expect(await requestHandoffNotificationPermission()).toBe('default');

    installNotification('granted');
    expect(await requestHandoffNotificationPermission()).toBe('granted');

    const failing = installNotification('default');
    (failing.requestPermission as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    );
    expect(await requestHandoffNotificationPermission()).toBe('default');
  });

  it('resetHandoffNotificationMemory 之后同一条会重新提醒', () => {
    installNotification('granted');

    notifyNewHandoffs([{ id: 'h1' }]);
    expect(notifyNewHandoffs([{ id: 'h1' }])).toBe(0);

    resetHandoffNotificationMemory();
    expect(notifyNewHandoffs([{ id: 'h1' }])).toBe(1);
  });

  /*
   * 路由切换的瞬间新旧两个 useChatSession 实例可能各拿到同一批数据
   * （/workspace/gallery 与 /workspace/chat 各挂一份 hook）。去重必须扛住
   * 这种背靠背调用，否则用户会看到两条一模一样的系统通知。
   */
  it('两个实例背靠背拿到同一批数据只弹一次', () => {
    installNotification('granted');
    const rows = [{ id: 'h1' }, { id: 'h2' }];

    expect(notifyNewHandoffs(rows)).toBe(2);
    expect(notifyNewHandoffs(rows)).toBe(0);
    expect(spawned).toHaveLength(2);
  });
});