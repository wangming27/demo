import { useState } from 'react';
import { Avatar, Banner, Breadcrumb, Button, Card, Nav, SideSheet } from '@douyinfe/semi-ui';
import { Link, useNavigate } from 'react-router';
import type { User } from '../../services/api';
import Icon from '../../components/common/Icon';
import UserManagement from '../../components/users/UserManagement';
import { formatDate, initialOf } from '../../utils/user-format';

interface UsersPageProps {
  user: User;
  pending: 'refresh' | 'logout' | null;
  error: string;
  onRefresh: () => void;
  onLogout: () => void;
  onSessionExpired: () => void;
  onUserChanged: (user: User) => void;
}

export default function UsersPage({
  user,
  pending,
  error,
  onRefresh,
  onLogout,
  onSessionExpired,
  onUserChanged,
}: UsersPageProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const navigation = (
    <div className="flex h-full flex-col p-6">
      <Link
        to="/"
        className="mb-10 flex items-center gap-3 text-xl font-semibold text-inherit no-underline"
      >
        <span className="flex size-10 items-center justify-center rounded-xl bg-indigo-500 text-white">
          <Icon name="layers" />
        </span>
        Demo Console
      </Link>
      <div className="mb-8 flex items-center gap-3">
        <Avatar color="purple" size="small">
          D
        </Avatar>
        <div>
          <p className="font-medium">管理工作台</p>
          <p className="mt-1 text-xs text-muted">
            {user.role === 'ADMIN' ? '管理员工作空间' : '个人工作空间'}
          </p>
        </div>
      </div>
      <nav aria-label="主导航">
        <Nav
          className="w-full border-0 bg-transparent"
          selectedKeys={['users']}
          onSelect={() => {
            setMenuOpen(false);
            void navigate('/users');
          }}
        >
          <Nav.Item itemKey="users" text="用户管理" icon={<Icon name="users" />} />
        </Nav>
      </nav>
      <div className="mt-auto border-t border-line pt-6 text-xs leading-6 text-muted">
        <p className="mb-2 flex items-center gap-2 font-medium">
          <Icon name="shield" />
          账号安全
        </p>
        <p>妥善保管账号信息，使用完毕后及时退出登录。</p>
        <p className="mt-6">Demo Console · v1.0</p>
      </div>
    </div>
  );
  return (
    <div className="min-h-screen bg-canvas">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-line bg-surface lg:block">
        {navigation}
      </aside>
      <SideSheet
        title="工作空间"
        visible={menuOpen}
        onCancel={() => setMenuOpen(false)}
        placement="left"
        width="min(320px, 90vw)"
        bodyStyle={{ padding: 0 }}
      >
        {navigation}
      </SideSheet>
      <div className="lg:ml-64">
        <header className="flex h-20 items-center justify-between gap-3 border-b border-line bg-surface px-4 sm:px-8">
          <div className="flex items-center gap-3">
            <Button
              className="lg:hidden"
              theme="borderless"
              icon={<Icon name="menu" />}
              aria-label="打开导航"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            />
            <Breadcrumb>
              <Breadcrumb.Item>工作台</Breadcrumb.Item>
              <Breadcrumb.Item>用户管理</Breadcrumb.Item>
            </Breadcrumb>
          </div>
          <div className="flex items-center gap-3">
            <Avatar size="small" color="purple">
              {initialOf(user.name)}
            </Avatar>
            <span className="hidden max-w-40 truncate text-sm sm:block">{user.name}</span>
            <Button
              theme="borderless"
              disabled={pending !== null}
              loading={pending === 'logout'}
              icon={<Icon name="logout" />}
              onClick={onLogout}
            >
              退出登录
            </Button>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8" id="users">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-2 text-xs tracking-widest text-muted">WORKSPACE / USERS</p>
              <h1 className="text-3xl font-semibold">用户管理</h1>
              <p className="mt-3 text-sm text-muted">
                查看用户资料与账号信息，让每一个账号清晰可见。
              </p>
            </div>
            <span className="flex items-center gap-2 text-xs text-muted">
              <Icon name="calendar" />
              {formatDate(new Date().toISOString())}
            </span>
          </div>
          {error && (
            <div role="alert">
              <Banner className="mb-4" type="danger" description={error} closeIcon={null} />
            </div>
          )}
          {user.role === 'ADMIN' ? (
            <UserManagement
              actor={user}
              onSessionExpired={onSessionExpired}
              onUserChanged={onUserChanged}
              onRefreshSession={onRefresh}
            />
          ) : (
            <Card className="text-center" bodyStyle={{ padding: '48px 24px' }}>
              <div className="mb-4 flex justify-center text-indigo-500">
                <Icon name="shield" />
              </div>
              <h2 className="text-xl font-semibold">需要管理员权限</h2>
              <p className="my-4 text-muted">
                你好，{user.name}。当前账号为普通用户，全量用户管理仅对管理员开放。
              </p>
              <p className="mb-6 text-sm text-muted">如果已获得管理员权限，请刷新账号状态。</p>
              <Button
                disabled={pending !== null}
                loading={pending === 'refresh'}
                icon={<Icon name="refresh" />}
                onClick={onRefresh}
              >
                刷新账号权限
              </Button>
            </Card>
          )}
          <footer className="mt-8 flex flex-wrap justify-between gap-3 text-xs text-muted">
            <span>Demo Console · 用户管理工作台</span>
            <span>{user.role === 'ADMIN' ? '管理员' : '普通用户'} · 已安全登录</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
