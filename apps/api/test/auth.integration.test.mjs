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
import prismaConfig from '../prisma.config.mjs';

const require = createRequire(import.meta.url);
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
    assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'email', 'id', 'name']);
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

  await t.test('repeated login attempts are rate limited', async () => {
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
