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

/**
 * 回跳地址是否可信。不可信时调用方必须忽略它，而不是「尽力跳一下」。
 *
 * ## 端口匹配规则：白名单项**不带端口**时放开任意端口
 *
 * 写成 `127.0.0.1` 表示「这台机器上的任何端口都可信」（本地开发会换 5173/5100/…）；
 * 写成 `127.0.0.1:5100` 表示「只信这一个端口」。
 *
 * 为什么需要这条：`url.host` **包含端口**，所以 `127.0.0.1:5100` 与白名单里的
 * `127.0.0.1` 字符串不相等。严格执行「不带端口也得精确等于」会让开发机换一个
 * 端口就整条通路失效，而错误表现是「登录成功但回不来」——极难定位到是配置问题。
 *
 * ## 比端口时必须用「有效端口」，不能比 `url.host`
 *
 * `new URL('https://a.com/')` 会把默认端口 443 **规范化掉**，`url.host` 是
 * `a.com` 而不是 `a.com:443`。所以白名单写 `a.com:443` 时若拿 `url.host` 去比
 * 字符串，永远匹配不上 —— 这正是最该被信任的那一条配置反而失效。这里改用
 * `url.port || scheme 的默认端口` 得出有效端口再比。
 *
 * 安全边界没有因此松掉：开放重定向的危害是**跨站**把 token 送出去，而单个 host
 * 的端口变化仍属于同一台的信任域。生产环境应写完整 `host:port`，把范围收到最小。
 */
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

  const hostname = url.hostname.toLowerCase();
  const effectivePort = url.port || (url.protocol === "https:" ? "443" : "80");

  return ALLOWED_HOSTS.some((allowed) => {
    const sep = allowed.lastIndexOf(":");
    // 不带端口 → 该 host 的任意端口都可信。
    if (sep === -1) return allowed === hostname;
    const allowedHost = allowed.slice(0, sep);
    const allowedPort = allowed.slice(sep + 1);
    return allowedHost === hostname && allowedPort === effectivePort;
  });
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
 * 一次性闩锁：回跳只允许发生一次。
 *
 * 已登录用户带着 `?redirect=` 打开本站时，`App` 的会话校验 effect 与登录页
 * 的登录回调**都可能**走到这里；没有闩锁就会连跳两次，第二次落到外部站时
 * 首次的参数已经被消费掉了。
 */
let redirectHandled = false;

/**
 * 把 token 追加到回调地址并跳过去。
 *
 * 用 `location.replace` 而不是 `assign`：回跳发生后，浏览器的「后退」不该把
 * 用户送回登录页 —— 那时他已经登录了，退回去只会看到被立即重定向的空白页。
 *
 * 保留回调地址原有的 hash（若有）并追加参数，避免覆盖外部站点自己的路由状态。
 */
export function redirectWithToken(target: string, token: string): void {
  redirectHandled = true;
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
  if (redirectHandled) return false;
  const target = readRedirectTarget();
  if (!target) return false;
  redirectWithToken(target, token);
  return true;
}

/**
 * 用户**本来就登录着**、根本没经过登录页时也要把 token 送回去。
 *
 * 这是跨域通路最容易漏掉的一条：已登录用户打开
 * `https://ai-staff/#?redirect=…` 时，`App` 直接渲染站内应用，`LoginForm`
 * 的登录回调永远不会执行 —— 外部站点会一直停在「等待登录」上。所以
 * `App` 在会话校验通过后必须显式调一次本函数。
 */
export function finishExternalRedirectIfSignedIn(token: string): boolean {
  return finishExternalRedirect(token);
}