/**
 * 外部站点登录回跳。
 *
 * 背景：本平台（AIStaff）是多套内部系统的统一身份源。当一个**跨域**的外部
 * 系统（比如截图转代码工具）希望复用本平台登录态时，它无法读取本域的
 * `localStorage['ultrarag_auth']`（同源策略），所以需要这条回跳通路：
 *
 *   外部站点 → `/?redirect=<回调地址>` → 用户在本站登录
 *           → 站内登录成功后把这些凭据带回 `<回调地址>#staffdeck_token=...`
 *           → 外部站点拿 token 打本站 `/api/auth/me` 确认身份，完成自己的会话
 *
 * ## 为什么 token 放在 hash 里而不是 query
 *
 * hash 不会随请求发给服务端、不进入 Referer、也不落访问日志。凭据放在
 * query 里等于把它写进各级代理和 CDN 的日志。
 *
 * ## 为什么必须有白名单
 *
 * 只按 `?redirect=` 的值跳转就是**开放重定向**：攻击者构造一个
 * `?redirect=https://evil.com#staffdeck_token=<受害者token>` 的链接发给已登录的
 * 受害者，受害者点开就会被静默跳去钓鱼站并**把真 token 交出去**。
 * 所以回调地址必须按 host 白名单校验，不是「格式看起来像 URL」就放行。
 *
 * 白名单通过构建期环境变量配置，逗号分隔：
 *
 *   VITE_AUTH_REDIRECT_HOSTS="127.0.0.1:5173,lvh.me:5173,s2c.example.com"
 *
 * 为空时整条回跳通路关闭（默认关闭）—— 没配置就等于「本部署不需要它」，
 * 这比「默认放行所有域名」安全得多。
 */

/** 允许作为回跳目标的 host（含端口）白名单。未配置则功能整体关闭。 */
function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

const ALLOWED_HOSTS = parseAllowedHosts(import.meta.env.VITE_AUTH_REDIRECT_HOSTS);

/** 回跳地址是否可信。不可信时调用方必须忽略它，而不是「尽力跳一下」。 */
export function isAllowedRedirectTarget(raw: string): boolean {
  if (ALLOWED_HOSTS.length === 0) return false;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  // 只接受 http/https：`javascript:`、`data:` 之类必须挡在门外。
  // 虽然 `new URL('javascript:...')` 能成功解析，但跳转过去就是 XSS 入口。
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  return ALLOWED_HOSTS.includes(url.host.toLowerCase());
}

/**
 * 从当前地址栏取出**已校验**的回跳目标。
 *
 * 参数名刻意用 `redirect` 而不是通用名字，避免和站内其它跳转参数混淆。
 */
export function readRedirectTarget(search: string = window.location.search): string | null {
  const raw = new URLSearchParams(search).get('redirect');
  if (!raw) return null;
  return isAllowedRedirectTarget(raw) ? raw : null;
}

/**
 * 把 token 追加到回调地址并跳过去。
 *
 * 用 `location.replace` 而不是 `assign`：回跳发生后，浏览器的「后退」不该把
 * 用户送回登录页 —— 那时他已经登录了，退回去只会看到被立即重定向的空白页。
 *
 * 保留回调地址原有的 hash（若有）并追加参数，避免覆盖外部站点自己的路由状态。
 */
export function redirectWithToken(target: string, token: string): void {
  const url = new URL(target);
  const params = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  params.set('staffdeck_token', token);
  url.hash = params.toString();
  window.location.replace(url.toString());
}

/**
 * 登录成功后调用：如果本次是从外部站点带来的回跳请求，就带着 token 回去。
 *
 * 返回 `true` 表示已发起跳转（调用方不必再渲染站内应用）。
 */
export function finishExternalRedirect(token: string): boolean {
  const target = readRedirectTarget();
  if (!target) return false;
  redirectWithToken(target, token);
  return true;
}