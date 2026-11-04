import { useState } from 'react';
import type { User } from './api';
import Icon from './Icon';
import UserManagement from './UserManagement';
import { formatDate, initialOf } from './user-format';

interface AdminDashboardProps {
  user: User;
  pending: 'refresh' | 'logout' | null;
  error: string;
  onRefresh: () => void;
  onLogout: () => void;
  onSessionExpired: () => void;
  onUserChanged: (user: User) => void;
}

export default function AdminDashboard({
  user,
  pending,
  error,
  onRefresh,
  onLogout,
  onSessionExpired,
  onUserChanged,
}: AdminDashboardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="admin-layout">
      {menuOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭导航"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside id="main-sidebar" className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
        <a className="brand" href="/">
          <span className="brand-symbol">
            <Icon name="layers" />
          </span>
          <span>
            Demo<span className="brand-light"> Console</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">D</span>
          <span>
            管理工作台<small>{user.role === 'ADMIN' ? '管理员工作空间' : '个人工作空间'}</small>
          </span>
          <span className="workspace-dot" />
        </div>
        <p className="nav-group-label">工作空间</p>
        <nav aria-label="主导航">
          <a
            className="nav-item active"
            href="#users"
            aria-current="page"
            onClick={() => setMenuOpen(false)}
          >
            <Icon name="users" />
            <span>用户管理</span>
            <Icon name="chevron-right" />
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-tip">
            <Icon name="shield" />
            <strong>账号安全</strong>
            <p>妥善保管账号信息，使用完毕后及时退出登录。</p>
          </div>
          <span className="sidebar-version">
            Demo Console <span>v1.0</span>
          </span>
        </div>
      </aside>
      <div className="admin-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button menu-toggle"
              aria-label={menuOpen ? '关闭导航' : '打开导航'}
              aria-expanded={menuOpen}
              aria-controls="main-sidebar"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Icon name={menuOpen ? 'close' : 'menu'} />
            </button>
            <span>工作台</span>
            <Icon name="chevron-right" />
            <strong>用户管理</strong>
          </div>
          <div className="topbar-account">
            <span className="avatar avatar-small">{initialOf(user.name)}</span>
            <span className="topbar-name">{user.name}</span>
            <span className="topbar-divider" />
            <button className="logout-button" disabled={pending !== null} onClick={onLogout}>
              <Icon name="logout" />
              <span>{pending === 'logout' ? '退出中…' : '退出登录'}</span>
            </button>
          </div>
        </header>
        <main className="dashboard-content" id="users">
          <div className="page-heading">
            <div>
              <p className="eyebrow">WORKSPACE / USERS</p>
              <h1>用户管理</h1>
              <p className="muted">查看用户资料与账号信息，让每一个账号清晰可见。</p>
            </div>
            <span className="date-label">
              <Icon name="calendar" />
              {formatDate(new Date().toISOString())}
            </span>
          </div>
          {error && (
            <p className="error form-message" role="alert">
              {error}
            </p>
          )}
          {user.role === 'ADMIN' ? (
            <UserManagement
              actor={user}
              onSessionExpired={onSessionExpired}
              onUserChanged={onUserChanged}
              onRefreshSession={onRefresh}
            />
          ) : (
            <section className="users-card permission-card">
              <span className="form-icon">
                <Icon name="shield" />
              </span>
              <h2>需要管理员权限</h2>
              <p className="muted">
                你好，{user.name}。当前账号为普通用户，全量用户管理仅对管理员开放。
              </p>
              <p className="muted">如果已获得管理员权限，请刷新账号状态。</p>
              <button className="secondary-button" disabled={pending !== null} onClick={onRefresh}>
                <Icon name="refresh" />
                {pending === 'refresh' ? '刷新中…' : '刷新账号权限'}
              </button>
            </section>
          )}
          <footer className="dashboard-footer">
            <span>Demo Console · 用户管理工作台</span>
            <span>
              <span className="status-dot" />
              {user.role === 'ADMIN' ? '管理员' : '普通用户'} · 已安全登录
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
