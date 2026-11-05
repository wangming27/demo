import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, Input } from '@douyinfe/semi-ui';
import { Link } from 'react-router';
import { login, register } from '../../services/api';
import type { User } from '../../services/api';
import Icon from '../../components/common/Icon';

interface LoginPageProps {
  notice: string;
  onAuthenticated: (user: User) => void;
}

export default function LoginPage({ notice, onAuthenticated }: LoginPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    setError('');
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section
        className="relative hidden flex-col justify-between bg-slate-950 p-12 text-white lg:flex"
        aria-label="Demo Console"
      >
        <Link
          className="flex items-center gap-3 text-xl font-semibold text-white no-underline"
          to="/"
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-indigo-500">
            <Icon name="layers" />
          </span>
          <span>
            Demo<span className="font-normal text-slate-400"> Console</span>
          </span>
        </Link>
        <div className="my-16 max-w-lg">
          <span className="text-sm text-indigo-300">你的管理工作台</span>
          <h1 className="my-6 text-5xl leading-tight font-semibold tracking-tight">
            让管理更清晰，
            <br />
            让工作更简单。
          </h1>
          <p className="text-lg leading-8 text-slate-400">
            从一个井然有序的工作台开始，
            <br />
            集中查看用户信息，轻松掌握账号状态。
          </p>
          <div className="mt-12 grid grid-cols-3 gap-4 border-t border-white/10 pt-8 text-sm text-slate-300">
            <span>统一用户管理</span>
            <span>清晰账号状态</span>
            <span>安全权限控制</span>
          </div>
        </div>
        <p className="text-xs tracking-widest text-slate-500">
          DEMO CONSOLE · 把每一次管理，变得简单
        </p>
      </section>
      <section className="flex min-h-screen flex-col items-center justify-between bg-surface px-6 py-8 sm:px-12">
        <span className="text-sm text-muted">一个账号，一个有序的工作空间</span>
        <div className="my-12 w-full max-w-sm">
          <span className="mb-6 flex size-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
            <Icon name={isRegister ? 'users' : 'lock'} />
          </span>
          <h2 className="text-3xl font-semibold">{isRegister ? '创建你的账号' : '欢迎回来'}</h2>
          <p className="mt-3 mb-8 text-muted">
            {isRegister ? '填写以下信息，开启你的工作台。' : '登录你的账号，进入管理工作台。'}
          </p>
          <form onSubmit={(event) => void submit(event)} aria-busy={pending}>
            <fieldset disabled={pending} className="space-y-5">
              {isRegister && (
                <label className="block space-y-2 text-sm font-medium" htmlFor="account-name">
                  昵称
                  <Input
                    id="account-name"
                    name="name"
                    autoComplete="nickname"
                    placeholder="怎么称呼你"
                    value={name}
                    onChange={setName}
                    disabled={pending}
                    size="large"
                    required
                    maxLength={80}
                  />
                </label>
              )}
              <label className="block space-y-2 text-sm font-medium" htmlFor="account-email">
                邮箱地址
                <Input
                  prefix={<Icon name="mail" />}
                  id="account-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@example.com"
                  value={email}
                  onChange={setEmail}
                  disabled={pending}
                  size="large"
                  required
                  maxLength={254}
                />
              </label>
              <label className="block space-y-2 text-sm font-medium" htmlFor="account-password">
                密码
                <Input
                  prefix={<Icon name="lock" />}
                  mode="password"
                  id="account-password"
                  name="password"
                  aria-label="密码"
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  placeholder="请输入密码"
                  value={password}
                  onChange={setPassword}
                  disabled={pending}
                  size="large"
                  required
                  minLength={isRegister ? 12 : 1}
                  maxLength={128}
                  aria-describedby="password-help"
                />
              </label>
              <p id="password-help" className="text-xs text-muted">
                {isRegister ? '密码长度为 12–128 个字符。' : '请输入你的账号密码。'}
              </p>
              {error && (
                <div role="alert">
                  <Banner type="danger" description={error} closeIcon={null} />
                </div>
              )}
              <Button
                htmlType="submit"
                theme="solid"
                size="large"
                block
                loading={pending}
                disabled={pending}
              >
                {isRegister ? '注册并进入工作台' : '登录工作台'}
              </Button>
            </fieldset>
          </form>
          <p className="mt-6 text-center text-sm text-muted">
            {isRegister ? '已有账号？' : '还没有账号？'}
            <Button theme="borderless" disabled={pending} onClick={switchMode}>
              {isRegister ? '返回登录' : '立即注册'}
            </Button>
          </p>
          {notice && (
            <div role="status">
              <Banner className="mt-4" type="success" description={notice} closeIcon={null} />
            </div>
          )}
          <div className="mt-8 flex items-center justify-center gap-2 border-t border-line pt-6 text-xs text-muted">
            <Icon name="shield" />
            <span>安全登录，安心管理</span>
          </div>
        </div>
        <footer className="text-xs text-muted">Demo Console · 用户管理工作台</footer>
      </section>
    </main>
  );
}
