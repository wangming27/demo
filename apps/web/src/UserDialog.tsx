import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, saveUser } from './api';
import type { ManagedUser, User } from './api';
import Icon from './Icon';
import { formatDate } from './user-format';

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
  const dialogRef = useRef<HTMLDialogElement>(null);
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

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      requestRef.current?.abort();
      dialog?.close();
    };
  }, []);

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
          ? await saveUser(null, { name, email, password, role }, controller.signal)
          : selected &&
            (await saveUser(
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
    <dialog
      ref={dialogRef}
      className="user-dialog"
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" disabled={saving} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {state.kind === 'detail' && selected ? (
        <>
          <dl className="detail-list">
            <div>
              <dt>用户 ID</dt>
              <dd>{selected.id}</dd>
            </div>
            <div>
              <dt>昵称</dt>
              <dd>{selected.name}</dd>
            </div>
            <div>
              <dt>邮箱地址</dt>
              <dd>{selected.email}</dd>
            </div>
            <div>
              <dt>角色</dt>
              <dd>{selected.role === 'ADMIN' ? '管理员' : '普通用户'}</dd>
            </div>
            <div>
              <dt>账号状态</dt>
              <dd>{selected.status === 'ACTIVE' ? '已启用' : '已停用'}</dd>
            </div>
            <div>
              <dt>注册时间</dt>
              <dd>{formatDate(selected.createdAt, true)}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{formatDate(selected.updatedAt, true)}</dd>
            </div>
          </dl>
          <div className="dialog-actions">
            <button className="secondary-button" onClick={onClose}>
              关闭
            </button>
          </div>
        </>
      ) : (
        <form
          className="auth-form dialog-form"
          onSubmit={(event) => void submit(event)}
          aria-busy={saving}
        >
          <fieldset disabled={saving}>
            {state.kind === 'status' && selected ? (
              <div className="confirm-message">
                <p>
                  确定{selected.status === 'ACTIVE' ? '停用' : '启用'}{' '}
                  <strong>{selected.name}</strong> 的账号？
                </p>
                <p className="muted">
                  {selected.status === 'ACTIVE'
                    ? '停用后将撤销该用户的全部登录会话，用户无法继续登录。'
                    : '启用后用户可以重新登录，之前的会话不会恢复。'}
                </p>
              </div>
            ) : (
              <>
                <label htmlFor="user-name">
                  昵称
                  <input
                    id="user-name"
                    name="name"
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={80}
                  />
                </label>
                <label htmlFor="user-email">
                  邮箱地址
                  <input
                    id="user-email"
                    name="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    maxLength={254}
                  />
                </label>
                {state.kind === 'create' && (
                  <label htmlFor="user-password">
                    初始密码
                    <input
                      id="user-password"
                      name="password"
                      aria-label="初始密码"
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      minLength={12}
                      maxLength={128}
                      aria-describedby="new-password-help"
                    />
                    <span id="new-password-help" className="muted">
                      密码长度为 12–128 个字符。
                    </span>
                  </label>
                )}
                <label htmlFor="user-role">
                  角色
                  <select
                    id="user-role"
                    value={role}
                    disabled={isSelf}
                    onChange={(event) => setRole(event.target.value === 'ADMIN' ? 'ADMIN' : 'USER')}
                  >
                    <option value="USER">普通用户</option>
                    <option value="ADMIN">管理员</option>
                  </select>
                </label>
                {state.kind === 'edit' && (
                  <label htmlFor="user-status">
                    账号状态
                    <select
                      id="user-status"
                      value={status}
                      disabled={isSelf}
                      onChange={(event) =>
                        setStatus(event.target.value === 'DISABLED' ? 'DISABLED' : 'ACTIVE')
                      }
                    >
                      <option value="ACTIVE">已启用</option>
                      <option value="DISABLED">已停用</option>
                    </select>
                  </label>
                )}
                {isSelf && <p className="field-help">不能停用自己或移除自己的管理员权限。</p>}
                {selected && <p className="field-help">修改邮箱或角色后，该用户需要重新登录。</p>}
              </>
            )}
            {error && (
              <p className="error form-message" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={onClose}>
                取消
              </button>
              <button
                type="submit"
                className={
                  state.kind === 'status' && selected?.status === 'ACTIVE'
                    ? 'danger-button'
                    : 'primary-button'
                }
              >
                {saving
                  ? '保存中…'
                  : state.kind === 'status'
                    ? '确认'
                    : state.kind === 'create'
                      ? '创建用户'
                      : '保存修改'}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </dialog>
  );
}
