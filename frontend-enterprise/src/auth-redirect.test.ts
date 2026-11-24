// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 回跳白名单是**安全边界**，不是格式校验。
 *
 * 这些用例逐条锁住「什么必须拒绝」：一个开放重定向的后果是攻击者能把
 * 受害者的真 token 送到自己的站上，属于最严重的一类问题，不能只靠人工 review。
 */

const ORIGINAL_ENV = { ...import.meta.env };

async function loadModule(hosts?: string) {
  vi.resetModules();
  if (hosts === undefined) {
    delete (import.meta.env as Record<string, unknown>).VITE_AUTH_REDIRECT_HOSTS;
  } else {
    (import.meta.env as Record<string, unknown>).VITE_AUTH_REDIRECT_HOSTS = hosts;
  }
  return import('./auth-redirect');
}

describe('isAllowedRedirectTarget', () => {
  afterEach(() => {
    Object.assign(import.meta.env, ORIGINAL_ENV);
  });

  it('白名单未配置时一律拒绝（默认关闭优于默认放行）', async () => {
    const mod = await loadModule(undefined);
    expect(mod.isAllowedRedirectTarget('https://s2c.example.com/login')).toBe(false);
  });

  it('白名单内的 host 放行，含端口', async () => {
    const mod = await loadModule('127.0.0.1:5173,s2c.example.com');
    expect(mod.isAllowedRedirectTarget('http://127.0.0.1:5173/login')).toBe(true);
    expect(mod.isAllowedRedirectTarget('https://s2c.example.com/login')).toBe(true);
  });

  it('白名单项不带端口时放开该 host 的任意端口', async () => {
    // 开发机会换端口（5173/5100/…）。若严格要求「不带端口也得精确相等」，
    // 换一个端口整条通路就失效，而症状是「登录成功但回不来」，极难定位。
    const mod = await loadModule('127.0.0.1,s2c.example.com');
    expect(mod.isAllowedRedirectTarget('http://127.0.0.1:5100/login')).toBe(true);
    expect(mod.isAllowedRedirectTarget('http://127.0.0.1:5173/login')).toBe(true);
    expect(mod.isAllowedRedirectTarget('http://127.0.0.1/login')).toBe(true);
    // 但换 host 依然拒绝：放开端口不等于放开域名。
    expect(mod.isAllowedRedirectTarget('http://127.0.0.2:5100/login')).toBe(false);
  });

  it('白名单外的 host 拒绝', async () => {
    const mod = await loadModule('s2c.example.com');
    expect(mod.isAllowedRedirectTarget('https://evil.com/steal')).toBe(false);
  });

  it('白名单项带端口时只信那一个端口', async () => {
    // 生产环境应写完整 host:port，把范围收到最小。
    const mod = await loadModule('s2c.example.com:443');
    expect(mod.isAllowedRedirectTarget('https://s2c.example.com/login')).toBe(true);
    expect(mod.isAllowedRedirectTarget('https://s2c.example.com:8443/login')).toBe(false);
  });

  it('javascript: / data: 伪协议必须拒绝', async () => {
    const mod = await loadModule('s2c.example.com');
    // 关键：这两个也能被 `new URL()` 成功解析，只靠「能不能解析」判断会漏。
    expect(mod.isAllowedRedirectTarget('javascript:alert(1)')).toBe(false);
    expect(mod.isAllowedRedirectTarget('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('畸形输入不抛异常，直接拒绝', async () => {
    const mod = await loadModule('s2c.example.com');
    expect(mod.isAllowedRedirectTarget('not a url')).toBe(false);
    expect(mod.isAllowedRedirectTarget('')).toBe(false);
  });

  it('大小写与空白不影响匹配', async () => {
    const mod = await loadModule('  S2C.Example.COM  ');
    expect(mod.isAllowedRedirectTarget('https://s2c.example.com/login')).toBe(true);
  });

  it('运行时配置优先于构建期配置', async () => {
    // 顺序至关重要：`ALLOWED_HOSTS` 是模块级常量，在模块求值那一刻定下来。
    // 所以必须**先**设 window、**再** loadModule —— 反过来 loadModule 会读到
    // 旧的（没有运行时配置的）状态，测试就会因为错误的原因变绿。
    (window as unknown as Record<string, unknown>).__STAFFDECK_RUNTIME_CONFIG__ = {
      authRedirectHosts: 'runtime.example.com',
    };
    try {
      const mod = await loadModule('build-time.example.com');
      expect(mod.isAllowedRedirectTarget('https://runtime.example.com/login')).toBe(true);
      expect(mod.isAllowedRedirectTarget('https://build-time.example.com/login')).toBe(false);
    } finally {
      delete (window as unknown as Record<string, unknown>).__STAFFDECK_RUNTIME_CONFIG__;
    }
  });

  it('无运行时配置时，构建期白名单行为完全不变（现有部署形态）', async () => {
    // 这条是**回归护栏**：用户当前就是靠构建期白名单工作的，产物里烧的是
    // `27.115.78.122,127.0.0.1,222.71.129.171,10.58.144.52`。
    // 改成「运行时优先」之后，没有运行时注入的部署必须逐字节保持原有行为 ——
    // 否则用户下次重新构建就会莫名其妙失去登录回跳。
    delete (window as unknown as Record<string, unknown>).__STAFFDECK_RUNTIME_CONFIG__;
    const mod = await loadModule(
      '27.115.78.122,127.0.0.1,222.71.129.171,10.58.144.52',
    );
    expect(mod.isAllowedRedirectTarget('http://10.58.144.52:5100/login')).toBe(true);
    expect(mod.isAllowedRedirectTarget('http://222.71.129.171:5100/login')).toBe(true);
    expect(mod.isAllowedRedirectTarget('http://127.0.0.1:5173/login')).toBe(true);
    // 白名单外仍然拒绝 —— 放宽了来源不等于放宽了校验
    expect(mod.isAllowedRedirectTarget('https://evil.example.com/login')).toBe(false);
  });

  it('运行时配置为空串时退回构建期配置', async () => {
    // 后端未配置时**不注入**脚本，但防御式地处理"注入了空值"这种情况：
    // 空串等同于没配，不能因此把回跳通路关掉。
    (window as unknown as Record<string, unknown>).__STAFFDECK_RUNTIME_CONFIG__ = {
      authRedirectHosts: '   ',
    };
    try {
      const mod = await loadModule('build-time.example.com');
      expect(mod.isAllowedRedirectTarget('https://build-time.example.com/login')).toBe(true);
    } finally {
      delete (window as unknown as Record<string, unknown>).__STAFFDECK_RUNTIME_CONFIG__;
    }
  });
});

describe('readRedirectTarget', () => {
  afterEach(() => {
    Object.assign(import.meta.env, ORIGINAL_ENV);
  });

  it('没有 redirect 参数时返回 null', async () => {
    const mod = await loadModule('s2c.example.com');
    expect(mod.readRedirectTarget('')).toBe(null);
    expect(mod.readRedirectTarget('?other=1')).toBe(null);
  });

  it('返回经过校验的目标', async () => {
    const mod = await loadModule('s2c.example.com');
    const target = encodeURIComponent('https://s2c.example.com/login');
    expect(mod.readRedirectTarget(`?redirect=${target}`)).toBe('https://s2c.example.com/login');
  });

  it('不可信目标返回 null 而不是原样透出', async () => {
    const mod = await loadModule('s2c.example.com');
    const target = encodeURIComponent('https://evil.com/steal');
    expect(mod.readRedirectTarget(`?redirect=${target}`)).toBe(null);
  });
});

describe('redirectWithToken', () => {
  let replaced: string | null = null;

  beforeEach(() => {
    replaced = null;
    vi.stubGlobal('location', {
      ...window.location,
      replace: (url: string) => {
        replaced = url;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.assign(import.meta.env, ORIGINAL_ENV);
  });

  it('token 放在 hash 里而不是 query（hash 不进 Referer 与服务端日志）', async () => {
    const mod = await loadModule('s2c.example.com');
    mod.redirectWithToken('https://s2c.example.com/login', 'tok-123');

    expect(replaced).toBeTruthy();
    const url = new URL(replaced!);
    expect(url.search).toBe('');
    expect(url.hash).toBe('#staffdeck_token=tok-123');
  });

  it('保留回调地址原有的 hash 参数', async () => {
    const mod = await loadModule('s2c.example.com');
    mod.redirectWithToken('https://s2c.example.com/login#foo=bar', 'tok-123');

    const params = new URLSearchParams(new URL(replaced!).hash.slice(1));
    expect(params.get('foo')).toBe('bar');
    expect(params.get('staffdeck_token')).toBe('tok-123');
  });

  it('用 replace 而不是 assign：回跳后按后退不该回到登录页', async () => {
    const replaceSpy = vi.fn();
    const assignSpy = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace: replaceSpy, assign: assignSpy });

    const mod = await loadModule('s2c.example.com');
    mod.redirectWithToken('https://s2c.example.com/login', 'tok');

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).not.toHaveBeenCalled();
  });
});

describe('finishExternalRedirect', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.assign(import.meta.env, ORIGINAL_ENV);
  });

  it('没有可信回跳目标时返回 false，让调用方走正常站内登录', async () => {
    const mod = await loadModule('s2c.example.com');
    vi.stubGlobal('location', { ...window.location, search: '' });
    expect(mod.finishExternalRedirect('tok')).toBe(false);
  });

  it('有可信目标时发起跳转并返回 true', async () => {
    const replaceSpy = vi.fn();
    vi.stubGlobal('location', {
      ...window.location,
      search: `?redirect=${encodeURIComponent('https://s2c.example.com/login')}`,
      replace: replaceSpy,
    });

    const mod = await loadModule('s2c.example.com');
    expect(mod.finishExternalRedirect('tok-abc')).toBe(true);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
  });

  it('已登录分支与登录分支共用闩锁，只跳一次', async () => {
    const replaceSpy = vi.fn();
    vi.stubGlobal('location', {
      ...window.location,
      search: `?redirect=${encodeURIComponent('https://s2c.example.com/login')}`,
      replace: replaceSpy,
    });

    const mod = await loadModule('s2c.example.com');
    // 真实顺序：App 的会话校验先跑（已登录场景），或登录回调先跑（未登录场景）。
    // 两条路径中任意一条生效后，另一条都必须变成 no-op。
    expect(mod.finishExternalRedirectIfSignedIn('tok')).toBe(true);
    expect(mod.finishExternalRedirect('tok')).toBe(false);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
  });
});