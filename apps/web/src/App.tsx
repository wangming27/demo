import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentUser, logout } from './api';
import type { User } from './api';
import AdminDashboard from './AdminDashboard';
import AuthPanel from './AuthPanel';
import Icon from './Icon';

type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous'; notice: string }
  | { status: 'authenticated'; user: User }
  | { status: 'error'; message: string };

export default function App() {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [pending, setPending] = useState<'refresh' | 'logout' | null>(null);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const sessionExpired = useCallback(() => {
    requestRef.current?.abort();
    setPending(null);
    setSession({ status: 'anonymous', notice: '登录已失效，请重新登录。' });
  }, []);

  async function restoreSession(signal: AbortSignal) {
    try {
      const user = await getCurrentUser(signal);
      if (!signal.aborted) {
        setSession(user ? { status: 'authenticated', user } : { status: 'anonymous', notice: '' });
      }
    } catch (error: unknown) {
      if (!signal.aborted) {
        setSession({
          status: 'error',
          message: error instanceof Error ? error.message : '服务暂时不可用，请稍后重试',
        });
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    void getCurrentUser(controller.signal)
      .then((user) => {
        if (!controller.signal.aborted) {
          setSession(
            user ? { status: 'authenticated', user } : { status: 'anonymous', notice: '' },
          );
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setSession({
            status: 'error',
            message: error instanceof Error ? error.message : '服务暂时不可用，请稍后重试',
          });
        }
      });
    return () => requestRef.current?.abort();
  }, []);

  function retry() {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setSession({ status: 'loading' });
    void restoreSession(controller.signal);
  }

  async function accountAction(action: 'refresh' | 'logout') {
    if (pending) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(action);
    setError('');
    try {
      if (action === 'logout') {
        await logout(controller.signal);
        if (!controller.signal.aborted) {
          setSession({ status: 'anonymous', notice: '已安全退出登录。' });
        }
      } else {
        const user = await getCurrentUser(controller.signal);
        if (!controller.signal.aborted) {
          setSession(
            user
              ? { status: 'authenticated', user }
              : { status: 'anonymous', notice: '登录已失效，请重新登录。' },
          );
        }
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : '操作失败，请稍后重试');
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setPending(null);
      }
    }
  }

  if (session.status === 'authenticated') {
    return (
      <AdminDashboard
        user={session.user}
        pending={pending}
        error={error}
        onRefresh={() => void accountAction('refresh')}
        onLogout={() => void accountAction('logout')}
        onSessionExpired={sessionExpired}
        onUserChanged={(user) => setSession({ status: 'authenticated', user })}
      />
    );
  }

  if (session.status === 'anonymous') {
    return (
      <AuthPanel
        notice={session.notice}
        onAuthenticated={(user) => {
          setError('');
          setSession({ status: 'authenticated', user });
        }}
      />
    );
  }

  return (
    <main className="session-page">
      <div className="session-card">
        <span className="brand-symbol">
          <Icon name="layers" />
        </span>
        <h1>Demo Console</h1>
        {session.status === 'loading' ? (
          <p className="muted" role="status">
            <span className="spinner" /> 正在确认登录状态…
          </p>
        ) : (
          <>
            <p className="error" role="alert">
              {session.message}
            </p>
            <button className="primary-button" onClick={retry}>
              重新连接
            </button>
          </>
        )}
      </div>
    </main>
  );
}
