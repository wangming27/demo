import { useEffect, useRef, useState } from 'react';
import { ApiError, getUser, listUsers } from './api';
import type { ManagedUser, User, UserList, UserQuery } from './api';
import Icon from './Icon';
import UserDialog from './UserDialog';
import type { UserDialogState } from './UserDialog';
import { formatDate, initialOf } from './user-format';

interface Props {
  actor: User;
  onSessionExpired: () => void;
  onUserChanged: (user: User) => void;
  onRefreshSession: () => void;
}

type ListState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; data: UserList }
  | { key: string; status: 'error'; message: string; forbidden: boolean };

export default function UserManagement({
  actor,
  onSessionExpired,
  onUserChanged,
  onRefreshSession,
}: Props) {
  const [query, setQuery] = useState<UserQuery>({ page: 1, pageSize: 10, search: '', status: '' });
  const [draft, setDraft] = useState('');
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<ListState>({ key: '', status: 'loading' });
  const [dialog, setDialog] = useState<UserDialogState | null>(null);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [detailPending, setDetailPending] = useState<string | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const key = JSON.stringify([query, revision]);
  const current = list.key === key ? list : null;
  const data = current?.status === 'ready' ? current.data : null;
  const loading = !current || current.status === 'loading';

  useEffect(() => {
    const controller = new AbortController();
    void listUsers(query, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setList({ key, status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          if (error instanceof ApiError && error.status === 401) onSessionExpired();
          else
            setList({
              key,
              status: 'error',
              message: error instanceof Error ? error.message : '无法获取用户列表',
              forbidden: error instanceof ApiError && error.status === 403,
            });
        }
      });
    return () => controller.abort();
  }, [query, key, onSessionExpired]);

  useEffect(() => () => detailRequestRef.current?.abort(), []);

  function refresh() {
    setActionError('');
    setRevision((value) => value + 1);
  }

  function openDialog(state: UserDialogState) {
    detailRequestRef.current?.abort();
    setDetailPending(null);
    setActionError('');
    setNotice('');
    setDialog(state);
  }

  async function detail(user: ManagedUser) {
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    setDetailPending(user.id);
    setActionError('');
    try {
      const latest = await getUser(user.id, controller.signal);
      if (!controller.signal.aborted) setDialog({ kind: 'detail', user: latest });
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        if (error instanceof ApiError && error.status === 401) onSessionExpired();
        else setActionError(error instanceof Error ? error.message : '无法获取详情');
      }
    } finally {
      if (!controller.signal.aborted) setDetailPending(null);
    }
  }

  function saved(user: ManagedUser) {
    setDialog(null);
    setNotice('用户信息已保存。');
    refresh();
    if (user.id === actor.id) {
      if (user.email !== actor.email) onSessionExpired();
      else
        onUserChanged({
          id: user.id,
          name: user.name,
          email: user.email,
          createdAt: user.createdAt,
          role: user.role,
        });
    }
  }

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / query.pageSize));
  const page = data?.page ?? query.page;
  return (
    <>
      <section className="stats-grid" aria-label="用户概览">
        {(
          [
            ['用户总数', data?.stats.total, '全部注册账号', 'purple', 'users'],
            ['已启用', data?.stats.active, '可正常登录的账号', 'green', 'shield'],
            ['已停用', data?.stats.disabled, '已限制登录的账号', 'blue', 'lock'],
          ] as const
        ).map(([label, count, hint, color, icon]) => (
          <article className="stat-card" key={label}>
            <div>
              <p>{label}</p>
              <strong>
                {count ?? '—'}
                <span>位</span>
              </strong>
              <small>{hint}</small>
            </div>
            <span className={`stat-icon ${color}`}>
              <Icon name={icon} />
            </span>
          </article>
        ))}
      </section>
      <section className="users-card" aria-labelledby="users-title" aria-busy={loading}>
        <div className="users-card-heading">
          <div className="users-title">
            <h2 id="users-title">用户列表</h2>
            <span className="count-badge">{data?.total ?? '—'}</span>
          </div>
          <button
            className="primary-button compact-button"
            onClick={() => {
              openDialog({ kind: 'create' });
            }}
          >
            新增用户
          </button>
        </div>
        <form
          className="table-toolbar management-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery({ ...query, page: 1, search: draft.trim() });
          }}
        >
          <label className="search-field">
            <Icon name="search" />
            <input
              type="search"
              aria-label="搜索用户昵称或邮箱"
              placeholder="搜索用户昵称或邮箱…"
              value={draft}
              maxLength={100}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button className="secondary-button" type="submit">
            搜索
          </button>
          <select
            aria-label="筛选账号状态"
            value={query.status}
            onChange={(event) =>
              setQuery({
                ...query,
                page: 1,
                status:
                  event.target.value === 'ACTIVE'
                    ? 'ACTIVE'
                    : event.target.value === 'DISABLED'
                      ? 'DISABLED'
                      : '',
              })
            }
          >
            <option value="">全部状态</option>
            <option value="ACTIVE">已启用</option>
            <option value="DISABLED">已停用</option>
          </select>
          <button
            className="secondary-button toolbar-refresh"
            type="button"
            disabled={loading}
            onClick={refresh}
          >
            <Icon name="refresh" className={loading ? 'spinning' : ''} />
            刷新列表
          </button>
        </form>
        <p className="scope-note">
          <Icon name="shield" />
          管理员可管理全部账号；停用账号将撤销其全部会话。
        </p>
        {notice && (
          <p className="success table-error" role="status">
            {notice}
          </p>
        )}
        {actionError && (
          <p className="error table-error" role="alert">
            {actionError}
          </p>
        )}
        {current?.status === 'error' ? (
          <div className="empty-state">
            <h3 role="alert">{current.message}</h3>
            <button
              className="secondary-button"
              onClick={current.forbidden ? onRefreshSession : refresh}
            >
              {current.forbidden ? '刷新账号权限' : '重试'}
            </button>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">用户</th>
                  <th scope="col">邮箱地址</th>
                  <th scope="col">角色</th>
                  <th scope="col">账号状态</th>
                  <th scope="col">注册时间</th>
                  <th scope="col" className="action-cell">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty-state" role="status">
                        <span className="spinner" />
                        <p>正在加载用户列表…</p>
                      </div>
                    </td>
                  </tr>
                ) : data?.items.length ? (
                  data.items.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <div className="user-cell">
                          <span className="avatar">{initialOf(user.name)}</span>
                          <div>
                            <strong>
                              {user.name}
                              {user.id === actor.id && <span className="self-badge">我</span>}
                            </strong>
                            <small>{user.role === 'ADMIN' ? '管理员账号' : '个人账号'}</small>
                          </div>
                        </div>
                      </td>
                      <td className="email-cell">{user.email}</td>
                      <td>
                        <span className={`role-badge ${user.role === 'ADMIN' ? 'admin-role' : ''}`}>
                          {user.role === 'ADMIN' ? '管理员' : '普通用户'}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`status-badge ${user.status === 'DISABLED' ? 'disabled-status' : ''}`}
                        >
                          <span className="status-dot" />
                          {user.status === 'ACTIVE' ? '已启用' : '已停用'}
                        </span>
                      </td>
                      <td className="table-date">{formatDate(user.createdAt, true)}</td>
                      <td className="action-cell">
                        <div className="row-actions">
                          <button
                            className="text-button"
                            disabled={detailPending !== null}
                            onClick={() => void detail(user)}
                          >
                            {detailPending === user.id ? '加载中…' : '详情'}
                          </button>
                          <button
                            className="text-button"
                            onClick={() => openDialog({ kind: 'edit', user })}
                          >
                            编辑
                          </button>
                          <button
                            className={`text-button ${user.status === 'ACTIVE' ? 'danger-text' : ''}`}
                            disabled={user.id === actor.id}
                            title={user.id === actor.id ? '不能停用当前账号' : undefined}
                            onClick={() => openDialog({ kind: 'status', user })}
                          >
                            {user.status === 'ACTIVE' ? '停用' : '启用'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty-state">
                        <Icon name="search" />
                        <h3>没有找到匹配的用户</h3>
                        <p>试试其他昵称、邮箱或账号状态。</p>
                        <button
                          className="text-button"
                          onClick={() => {
                            setDraft('');
                            setQuery({ ...query, page: 1, search: '', status: '' });
                          }}
                        >
                          清除筛选
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer management-pagination">
          <span role="status" aria-live="polite">
            {data
              ? `共 ${data.total} 位用户，当前显示 ${data.total === 0 ? 0 : (page - 1) * data.pageSize + 1}–${Math.min(page * data.pageSize, data.total)}`
              : loading
                ? '正在加载…'
                : '加载失败'}
          </span>
          <div className="pagination-controls">
            <select
              aria-label="每页用户数"
              value={query.pageSize}
              onChange={(event) =>
                setQuery({ ...query, page: 1, pageSize: Number(event.target.value) })
              }
            >
              <option value="10">10 条 / 页</option>
              <option value="20">20 条 / 页</option>
              <option value="50">50 条 / 页</option>
            </select>
            <button
              className="secondary-button"
              aria-label="上一页"
              disabled={loading || !data || page <= 1}
              onClick={() => setQuery({ ...query, page: page - 1 })}
            >
              上一页
            </button>
            <span>
              {data ? page : '—'} / {data ? pages : '—'}
            </span>
            <button
              className="secondary-button"
              aria-label="下一页"
              disabled={loading || !data || page >= pages}
              onClick={() => setQuery({ ...query, page: page + 1 })}
            >
              下一页
            </button>
          </div>
        </div>
      </section>
      {dialog && (
        <UserDialog
          key={dialog.kind === 'create' ? 'create' : `${dialog.kind}-${dialog.user.id}`}
          state={dialog}
          actor={actor}
          onClose={() => setDialog(null)}
          onSaved={saved}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}
