import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Button, Descriptions, Input, Modal, Select } from '@douyinfe/semi-ui';
import { ApiError, createUser, updateUser } from '../../services/api';
import type { ManagedUser, User } from '../../services/api';
import { formatDate } from '../../utils/user-format';

export type UserDialogState =
  { kind: 'create' } | { kind: 'edit' | 'detail' | 'status'; user: ManagedUser };

interface Props {
  state: UserDialogState;
  actor: User;
  onClose: () => void;
  onSaved: (user: ManagedUser) => void;
  onSessionExpired: () => void;
}

export default function UserDialog({ state, actor, onClose, onSaved, onSessionExpired }: Props) {
  const selected = state.kind === 'create' ? null : state.user;
  const [name, setName] = useState(selected?.name ?? '');
  const [email, setEmail] = useState(selected?.email ?? '');
  const [role, setRole] = useState<User['role']>(selected?.role ?? 'USER');
  const [status, setStatus] = useState<ManagedUser['status']>(selected?.status ?? 'ACTIVE');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const isSelf = selected?.id === actor.id;
  const title =
    state.kind === 'create'
      ? '新增用户'
      : state.kind === 'edit'
        ? '编辑用户'
        : state.kind === 'detail'
          ? '用户详情'
          : selected?.status === 'ACTIVE'
            ? '停用账号'
            : '启用账号';

  useEffect(() => () => requestRef.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || state.kind === 'detail') return;
    const controller = new AbortController();
    requestRef.current = controller;
    setSaving(true);
    setError('');
    try {
      const user =
        state.kind === 'create'
          ? await createUser({ name, email, password, role }, controller.signal)
          : selected &&
            (await updateUser(
              selected.id,
              {
                name: state.kind === 'status' ? selected.name : name,
                email: state.kind === 'status' ? selected.email : email,
                role: state.kind === 'status' ? selected.role : role,
                status:
                  state.kind === 'status'
                    ? selected.status === 'ACTIVE'
                      ? 'DISABLED'
                      : 'ACTIVE'
                    : status,
                updatedAt: selected.updatedAt,
              },
              controller.signal,
            ));
      if (!controller.signal.aborted && user) onSaved(user);
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        if (error instanceof ApiError && error.status === 401) onSessionExpired();
        else setError(error instanceof Error ? error.message : '保存失败，请重试');
      }
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <Modal
      visible
      title={title}
      footer={null}
      width="min(520px, calc(100vw - 32px))"
      maskClosable={!saving}
      closeOnEsc={!saving}
      closable={!saving}
      onCancel={() => {
        if (!saving) onClose();
      }}
    >
      {state.kind === 'detail' && selected ? (
        <>
          <Descriptions
            className="break-all"
            align="left"
            data={[
              { key: '用户 ID', value: selected.id },
              { key: '昵称', value: selected.name },
              { key: '邮箱地址', value: selected.email },
              { key: '角色', value: selected.role === 'ADMIN' ? '管理员' : '普通用户' },
              { key: '账号状态', value: selected.status === 'ACTIVE' ? '已启用' : '已停用' },
              { key: '注册时间', value: formatDate(selected.createdAt, true) },
              { key: '更新时间', value: formatDate(selected.updatedAt, true) },
            ]}
          />
          <div className="mt-6 flex justify-end">
            <Button onClick={onClose}>关闭</Button>
          </div>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)} aria-busy={saving}>
          <fieldset disabled={saving} className="space-y-5">
            {state.kind === 'status' && selected ? (
              <div className="space-y-3">
                <p>
                  确定{selected.status === 'ACTIVE' ? '停用' : '启用'}{' '}
                  <strong>{selected.name}</strong> 的账号？
                </p>
                <p className="text-sm leading-6 text-muted">
                  {selected.status === 'ACTIVE'
                    ? '停用后将撤销该用户的全部登录会话，用户无法继续登录。'
                    : '启用后用户可以重新登录，之前的会话不会恢复。'}
                </p>
              </div>
            ) : (
              <>
                <label className="block space-y-2 text-sm font-medium" htmlFor="user-name">
                  昵称
                  <Input
                    id="user-name"
                    name="name"
                    autoFocus
                    value={name}
                    onChange={setName}
                    disabled={saving}
                    required
                    maxLength={80}
                  />
                </label>
                <label className="block space-y-2 text-sm font-medium" htmlFor="user-email">
                  邮箱地址
                  <Input
                    id="user-email"
                    name="email"
                    type="email"
                    value={email}
                    onChange={setEmail}
                    disabled={saving}
                    required
                    maxLength={254}
                  />
                </label>
                {state.kind === 'create' && (
                  <label className="block space-y-2 text-sm font-medium" htmlFor="user-password">
                    初始密码
                    <Input
                      id="user-password"
                      name="password"
                      aria-label="初始密码"
                      mode="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={setPassword}
                      disabled={saving}
                      required
                      minLength={12}
                      maxLength={128}
                      aria-describedby="new-password-help"
                    />
                    <span id="new-password-help" className="text-xs text-muted">
                      密码长度为 12–128 个字符。
                    </span>
                  </label>
                )}
                <div className="space-y-2 text-sm font-medium">
                  <label id="user-role-label" htmlFor="user-role">
                    角色
                  </label>
                  <Select
                    className="w-full"
                    aria-labelledby="user-role-label"
                    id="user-role"
                    value={role}
                    disabled={isSelf || saving}
                    onChange={(value) => setRole(value === 'ADMIN' ? 'ADMIN' : 'USER')}
                    optionList={[
                      { value: 'USER', label: '普通用户' },
                      { value: 'ADMIN', label: '管理员' },
                    ]}
                  />
                </div>
                {state.kind === 'edit' && (
                  <div className="space-y-2 text-sm font-medium">
                    <label id="user-status-label" htmlFor="user-status">
                      账号状态
                    </label>
                    <Select
                      className="w-full"
                      aria-labelledby="user-status-label"
                      id="user-status"
                      value={status}
                      disabled={isSelf || saving}
                      onChange={(value) => setStatus(value === 'DISABLED' ? 'DISABLED' : 'ACTIVE')}
                      optionList={[
                        { value: 'ACTIVE', label: '已启用' },
                        { value: 'DISABLED', label: '已停用' },
                      ]}
                    />
                  </div>
                )}
                {isSelf && (
                  <p className="text-xs text-muted">不能停用自己或移除自己的管理员权限。</p>
                )}
                {selected && (
                  <p className="text-xs text-muted">修改邮箱或角色后，该用户需要重新登录。</p>
                )}
              </>
            )}
            {error && (
              <div role="alert">
                <Banner type="danger" description={error} closeIcon={null} />
              </div>
            )}
            <div className="flex justify-end gap-3 border-t border-line pt-5">
              <Button htmlType="button" disabled={saving} onClick={onClose}>
                取消
              </Button>
              <Button
                htmlType="submit"
                theme="solid"
                loading={saving}
                disabled={saving}
                type={
                  state.kind === 'status' && selected?.status === 'ACTIVE' ? 'danger' : 'primary'
                }
              >
                {saving
                  ? '保存中…'
                  : state.kind === 'status'
                    ? '确认'
                    : state.kind === 'create'
                      ? '创建用户'
                      : '保存修改'}
              </Button>
            </div>
          </fieldset>
        </form>
      )}
    </Modal>
  );
}
