import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { login, register } from './api';
import type { User } from './api';
import Icon from './Icon';

interface AuthPanelProps {
  notice: string;
  onAuthenticated: (user: User) => void;
}

export default function AuthPanel({ notice, onAuthenticated }: AuthPanelProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const isRegister = mode === 'register';

  useEffect(() => () => requestRef.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(true);
    setError('');
    try {
      const user = isRegister
        ? await register({ name, email, password }, controller.signal)
        : await login({ email, password }, controller.signal);
      if (!controller.signal.aborted) {
        setPassword('');
        onAuthenticated(user);
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : '服务暂时不可用，请稍后重试');
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setPending(false);
      }
    }
  }

  function switchMode() {
    setMode(isRegister ? 'login' : 'register');
    setPassword('');
    setShowPassword(false);
    setError('');
  }

  return (
    <main className="login-page">
      <section className="login-story" aria-label="Demo Console">
        <a className="brand" href="/">
          <span className="brand-symbol">
            <Icon name="layers" />
          </span>
          <span>
            Demo<span className="brand-light"> Console</span>
          </span>
        </a>
        <div className="story-content">
          <span className="story-label">
            <span className="status-dot" /> 你的管理工作台
          </span>
          <h1>
            让管理更清晰，
            <br />
            让工作更简单。
          </h1>
          <p>
            从一个井然有序的工作台开始，
            <br />
            集中查看用户信息，轻松掌握账号状态。
          </p>
          <div className="workspace-art" aria-hidden="true">
            <div className="art-header">
              <span />
              <span />
              <span />
            </div>
            <div className="art-body">
              <div className="art-sidebar">
                <i />
                <i />
                <i />
                <i />
              </div>
              <div className="art-main">
                <div className="art-title" />
                <div className="art-stats">
                  <i />
                  <i />
                  <i />
                </div>
                <div className="art-row">
                  <b />
                  <i />
                  <span />
                </div>
                <div className="art-row">
                  <b />
                  <i />
                  <span />
                </div>
                <div className="art-row">
                  <b />
                  <i />
                  <span />
                </div>
              </div>
            </div>
          </div>
        </div>
        <p className="story-footer">DEMO CONSOLE · 把每一次管理，变得简单</p>
      </section>
      <section className="login-main">
        <span className="login-top-note">一个账号，一个有序的工作空间</span>
        <div className="login-form-container">
          <span className="form-icon">
            <Icon name={isRegister ? 'users' : 'lock'} />
          </span>
          <h2>{isRegister ? '创建你的账号' : '欢迎回来'}</h2>
          <p className="login-description">
            {isRegister ? '填写以下信息，开启你的工作台。' : '登录你的账号，进入管理工作台。'}
          </p>
          <form className="auth-form" onSubmit={(event) => void submit(event)} aria-busy={pending}>
            <fieldset disabled={pending}>
              {isRegister && (
                <label htmlFor="account-name">
                  昵称
                  <input
                    id="account-name"
                    name="name"
                    autoComplete="nickname"
                    placeholder="怎么称呼你"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={80}
                  />
                </label>
              )}
              <label htmlFor="account-email">
                邮箱地址
                <div className="input-with-icon">
                  <Icon name="mail" />
                  <input
                    id="account-email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    maxLength={254}
                  />
                </div>
              </label>
              <label htmlFor="account-password">
                密码
                <div className="input-with-icon">
                  <Icon name="lock" />
                  <input
                    id="account-password"
                    name="password"
                    aria-label="密码"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={isRegister ? 'new-password' : 'current-password'}
                    placeholder="请输入密码"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    minLength={isRegister ? 12 : 1}
                    maxLength={128}
                    aria-describedby="password-help"
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    <Icon name={showPassword ? 'eye-off' : 'eye'} />
                  </button>
                </div>
              </label>
              <p id="password-help" className="field-help">
                {isRegister ? '密码长度为 12–128 个字符。' : '请输入你的账号密码。'}
              </p>
              {error && (
                <p className="error form-message" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" className="primary-button login-submit">
                {pending ? (
                  <>
                    <span className="spinner" /> 正在处理…
                  </>
                ) : (
                  <>
                    {isRegister ? '注册并进入工作台' : '登录工作台'}
                    <Icon name="arrow-right" />
                  </>
                )}
              </button>
            </fieldset>
          </form>
          <p className="signup-prompt">
            {isRegister ? '已有账号？' : '还没有账号？'}
            <button className="text-button" disabled={pending} onClick={switchMode}>
              {isRegister ? '返回登录' : '立即注册'}
            </button>
          </p>
          {notice && (
            <p className="success form-message" role="status">
              {notice}
            </p>
          )}
          <div className="login-security">
            <Icon name="shield" />
            <span>安全登录，安心管理</span>
          </div>
        </div>
        <footer className="login-footer">Demo Console · 用户管理工作台</footer>
      </section>
    </main>
  );
}
