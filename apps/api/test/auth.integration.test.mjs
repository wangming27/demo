import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { verify } from 'argon2';
import { initClient } from '@ts-rest/core';
import prismaConfig from '../prisma.config.mjs';

const require = createRequire(import.meta.url);
const { apiContract, HealthResponseSchema, PublicUserSchema } = require('@repo/contracts');
const { PrismaClient } = require('../.test-dist/generated/prisma/client.js');
const apiDir = resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:5173';
const schema = `auth_test_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = prismaConfig.datasource?.url;
assert.notEqual(
  process.env.NODE_ENV,
  'production',
  'Integration tests are for local/test environments',
);
assert.ok(databaseUrl, 'Configure a local database before running integration tests');
const testUrl = new URL(databaseUrl);
testUrl.searchParams.set('schema', schema);
const admin = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: testUrl.toString() }, { schema }),
});

let child;
let childExit;
let baseUrl;
let schemaCreated = false;
let cookie;
let userId;
const email = `auth-${randomUUID()}@example.com`;
const password = 'A long integration password 42!';

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function sessionCookie(response) {
  const header = response.headers.getSetCookie().find((entry) => entry.startsWith('demo_session='));
  assert.ok(header, 'Authentication must set a session cookie');
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Lax/i);
  assert.match(header, /Path=\//i);
  assert.match(header, /Max-Age=604800/i);
  assert.doesNotMatch(header, /;\s*Secure/i);
  return header.split(';')[0];
}

function tokenHash(value) {
  return createHash('sha256')
    .update(value.slice(value.indexOf('=') + 1))
    .digest('hex');
}

async function post(path, input, currentCookie, requestOrigin = origin) {
  return fetch(`${baseUrl}/api/auth/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(requestOrigin ? { Origin: requestOrigin } : {}),
      ...(currentCookie ? { Cookie: currentCookie } : {}),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
}

async function me(currentCookie) {
  return fetch(`${baseUrl}/api/auth/me`, {
    headers: currentCookie ? { Cookie: currentCookie } : {},
  });
}

before(
  async () => {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const port = await availablePort();
    const environment = {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: testUrl.toString(),
      AUTH_ALLOWED_ORIGINS: origin,
    };
    execFileSync(
      process.execPath,
      [resolve(apiDir, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      { cwd: apiDir, env: environment, stdio: 'pipe', timeout: 30_000 },
    );
    child = spawn(process.execPath, [resolve(apiDir, '.test-dist/main.js')], {
      cwd: apiDir,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    childExit = once(child, 'exit');
    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(
        () => reject(new Error(`API startup timed out: ${output}`)),
        20_000,
      );
      const fail = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      child.once('error', fail);
      child.once('exit', (code) => fail(new Error(`API exited (${code}): ${output}`)));
      const read = (chunk) => {
        output += chunk.toString();
        if (output.includes('API ready at')) {
          clearTimeout(timeout);
          resolve();
        }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
    });
    baseUrl = `http://127.0.0.1:${port}`;
  },
  { timeout: 60_000 },
);

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await childExit;
  }
  await prisma.$disconnect();
  try {
    if (schemaCreated) {
      // Only the randomly named schema created by this test is removed.
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  } finally {
    await admin.$disconnect();
  }
});

test('registration, authentication and session lifecycle', async (t) => {
  await t.test('anonymous requests cannot access the current user', async () => {
    assert.equal((await me()).status, 401);
    assert.equal((await me('demo_session=malformed')).status, 401);
  });

  await t.test('unsafe requests require an explicitly allowed origin', async () => {
    const input = { name: '测试账号', email, password };
    assert.equal((await post('register', input, undefined, null)).status, 403);
    assert.equal(
      (await post('register', input, undefined, 'https://untrusted.example')).status,
      403,
    );
  });

  await t.test(
    'validation rejects invalid emails, short passwords and unexpected fields',
    async () => {
      assert.equal(
        (await post('register', { name: '测试账号', email: 'invalid', password })).status,
        400,
      );
      assert.equal(
        (await post('register', { name: '测试账号', email, password: 'short' })).status,
        400,
      );
      assert.equal(
        (await post('register', { name: '测试账号', email, password, status: 'ACTIVE' })).status,
        400,
      );
    },
  );

  await t.test('registration normalizes input, hashes the password and signs in', async () => {
    const response = await post('register', {
      name: ' 测试账号 ',
      email: ` ${email.toUpperCase()} `,
      password,
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    cookie = sessionCookie(response);
    const { user } = await response.json();
    assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'email', 'id', 'name', 'role']);
    assert.equal(user.role, 'USER');
    assert.equal(user.email, email);
    assert.equal(user.name, '测试账号');
    userId = user.id;
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert.match(stored.passwordHash, /^\$argon2id\$/);
    assert.equal(await verify(stored.passwordHash, password), true);
    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: tokenHash(cookie) },
    });
    assert.equal(session.userId, userId);
    assert.notEqual(session.tokenHash, cookie.slice(cookie.indexOf('=') + 1));
  });

  await t.test('duplicate emails are rejected regardless of letter case', async () => {
    const response = await post('register', {
      name: '重复账号',
      email: email.toUpperCase(),
      password,
    });
    assert.equal(response.status, 409);
    assert.equal(await prisma.user.count({ where: { email } }), 1);
  });

  await t.test(
    'concurrent registration is protected by the database unique constraint',
    async () => {
      const input = { name: '并发账号', email: `race-${randomUUID()}@example.com`, password };
      const responses = await Promise.all([post('register', input), post('register', input)]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
      assert.equal(await prisma.user.count({ where: { email: input.email } }), 1);
    },
  );

  await t.test('a new request restores the signed-in user from the cookie', async () => {
    const response = await me(cookie);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.id, userId);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  await t.test(
    'unknown accounts and wrong passwords have the same authentication error',
    async () => {
      const wrong = await post('login', { email, password: 'A completely wrong password!' });
      const unknown = await post('login', { email: `missing-${email}`, password });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.equal((await wrong.json()).message, (await unknown.json()).message);
    },
  );

  await t.test('login rotates the token and revokes the previous browser session', async () => {
    const previous = cookie;
    const response = await post('login', { email, password }, previous);
    assert.equal(response.status, 200);
    cookie = sessionCookie(response);
    assert.notEqual(cookie, previous);
    assert.equal((await me(previous)).status, 401);
    assert.equal((await me(cookie)).status, 200);
  });

  await t.test('disabled accounts cannot authenticate or use existing sessions', async () => {
    await prisma.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
    assert.equal((await me(cookie)).status, 401);
    assert.equal((await post('login', { email, password })).status, 401);
    await prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
  });

  await t.test('expired sessions are rejected', async () => {
    await prisma.session.update({
      where: { tokenHash: tokenHash(cookie) },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    assert.equal((await me(cookie)).status, 401);
    const response = await post('login', { email, password }, cookie);
    assert.equal(response.status, 200);
    cookie = sessionCookie(response);
  });

  await t.test(
    'logout clears the cookie and revokes the session; repeated logout is harmless',
    async () => {
      const response = await post('logout', undefined, cookie);
      assert.equal(response.status, 204);
      assert.match(response.headers.get('set-cookie'), /demo_session=;/);
      assert.equal((await me(cookie)).status, 401);
      assert.equal(await prisma.session.count({ where: { tokenHash: tokenHash(cookie) } }), 0);
      assert.equal((await post('logout', undefined, cookie)).status, 204);
    },
  );

  await t.test('malformed and oversized JSON bodies are rejected', async () => {
    const malformed = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    const oversized = await post('login', { email, password: 'a'.repeat(20_000) });
    assert.equal(oversized.status, 413);
  });

  await t.test('production uses a Secure HttpOnly cookie with the __Host prefix', () => {
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        "const { getEnvironment } = require('./.test-dist/config/environment.js'); const { cookieOptions } = require('./.test-dist/auth/session.js'); console.log(JSON.stringify({ name: getEnvironment().cookieName, options: cookieOptions() }));",
      ],
      {
        cwd: apiDir,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DATABASE_URL: testUrl.toString(),
          AUTH_ALLOWED_ORIGINS: 'https://app.example.com',
        },
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5_000,
      },
    );
    assert.deepEqual(JSON.parse(output), {
      name: '__Host-demo_session',
      options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
    });
  });

  await t.test('production configuration rejects HTTP frontend origins', () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ['-e', "require('./.test-dist/config/environment.js').getEnvironment();"],
          {
            cwd: apiDir,
            env: {
              ...process.env,
              NODE_ENV: 'production',
              DATABASE_URL: testUrl.toString(),
              AUTH_ALLOWED_ORIGINS: origin,
            },
            stdio: 'pipe',
            timeout: 5_000,
          },
        ),
      (error) => error.status === 1 && error.stderr.toString().includes('use HTTPS in production'),
    );
  });
});

test('administrator user management', async (t) => {
  const { createToken } = require('../.test-dist/auth/session.js');
  const original = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const administrator = await prisma.user.create({
    data: {
      name: '管理员',
      email: `admin-${randomUUID()}@example.com`,
      role: 'ADMIN',
      passwordHash: original.passwordHash,
    },
  });

  async function fixtureCookie(id) {
    const token = createToken();
    const value = `demo_session=${token}`;
    await prisma.session.create({
      data: { userId: id, tokenHash: tokenHash(value), expiresAt: new Date(Date.now() + 60_000) },
    });
    return value;
  }
  const adminCookie = await fixtureCookie(administrator.id);
  const ordinaryCookie = await fixtureCookie(userId);
  let managed;
  const managedEmail = `managed-${randomUUID()}@example.com`;

  async function users(
    path = '',
    method = 'GET',
    input,
    currentCookie = adminCookie,
    requestOrigin = origin,
  ) {
    return fetch(`${baseUrl}/api/users${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(currentCookie ? { Cookie: currentCookie } : {}),
        ...(requestOrigin ? { Origin: requestOrigin } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
  }
  function updateInput(user, changes = {}) {
    return {
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      updatedAt: new Date(user.updatedAt).toISOString(),
      ...changes,
    };
  }

  await t.test(
    'anonymous and ordinary accounts cannot list, read, create or update users',
    async () => {
      assert.equal((await users('', 'GET', undefined, null)).status, 401);
      for (const [path, method, input] of [
        ['', 'GET'],
        [`/${userId}`, 'GET'],
        ['', 'POST', { name: '越权', email: managedEmail, password }],
        [`/${userId}`, 'PATCH', updateInput(original, { role: 'ADMIN' })],
      ]) {
        assert.equal((await users(path, method, input, ordinaryCookie)).status, 403);
      }
      assert.equal(
        (await post('register', { name: '越权注册', email: managedEmail, password, role: 'ADMIN' }))
          .status,
        400,
      );
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).role, 'USER');
    },
  );

  await t.test('query validation caps pagination and rejects invalid filters and IDs', async () => {
    for (const query of [
      '?page=0',
      '?page=1.5',
      '?pageSize=101',
      '?pageSize=-1',
      '?status=unknown',
      '?search=' + 'a'.repeat(101),
      '?unexpected=true',
    ]) {
      assert.equal((await users(query)).status, 400);
    }
    assert.equal((await users('/not-a-uuid')).status, 400);
    assert.equal((await users(`/${randomUUID()}`)).status, 404);
  });

  await t.test(
    'administrator creation hashes passwords and does not create a session',
    async () => {
      const initialSessions = await prisma.session.count();
      const input = { name: ' 管理测试用户 ', email: ` ${managedEmail.toUpperCase()} `, password };
      assert.equal((await users('', 'POST', input, adminCookie, null)).status, 403);
      assert.equal((await users('', 'POST', { ...input, password: 'short' })).status, 400);
      const response = await users('', 'POST', input);
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('set-cookie'), null);
      managed = (await response.json()).user;
      assert.deepEqual(Object.keys(managed).sort(), [
        'createdAt',
        'email',
        'id',
        'name',
        'role',
        'status',
        'updatedAt',
      ]);
      assert.equal(managed.email, managedEmail);
      assert.equal(managed.name, '管理测试用户');
      assert.equal(managed.role, 'USER');
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: managed.id } });
      assert.equal(await verify(stored.passwordHash, password), true);
      assert.equal(await prisma.session.count(), initialSessions);
      assert.equal((await users('', 'POST', input)).status, 409);
    },
  );

  await t.test(
    'listing searches case insensitively, filters status, paginates and excludes secrets',
    async () => {
      await prisma.user.createMany({
        data: Array.from({ length: 12 }, (_, index) => ({
          name: `分页测试 ${index}`,
          email: `page-${index}-${randomUUID()}@example.com`,
          passwordHash: original.passwordHash,
          status: index === 11 ? 'DISABLED' : 'ACTIVE',
        })),
      });
      const response = await users('?page=1&pageSize=10');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const first = await response.json();
      const second = await (await users('?page=2&pageSize=10')).json();
      assert.equal(first.items.length, 10);
      assert.equal(
        new Set([...first.items, ...second.items].map((user) => user.id)).size,
        first.total,
      );
      assert.equal(first.stats.total, await prisma.user.count());
      assert.equal(first.stats.active + first.stats.disabled, first.stats.total);
      for (const user of first.items)
        assert.deepEqual(Object.keys(user).sort(), Object.keys(managed).sort());
      const match = await (
        await users(`?search=${encodeURIComponent(managedEmail.toUpperCase())}`)
      ).json();
      assert.equal(match.total, 1);
      assert.equal(match.items[0].id, managed.id);
      const disabled = await (
        await users('?status=DISABLED&search=' + encodeURIComponent('分页测试'))
      ).json();
      assert.equal(disabled.total, 1);
      assert.equal(disabled.items[0].status, 'DISABLED');
      const empty = await (await users('?page=100&search=no-such-user')).json();
      assert.equal(empty.total, 0);
      assert.equal(empty.page, 1);
      assert.deepEqual(empty.items, []);
      assert.equal((await (await users(`/${managed.id}`)).json()).user.id, managed.id);
    },
  );

  await t.test('editing enforces origin, email uniqueness and optimistic concurrency', async () => {
    assert.equal(
      (
        await users(
          `/${managed.id}`,
          'PATCH',
          updateInput(managed),
          adminCookie,
          'https://untrusted.example',
        )
      ).status,
      403,
    );
    assert.equal(
      (await users(`/${managed.id}`, 'PATCH', updateInput(managed, { email: email.toUpperCase() })))
        .status,
      409,
    );
    assert.equal((await users(`/${randomUUID()}`, 'PATCH', updateInput(managed))).status, 404);
    assert.equal(
      (
        await users(`/${managed.id}`, 'PATCH', {
          ...updateInput(managed),
          passwordHash: 'override',
        })
      ).status,
      400,
    );
    const previous = managed;
    const response = await users(
      `/${managed.id}`,
      'PATCH',
      updateInput(managed, { name: '修改后用户' }),
    );
    assert.equal(response.status, 200);
    managed = (await response.json()).user;
    assert.equal(managed.name, '修改后用户');
    assert.equal(
      (await users(`/${managed.id}`, 'PATCH', updateInput(previous, { name: '过期覆盖' }))).status,
      409,
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: managed.id } })).name,
      '修改后用户',
    );
  });

  await t.test('disabling revokes every session and enabling never restores them', async () => {
    const one = await fixtureCookie(managed.id);
    const two = await fixtureCookie(managed.id);
    assert.equal((await me(one)).status, 200);
    const disabled = await users(
      `/${managed.id}`,
      'PATCH',
      updateInput(managed, { status: 'DISABLED' }),
    );
    assert.equal(disabled.status, 200);
    managed = (await disabled.json()).user;
    assert.equal(await prisma.session.count({ where: { userId: managed.id } }), 0);
    assert.equal((await me(one)).status, 401);
    assert.equal((await me(two)).status, 401);
    assert.equal((await post('login', { email: managedEmail, password })).status, 401);
    const enabled = await users(
      `/${managed.id}`,
      'PATCH',
      updateInput(managed, { status: 'ACTIVE' }),
    );
    assert.equal(enabled.status, 200);
    managed = (await enabled.json()).user;
    assert.equal((await me(one)).status, 401);
    assert.equal((await post('login', { email: managedEmail, password })).status, 200);
  });

  await t.test('self-disable and self-demotion are rejected', async () => {
    assert.equal(
      (
        await users(
          `/${administrator.id}`,
          'PATCH',
          updateInput(administrator, { status: 'DISABLED' }),
        )
      ).status,
      409,
    );
    assert.equal(
      (await users(`/${administrator.id}`, 'PATCH', updateInput(administrator, { role: 'USER' })))
        .status,
      409,
    );
    assert.equal((await users('', 'GET')).status, 200);
  });

  await t.test('role changes revoke sessions and new sessions use the new role', async () => {
    const previous = await fixtureCookie(managed.id);
    const promoted = await users(
      `/${managed.id}`,
      'PATCH',
      updateInput(managed, { role: 'ADMIN' }),
    );
    assert.equal(promoted.status, 200);
    managed = (await promoted.json()).user;
    assert.equal((await me(previous)).status, 401);
    const elevated = await fixtureCookie(managed.id);
    assert.equal((await users('', 'GET', undefined, elevated)).status, 200);
    const demoted = await users(`/${managed.id}`, 'PATCH', updateInput(managed, { role: 'USER' }));
    assert.equal(demoted.status, 200);
    managed = (await demoted.json()).user;
    assert.equal((await users('', 'GET', undefined, elevated)).status, 401);
    assert.equal((await users('', 'GET', undefined, await fixtureCookie(managed.id))).status, 403);
  });

  await t.test('concurrent administrators cannot remove all active administrators', async () => {
    const other = await prisma.user.create({
      data: {
        name: '第二管理员',
        email: `other-admin-${randomUUID()}@example.com`,
        role: 'ADMIN',
        passwordHash: original.passwordHash,
      },
    });
    const otherCookie = await fixtureCookie(other.id);
    const responses = await Promise.all([
      users(`/${other.id}`, 'PATCH', updateInput(other, { role: 'USER' })),
      users(
        `/${administrator.id}`,
        'PATCH',
        updateInput(administrator, { role: 'USER' }),
        otherCookie,
      ),
    ]);
    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    assert.ok(
      responses.every((response) => [200, 401, 403, 409].includes(response.status)),
      JSON.stringify(
        await Promise.all(
          responses.map(async (response) => ({
            status: response.status,
            body: await response.json(),
          })),
        ),
      ),
    );
    assert.equal(await prisma.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } }), 1);
  });
});

test('repeated login attempts are rate limited', async () => {
  let limited = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await post('login', { email, password: 'A wrong password for rate limits' });
    if (response.status === 429) {
      limited = true;
      break;
    }
    assert.equal(response.status, 401);
  }
  assert.equal(limited, true);
});

test('shared client and server agree on routes, response schemas and error bodies', async () => {
  const client = initClient(apiContract, {
    baseUrl,
    baseHeaders: { Origin: origin },
    validateResponse: true,
  });
  const health = await client.health.get();
  assert.equal(health.status, 200);
  assert.equal(HealthResponseSchema.safeParse(health.body).success, true);
  const anonymous = await client.auth.me();
  assert.equal(anonymous.status, 401);
  assert.equal(typeof anonymous.body.message, 'string');

  const { createToken } = require('../.test-dist/auth/session.js');
  const value = `demo_session=${createToken()}`;
  await prisma.session.create({
    data: { userId, tokenHash: tokenHash(value), expiresAt: new Date(Date.now() + 60_000) },
  });
  try {
    const current = await client.auth.me({ extraHeaders: { Cookie: value } });
    assert.equal(current.status, 200);
    assert.equal(PublicUserSchema.safeParse(current.body.user).success, true);
    assert.equal(current.body.user.id, userId);
    assert.equal(typeof current.body.user.createdAt, 'string');
    const forbidden = await client.users.list({
      query: { page: 1, pageSize: 10 },
      extraHeaders: { Cookie: value },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(typeof forbidden.body.message, 'string');
  } finally {
    await prisma.session.deleteMany({ where: { tokenHash: tokenHash(value) } });
  }
});

test('shared client rejects responses that violate the contract', async (t) => {
  t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ status: 'ok', service: '@repo/api', timestamp: 'not-a-date' }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
  const client = initClient(apiContract, {
    baseUrl: '',
    baseHeaders: {},
    validateResponse: true,
  });
  await assert.rejects(
    client.health.get(),
    (error) =>
      error.name === 'ZodError' && error.issues.some((issue) => issue.path[0] === 'timestamp'),
  );
});
