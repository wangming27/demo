import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { getCurrentUser, login, logout, register } from './api';
import type { User } from './api';

type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: User }
  | { status: 'error'; message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '服务暂时不可用，请稍后重试';
}

export default function AuthPanel() {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    void getCurrentUser(controller.signal)
      .then((user) => {
        if (!controller.signal.aborted) {
          setSession(user ? { status: 'authenticated', user } : { status: 'anonymous' });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setSession({ status: 'error', message: messageOf(error) });
        }
      })
      .finally(() => {
        if (requestRef.current === controller) {
          requestRef.current = null;
        }
      });
    return () => requestRef.current?.abort();
  }, []);

  async function retrySession() {
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setSession({ status: 'loading' });
    try {
      const user = await getCurrentUser(controller.signal);
      if (!controller.signal.aborted) {
        setSession(user ? { status: 'authenticated', user } : { status: 'anonymous' });
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        setSession({ status: 'error', message: messageOf(error) });
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
      }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const user =
        mode === 'register'
          ? await register({ name, email, password }, controller.signal)
          : await login({ email, password }, controller.signal);
      if (!controller.signal.aborted) {
        setSession({ status: 'authenticated', user });
        setPassword('');
        setNotice(mode === 'register' ? '注册成功，你已登录。' : '登录成功。');
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        setError(messageOf(error));
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setPending(false);
      }
    }
  }

  async function signOut() {
    if (pending) {
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(true);
    setError('');
    setNotice('');
    try {
      await logout(controller.signal);
      if (!controller.signal.aborted) {
        setSession({ status: 'anonymous' });
        setPassword('');
        setMode('login');
        setNotice('已退出登录。');
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        setError(messageOf(error));
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setPending(false);
      }
    }
  }

  return (
    <section className="auth-card" aria-labelledby="auth-title" aria-busy={pending}>
      <div className="card-heading">
        <div>
          <p className="eyebrow">YOUR ACCOUNT</p>
          <h2 id="auth-title">我的账号</h2>
        </div>
        {session.status === 'authenticated' && <span className="badge">已登录</span>}
      </div>

      {session.status === 'loading' && <p role="status">正在确认登录状态…</p>}
      {session.status === 'error' && (
        <div className="session-error">
          <p className="error" role="alert">
            {session.message}
          </p>
          <button type="button" onClick={() => void retrySession()}>
            重试
          </button>
        </div>
      )}
      {session.status === 'authenticated' && (
        <div className="account-details">
          <p className="welcome">你好，{session.user.name}</p>
          <dl>
            <div>
              <dt>邮箱</dt>
              <dd>{session.user.email}</dd>
            </div>
            <div>
              <dt>注册时间</dt>
              <dd>{new Date(session.user.createdAt).toLocaleString('zh-CN')}</dd>
            </div>
          </dl>
          <button type="button" disabled={pending} onClick={() => void signOut()}>
            {pending ? '正在退出…' : '退出登录'}
          </button>
        </div>
      )}
      {session.status === 'anonymous' && (
        <>
          <div className="auth-modes" role="group" aria-label="选择登录或注册">
            <button
              type="button"
              aria-pressed={mode === 'login'}
              disabled={pending}
              onClick={() => {
                setMode('login');
                setPassword('');
                setError('');
                setNotice('');
              }}
            >
              登录
            </button>
            <button
              type="button"
              aria-pressed={mode === 'register'}
              disabled={pending}
              onClick={() => {
                setMode('register');
                setPassword('');
                setError('');
                setNotice('');
              }}
            >
              注册
            </button>
          </div>
          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            <fieldset disabled={pending}>
              {mode === 'register' && (
                <label htmlFor="account-name">
                  昵称
                  <input
                    id="account-name"
                    name="name"
                    autoComplete="nickname"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={80}
                  />
                </label>
              )}
              <label htmlFor="account-email">
                邮箱
                <input
                  id="account-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  maxLength={254}
                />
              </label>
              <label htmlFor="account-password">
                密码
                <input
                  id="account-password"
                  name="password"
                  type="password"
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={12}
                  maxLength={128}
                  aria-describedby="password-help"
                />
              </label>
              <p id="password-help" className="field-help">
                密码需为 12–128 个字符。
              </p>
              <button type="submit">
                {pending ? '正在处理…' : mode === 'register' ? '注册并登录' : '登录'}
              </button>
            </fieldset>
          </form>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="auth-notice" role="status" aria-live="polite">
        {notice}
      </p>
    </section>
  );
}
