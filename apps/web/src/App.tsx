import { useEffect, useRef, useState } from 'react';
import { getHealth } from './api';

type ConnectionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'connected'; service: string; timestamp: string }
  | { status: 'error'; message: string };

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>({ status: 'idle' });
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  async function checkConnection() {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setConnection({ status: 'loading' });

    try {
      const health = await getHealth(controller.signal);
      if (!controller.signal.aborted) {
        setConnection({
          status: 'connected',
          service: health.service,
          timestamp: health.timestamp,
        });
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        setConnection({
          status: 'error',
          message: error instanceof Error ? error.message : '服务暂时不可用',
        });
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
      }
    }
  }

  return (
    <main className="page">
      <header className="header">
        <span className="wordmark">self-demo</span>
        <span className="badge">开发环境</span>
      </header>

      <section className="intro">
        <p className="eyebrow">MONOREPO STARTER</p>
        <h1>从这里开始构建。</h1>
        <p className="description">
          React 前端与 NestJS 服务端已经就位。检查服务连接，然后开始你的第一个功能。
        </p>
      </section>

      <section className="connection-card" aria-labelledby="connection-title">
        <div className="card-heading">
          <div>
            <p className="eyebrow">API CONNECTION</p>
            <h2 id="connection-title">服务连接</h2>
          </div>
          <code>GET /api/health</code>
        </div>

        <div className="connection-state" role="status" aria-live="polite">
          {connection.status === 'idle' && <p>点击下方按钮，检查前端与服务端是否连通。</p>}
          {connection.status === 'loading' && <p>正在连接服务端…</p>}
          {connection.status === 'connected' && (
            <>
              <p className="success">连接成功</p>
              <dl>
                <div>
                  <dt>服务</dt>
                  <dd>{connection.service}</dd>
                </div>
                <div>
                  <dt>响应时间</dt>
                  <dd>{new Date(connection.timestamp).toLocaleString('zh-CN')}</dd>
                </div>
              </dl>
            </>
          )}
          {connection.status === 'error' && (
            <p className="error">{connection.message}，请确认服务端已启动后重试。</p>
          )}
        </div>

        <button
          type="button"
          disabled={connection.status === 'loading'}
          onClick={() => void checkConnection()}
        >
          {connection.status === 'loading' ? '连接中…' : '检查连接'}
        </button>
      </section>

      <footer>Vite + React · NestJS</footer>
    </main>
  );
}
