import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError,
  createUser,
  getCurrentUser,
  getHealth,
  listUsers,
  login,
  logout,
  updateUser,
} from '../src/services/api.ts';

const user = {
  id: 'cf44a477-9d24-4ee6-96eb-4b00b89aa95e',
  email: 'user@example.com',
  name: '测试用户',
  role: 'USER',
  createdAt: '2026-11-05T00:00:00.000Z',
};
const managedUser = { ...user, status: 'ACTIVE', updatedAt: user.createdAt };
const credentials = { email: user.email, password: 'a sufficiently long password' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('login uses the contract route and strips fields outside the public schema', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', (path, options) => {
    assert.equal(path, '/api/auth/login');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.signal, controller.signal);
    assert.equal(options.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), credentials);
    return Promise.resolve(json({ user: { ...user, passwordHash: 'must not reach the screen' } }));
  });
  assert.deepEqual(await login(credentials, controller.signal), user);
});

test('only the current-user endpoint translates 401 into a signed-out state', async (t) => {
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(json({ message: '请先登录' }, 401)));
  const signal = new AbortController().signal;
  assert.equal(await getCurrentUser(signal), null);
  await assert.rejects(
    login(credentials, signal),
    (error) => error instanceof ApiError && error.status === 401 && error.message === '请先登录',
  );
});

test('validation, throttling and non-JSON service errors retain user-facing messages', async (t) => {
  const signal = new AbortController().signal;
  for (const [response, status, message] of [
    [json({ message: ['邮箱无效', '昵称为空'] }, 400), 400, '邮箱无效；昵称为空'],
    [json({ message: 'Too many requests' }, 429), 429, '操作太频繁，请稍后重试'],
    [new Response('upstream unavailable', { status: 502 }), 502, '服务暂时不可用，请稍后重试'],
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', () => Promise.resolve(response));
    await assert.rejects(
      login(credentials, signal),
      (error) => error instanceof ApiError && error.status === status && error.message === message,
    );
    mock.mock.restore();
  }
});

test('malformed JSON and responses outside the schema fail with a readable error', async (t) => {
  for (const response of [
    new Response('{'),
    json({ user: { ...user, createdAt: 'not-a-date' } }),
    json({ user: { ...user, role: 'SUPERADMIN' } }),
    json({ user: { ...user, id: 42 } }),
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', () => Promise.resolve(response));
    await assert.rejects(login(credentials, new AbortController().signal), {
      message: '服务返回了无法识别的数据',
    });
    mock.mock.restore();
  }
});

test('list query omits empty screen filters and validates pagination', async (t) => {
  const list = {
    items: [managedUser],
    total: 1,
    page: 1,
    pageSize: 10,
    stats: { total: 1, active: 1, disabled: 0 },
  };
  const signal = new AbortController().signal;
  const query = { page: 1, pageSize: 10, search: '', status: '' };
  const mock = t.mock.method(globalThis, 'fetch', (path) => {
    const url = new URL(path, 'http://localhost');
    assert.equal(url.pathname, '/api/users');
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(url.searchParams.get('pageSize'), '10');
    assert.equal(url.searchParams.has('search'), false);
    assert.equal(url.searchParams.has('status'), false);
    return Promise.resolve(json(list));
  });
  assert.deepEqual(await listUsers(query, signal), list);
  mock.mock.restore();
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(json({ ...list, pageSize: 101 })));
  await assert.rejects(listUsers(query, signal), { message: '服务返回了无法识别的数据' });
});

test('create and update use separate methods and payloads from the contract', async (t) => {
  const signal = new AbortController().signal;
  const input = { ...credentials, name: user.name, role: user.role };
  const update = {
    name: managedUser.name,
    email: managedUser.email,
    role: managedUser.role,
    status: managedUser.status,
    updatedAt: managedUser.updatedAt,
  };
  const mock = t.mock.method(globalThis, 'fetch', (path, options) => {
    assert.equal(path, '/api/users');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), input);
    return Promise.resolve(json({ user: managedUser }, 201));
  });
  assert.deepEqual(await createUser(input, signal), managedUser);
  mock.mock.restore();
  t.mock.method(globalThis, 'fetch', (path, options) => {
    assert.equal(path, `/api/users/${user.id}`);
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body), update);
    return Promise.resolve(json({ user: managedUser }));
  });
  assert.deepEqual(await updateUser(user.id, update, signal), managedUser);
});

test('logout accepts an empty 204 response and health uses the shared schema', async (t) => {
  const signal = new AbortController().signal;
  const mock = t.mock.method(globalThis, 'fetch', (path, options) => {
    assert.equal(path, '/api/auth/logout');
    assert.equal(options.method, 'POST');
    assert.equal(options.body, undefined);
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  assert.equal(await logout(signal), undefined);
  mock.mock.restore();
  const health = { status: 'ok', service: '@repo/api', timestamp: user.createdAt };
  t.mock.method(globalThis, 'fetch', (path) => {
    assert.equal(path, '/api/health');
    return Promise.resolve(json(health));
  });
  assert.deepEqual(await getHealth(signal), health);
});

test('request cancellation propagates the AbortError', async (t) => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, 'fetch', (_path, options) => {
    assert.equal(options.signal, controller.signal);
    return Promise.reject(options.signal.reason);
  });
  await assert.rejects(getCurrentUser(controller.signal), { name: 'AbortError' });
});
