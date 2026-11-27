import { useState, type KeyboardEvent } from 'react';

import { api, TENANT_ID, ApiError } from '../api/client';
import {
  readRememberedUsername,
  readRememberLoginPreference,
  setEnterpriseAuthSession,
  writeRememberedUsername,
  writeRememberLoginPreference,
  type EnterpriseAuthSession,
} from '../auth';
import { finishExternalRedirect } from '../auth-redirect';
import IconFieldClear from '../assets/icons/field-clear.svg?react';
import IconFieldEye from '../assets/icons/field-eye.svg?react';
import IconFieldEyeOn from '../assets/icons/field-eye-on.svg?react';

const inputBaseClass =
  'flex h-[44px] w-full items-center gap-[8px] rounded-[10px] border bg-white px-[16px] transition-colors focus-within:border-[#7c3aed] focus-within:shadow-[0_0_0_3px_rgba(124,58,237,0.13)]';

/**
 * 登录表单。
 *
 * 单独成组件是为了把「每敲一个字符就重渲染一次」的影响面锁在这张卡里：
 * 账号、密码、显示切换、错误提示、记住账号这些状态以前都挂在登录页上，
 * 一打字整页（光斑、卡片堆、两翼快照、SOP 光路）跟着重渲染，
 * 而它们各自跑着 anime.js 的常驻动画，重渲染会打断合成层、把帧时间顶到 80ms 以上。
 * 状态下沉之后，父组件在输入期间一次都不重渲染。
 */
export default function LoginForm({ onLogin }: { onLogin: (session: EnterpriseAuthSession) => void }) {
  const [username, setUsername] = useState(() => readRememberedUsername());
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // 「记住账号」：勾选后服务端签发 30 天长效凭证，本机 30 天内免登
  const [remember, setRemember] = useState(() => readRememberLoginPreference());
  const [usernameError, setUsernameError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [loading, setLoading] = useState(false);

  async function login() {
    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();
    setUsernameError(trimmedUsername ? '' : '请输入 OA 账号');
    setPasswordError(trimmedPassword ? '' : '请输入密码');
    if (!trimmedUsername || !trimmedPassword) return;

    setLoading(true);
    try {
      const session = await api.post<EnterpriseAuthSession>('/api/auth/login', {
        tenant_id: TENANT_ID,
        username: trimmedUsername,
        password: trimmedPassword,
        remember,
      });
      // 勾选态与账号名先落盘再进应用：登录成功就算数，不依赖组件是否还被挂着
      writeRememberLoginPreference(remember);
      writeRememberedUsername(remember ? trimmedUsername : null);
      setEnterpriseAuthSession(session);
      /**
       * 跨域外部站点的回跳：本次是从 `?redirect=<外部地址>` 进来的，就把
       * token 带回去，而不是进本站应用。
       *
       * 放在 `setEnterpriseAuthSession` **之后**：本地登录态要先落盘，
       * 这样即使用户回跳后立刻又开本站，也已经是登录状态。
       * 放在 `onLogin` **之前**：`onLogin` 会让 App 切到 `AuthedApp` 并开始
       * 拉大量数据，那些请求对一个马上要被跳走的页面纯属浪费。
       *
       * 回跳地址已在 `finishExternalRedirect` 内部做过 host 白名单校验，
       * 未配置白名单时该函数恒返回 false，走正常的站内登录流程。
       */
      if (finishExternalRedirect(session.token)) return;
      onLogin(session);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : '';
      const fallback = '登录失败，请稍后重试';
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setUsernameError('账号或密码不正确');
        setPasswordError('请检查后重新输入');
      } else {
        setUsernameError('账号输入错误');
        setPasswordError(messageText || fallback);
      }
    } finally {
      setLoading(false);
    }
  }

  function onFieldKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') void login();
  }

  return (
    <form
      className="flex flex-col gap-[12px]"
      onSubmit={(event) => {
        event.preventDefault();
        void login();
      }}
    >
      <div
        className={`${inputBaseClass} ${usernameError ? 'border-[#dc2626]' : username ? 'border-[#7c3aed]' : 'border-[#e4e0ee]'}`}
      >
        <input
          value={username}
          autoComplete="username"
          placeholder="请输入 OA 账号"
          aria-label="账号"
          onChange={(event) => {
            setUsername(event.target.value);
            if (usernameError) setUsernameError('');
          }}
          onKeyDown={onFieldKeyDown}
          className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-[#2e2a3d] outline-none placeholder:text-[#9a94a8]"
        />
        {username && (
          <button
            type="button"
            aria-label="清空账号"
            onClick={() => {
              setUsername('');
              setUsernameError('');
            }}
            className="grid size-[18px] shrink-0 place-items-center text-[#9a94a8] outline-none transition-colors hover:text-[#5f5872]"
          >
            <IconFieldClear className="size-[18px]" />
          </button>
        )}
      </div>
      {usernameError && (
        <p className="-mt-[6px] text-[12px] leading-none text-[#dc2626]" role="alert">
          {usernameError}
        </p>
      )}

      <div
        className={`${inputBaseClass} ${passwordError ? 'border-[#dc2626]' : password ? 'border-[#7c3aed]' : 'border-[#e4e0ee]'}`}
      >
        <input
          value={password}
          type={showPassword ? 'text' : 'password'}
          autoComplete="current-password"
          placeholder="请输入密码"
          aria-label="密码"
          onChange={(event) => {
            setPassword(event.target.value);
            if (passwordError) setPasswordError('');
          }}
          onKeyDown={onFieldKeyDown}
          className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-[#2e2a3d] outline-none placeholder:text-[#9a94a8]"
        />
        <button
          type="button"
          aria-label={showPassword ? '隐藏密码' : '显示密码'}
          onClick={() => setShowPassword((prev) => !prev)}
          className="grid size-[18px] shrink-0 place-items-center text-[#9a94a8] outline-none transition-colors hover:text-[#5f5872]"
        >
          {showPassword ? (
            <IconFieldEyeOn className="size-[18px]" />
          ) : (
            <IconFieldEye className="size-[18px]" />
          )}
        </button>
      </div>
      {passwordError && (
        <p className="-mt-[6px] text-[12px] leading-none text-[#dc2626]" role="alert">
          {passwordError}
        </p>
      )}

      {/* 「记住账号」：勾选后 30 天内免登（凭证有效期由服务端签发）。
          复选框自绘，不用浏览器原生控件——原生勾选框在这套版式里太糙。 */}
      <div className="mt-[2px] flex items-center justify-between gap-[10px]">
        <label className="flex cursor-pointer select-none items-center gap-[8px]">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            aria-label="记住账号"
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="grid size-[16px] shrink-0 place-items-center rounded-[5px] border border-[#ddd6fe] bg-white text-white transition-colors peer-checked:border-[#7c3aed] peer-checked:bg-[#7c3aed] peer-focus-visible:ring-2 peer-focus-visible:ring-[#7c3aed]/25 peer-focus-visible:ring-offset-1"
          >
            {remember && (
              <svg viewBox="0 0 12 12" className="size-[10px]">
                <path
                  d="M1.6 6.3 4.3 9 10.4 3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          <span className="text-[13px] leading-none text-[#5f5872]">记住账号</span>
        </label>
        <span className="shrink-0 text-[12px] leading-none text-[#9a94a8]">
          30 天内免登录
        </span>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="mt-[6px] flex h-[42px] w-full items-center justify-center rounded-[10px] bg-[linear-gradient(180deg,#8b5cf6,#7c3aed)] text-[15px] font-medium text-white shadow-[0_10px_24px_-10px_rgba(124,58,237,0.75)] transition-all hover:brightness-105 hover:shadow-[0_14px_30px_-10px_rgba(124,58,237,0.85)] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
      >
        {loading ? '登录中…' : '登录'}
      </button>
    </form>
  );
}
