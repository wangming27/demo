import { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Banner,
  Button,
  Card,
  Input,
  Pagination,
  Select,
  Table,
  Tag,
} from '@douyinfe/semi-ui';
import type { ColumnProps } from '@douyinfe/semi-ui/lib/es/table';
import { ApiError, getUser, listUsers } from '../../services/api';
import type { ManagedUser, User, UserList, UserQuery } from '../../services/api';
import Icon from '../common/Icon';
import UserDialog from './UserDialog';
import type { UserDialogState } from './UserDialog';
import { formatDate, initialOf } from '../../utils/user-format';

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

  const columns: ColumnProps<ManagedUser>[] = [
    {
      title: '用户',
      dataIndex: 'name',
      width: 220,
      render: (_value, user) => (
        <div className="flex items-center gap-3">
          <Avatar color="purple" size="small">
            {initialOf(user.name)}
          </Avatar>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <strong className="max-w-32 truncate font-medium" title={user.name}>
                {user.name}
              </strong>
              {user.id === actor.id && <Tag size="small">我</Tag>}
            </div>
            <p className="mt-1 text-xs text-muted">
              {user.role === 'ADMIN' ? '管理员账号' : '个人账号'}
            </p>
          </div>
        </div>
      ),
    },
    { title: '邮箱地址', dataIndex: 'email', width: 250, ellipsis: true },
    {
      title: '角色',
      dataIndex: 'role',
      width: 110,
      render: (_value, user) => (
        <Tag color={user.role === 'ADMIN' ? 'purple' : 'grey'}>
          {user.role === 'ADMIN' ? '管理员' : '普通用户'}
        </Tag>
      ),
    },
    {
      title: '账号状态',
      dataIndex: 'status',
      width: 110,
      render: (_value, user) => (
        <Tag color={user.status === 'ACTIVE' ? 'green' : 'grey'}>
          {user.status === 'ACTIVE' ? '已启用' : '已停用'}
        </Tag>
      ),
    },
    {
      title: '注册时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (_value, user) => (
        <span className="text-sm text-muted">{formatDate(user.createdAt, true)}</span>
      ),
    },
    {
      title: '操作',
      width: 220,
      render: (_value, user) => (
        <div className="flex gap-1">
          <Button
            theme="borderless"
            size="small"
            loading={detailPending === user.id}
            disabled={detailPending === user.id}
            onClick={() => void detail(user)}
          >
            详情
          </Button>
          <Button
            theme="borderless"
            size="small"
            onClick={() => openDialog({ kind: 'edit', user })}
          >
            编辑
          </Button>
          <Button
            theme="borderless"
            size="small"
            type={user.status === 'ACTIVE' ? 'danger' : 'primary'}
            disabled={user.id === actor.id}
            onClick={() => openDialog({ kind: 'status', user })}
          >
            {user.status === 'ACTIVE' ? '停用' : '启用'}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <section className="mb-6 grid gap-4 sm:grid-cols-3" aria-label="用户概览">
        {(
          [
            [
              '用户总数',
              data?.stats.total,
              '全部注册账号',
              'users',
              'bg-indigo-50 text-indigo-600',
            ],
            [
              '已启用',
              data?.stats.active,
              '可正常登录的账号',
              'shield',
              'bg-emerald-50 text-emerald-600',
            ],
            [
              '已停用',
              data?.stats.disabled,
              '已限制登录的账号',
              'lock',
              'bg-slate-100 text-slate-600',
            ],
          ] as const
        ).map(([label, count, hint, icon, color]) => (
          <Card key={label}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-muted">{label}</p>
                <p className="my-3 text-3xl font-semibold">
                  {count ?? '—'}
                  <span className="ml-2 text-xs font-normal text-muted">位</span>
                </p>
                <p className="text-xs text-muted">{hint}</p>
              </div>
              <span className={`flex size-11 items-center justify-center rounded-xl ${color}`}>
                <Icon name={icon} />
              </span>
            </div>
          </Card>
        ))}
      </section>
      <section aria-labelledby="users-title" aria-busy={loading}>
        <Card bodyStyle={{ padding: 0 }}>
          <div className="flex items-center justify-between border-b border-line px-5 py-5">
            <div className="flex items-center gap-3">
              <h2 id="users-title" className="text-lg font-semibold">
                用户列表
              </h2>
              <Tag>{data?.total ?? '—'}</Tag>
            </div>
            <Button theme="solid" onClick={() => openDialog({ kind: 'create' })}>
              新增用户
            </Button>
          </div>
          <form
            className="flex flex-wrap items-center gap-3 px-5 pt-5"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery({ ...query, page: 1, search: draft.trim() });
            }}
          >
            <Input
              className="w-full sm:w-72"
              type="search"
              aria-label="搜索用户昵称或邮箱"
              prefix={<Icon name="search" />}
              placeholder="搜索用户昵称或邮箱…"
              value={draft}
              maxLength={100}
              onChange={setDraft}
            />
            <Button htmlType="submit">搜索</Button>
            <span id="filter-status-label" className="sr-only">
              筛选账号状态
            </span>
            <Select
              className="w-36"
              aria-labelledby="filter-status-label"
              value={query.status}
              onChange={(value) =>
                setQuery({
                  ...query,
                  page: 1,
                  status: value === 'ACTIVE' ? 'ACTIVE' : value === 'DISABLED' ? 'DISABLED' : '',
                })
              }
              optionList={[
                { value: '', label: '全部状态' },
                { value: 'ACTIVE', label: '已启用' },
                { value: 'DISABLED', label: '已停用' },
              ]}
            />
            <Button
              className="sm:ml-auto"
              htmlType="button"
              disabled={loading}
              icon={<Icon name="refresh" />}
              onClick={refresh}
            >
              刷新列表
            </Button>
          </form>
          <p className="flex items-center gap-2 px-5 py-4 text-xs text-muted">
            <Icon name="shield" />
            管理员可管理全部账号；停用账号将撤销其全部会话。
          </p>
          {notice && (
            <div role="status">
              <Banner className="mx-5 mb-4" type="success" description={notice} closeIcon={null} />
            </div>
          )}
          {actionError && (
            <div role="alert">
              <Banner
                className="mx-5 mb-4"
                type="danger"
                description={actionError}
                closeIcon={null}
              />
            </div>
          )}
          {current?.status === 'error' ? (
            <div className="space-y-4 px-5 py-12 text-center">
              <p role="alert">{current.message}</p>
              <Button onClick={current.forbidden ? onRefreshSession : refresh}>
                {current.forbidden ? '刷新账号权限' : '重试'}
              </Button>
            </div>
          ) : (
            <Table<ManagedUser>
              columns={columns}
              dataSource={data?.items ?? []}
              rowKey="id"
              loading={loading}
              pagination={false}
              scroll={{ x: 1090 }}
              empty="没有找到符合条件的用户"
            />
          )}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line px-5 py-4">
            <span className="text-xs text-muted">
              {data ? `共 ${data.total} 位用户` : loading ? '正在加载…' : '加载失败'}
            </span>
            <div className="flex flex-wrap items-center gap-3">
              <span id="page-size-label" className="sr-only">
                每页用户数
              </span>
              <Select
                className="w-32"
                aria-labelledby="page-size-label"
                value={query.pageSize}
                onChange={(value) => {
                  if (typeof value === 'number') setQuery({ ...query, page: 1, pageSize: value });
                }}
                optionList={[10, 20, 50].map((value) => ({ value, label: `${value} 条 / 页` }))}
              />
              <Pagination
                size="small"
                total={data?.total ?? 0}
                currentPage={data?.page ?? query.page}
                pageSize={query.pageSize}
                disabled={loading || !data}
                onPageChange={(page) => setQuery({ ...query, page })}
              />
            </div>
          </div>
        </Card>
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
