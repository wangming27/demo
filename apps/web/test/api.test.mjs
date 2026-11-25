import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError,
  createUser,
  getCurrentUser,
  getHealth,
  listUsers,
  listChatHistory,
  login,
  logout,
  sendChat,
  streamChat,
  updateUser,
} from '../src/services/api.ts';
import { historyMessages, contextMessages } from '../src/pages/chat/chat-history.ts';
import { subscribeChatRequests } from '../src/services/chat-events.ts';
import { readChatDebug } from '../src/features/chat-debug/api.ts';
import {
  DEFAULT_HISTORY_ROUNDS,
  MAX_HISTORY_ROUNDS,
  loadChatSettings,
  saveChatSettings,
} from '../src/pages/chat/chat-settings.ts';

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

const streamInput = { modelId: user.id, messages: [{ role: 'user', content: '流式测试' }] };
const timing = {
  elapsedMs: 100,
  firstResponseMs: 10,
  phase: 'done',
  thoughts: [],
  tools: [],
};

test('debug observers and independent reads cannot fail or delay a completed chat', async (t) => {
  const input = { ...streamInput, requestId: user.id };
  const observed = [];
  let debugRead;
  t.after(
    subscribeChatRequests(() => {
      throw new Error('observer failed');
    }),
  );
  t.after(
    subscribeChatRequests((event) => {
      observed.push(event);
      if (event.type === 'finished') {
        debugRead = readChatDebug(event.requestId, new AbortController().signal).catch(
          (error) => error,
        );
      }
    }),
  );
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    if (path === `/api/chat-debug/${user.id}`) {
      assert.equal(options.credentials, 'same-origin');
      return new Response('debug unavailable', { status: 503 });
    }
    assert.equal(path, '/api/chat/stream');
    assert.equal('debug' in JSON.parse(options.body), false);
    return new Response(sseFrame({ type: 'done', answer: { content: '回答' }, timing }), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  const result = await streamChat(input, new AbortController().signal, () => {});
  assert.equal(result.answer.content, '回答');
  assert.deepEqual(
    observed.map((event) => event.type),
    ['started', 'finished'],
  );
  assert.equal(observed.at(-1).status, 'success');
  assert.match((await debugRead).message, /调试记录读取失败/);
});
const sseFrame = (event) => `data: ${JSON.stringify(event)}\r\n\r\n`;
test('stream client delivers split UTF8 output before done and releases its reader', async (t) => {
  let enqueue;
  let cancelled = false;
  let partial;
  const observed = new Promise((resolve) => {
    partial = resolve;
  });
  const stream = new ReadableStream({
    start(controller) {
      enqueue = (text) => controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      cancelled = true;
    },
  });
  const signal = new AbortController().signal;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/chat/stream');
    assert.equal(options.signal, signal);
    assert.equal(options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(options.body), streamInput);
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  let settled = false;
  const events = [];
  const pending = streamChat(streamInput, signal, (event) => {
    events.push(event);
    if (event.type === 'delta') partial();
  }).then((event) => {
    settled = true;
    return event;
  });
  enqueue(sseFrame({ type: 'delta', round: 1, reasoning: '思考' }));
  await observed;
  assert.equal(settled, false);
  enqueue(sseFrame({ type: 'done', answer: { content: '回答' }, timing }));
  assert.equal((await pending).answer.content, '回答');
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  assert.equal(events.length, 2);
});

test('stream client handles byte fragments, malformed data, truncation, errors and cancellation', async (t) => {
  for (const [text, expected] of [
    [
      sseFrame({ type: 'delta', round: 1, content: '中文' }) +
        sseFrame({ type: 'done', answer: { content: '中文' }, timing }),
      '中文',
    ],
    [sseFrame({ type: 'delta', round: 1, content: '部分回复' }), null],
    ['data: {bad}\n\n', null],
    [sseFrame({ type: 'error', message: '模型失败', status: 502, timing }), 502],
    [sseFrame({ type: 'state', timing: { ...timing, elapsedMs: -1 } }), null],
  ]) {
    const stream = new ReadableStream({
      start(controller) {
        for (const byte of new TextEncoder().encode(text)) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const mock = t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    const pending = streamChat(streamInput, new AbortController().signal, () => {});
    if (expected === '中文') assert.equal((await pending).answer.content, '中文');
    else
      await assert.rejects(pending, (error) =>
        expected === 502
          ? error instanceof ApiError && error.status === 502
          : error instanceof Error,
      );
    assert.equal(stream.locked, false);
    mock.mock.restore();
  }
  const controller = new AbortController();
  const stream = new ReadableStream({
    start(reader) {
      reader.enqueue(
        new TextEncoder().encode(sseFrame({ type: 'delta', round: 1, content: '部分回复' })),
      );
    },
  });
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
  );
  await assert.rejects(
    streamChat(streamInput, controller.signal, () => controller.abort()),
    { name: 'AbortError' },
  );
  assert.equal(stream.locked, false);
  mock.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => json({ message: '请先登录' }, 401));
  await assert.rejects(
    streamChat(streamInput, new AbortController().signal, () => {}),
    (error) => error instanceof ApiError && error.status === 401,
  );
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

test('chat preserves reasoning separately and still accepts answers without it', async (t) => {
  const signal = new AbortController().signal;
  const input = {
    modelId: user.id,
    messages: [{ role: 'user', content: '请回答' }],
    webSearch: true,
  };
  for (const response of [
    { content: '最终回答', reasoning: '第一步。\n第二步。' },
    { content: '普通回答' },
    {
      content: '联网回答',
      reasoning: '搜索资料',
      sources: [{ title: '来源', url: 'https://example.com' }],
      searchWarning: '部分查询失败',
    },
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', (path, options) => {
      assert.equal(path, '/api/chat/completions');
      assert.deepEqual(JSON.parse(options.body), input);
      return Promise.resolve(json(response));
    });
    assert.deepEqual(await sendChat(input, signal), response);
    mock.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(json({ content: '回答', reasoning: 42 })),
  );
  await assert.rejects(sendChat(input, signal), { message: '服务返回了无法识别的数据' });
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

test('chat history uses an optional cursor, validates each page and preserves abort signals', async (t) => {
  const signal = new AbortController().signal;
  const fixture = {
    items: [
      {
        id: user.id,
        conversationId: user.id,
        query: '历史问题',
        createdAt: user.createdAt,
        status: 'SUCCEEDED',
        model: { id: user.id, name: '模型' },
        resources: [],
        reply: {
          id: user.id,
          content: '历史回答',
          reasoningContent: '历史思考内容',
          isFinal: true,
        },
        durationMs: 100,
      },
    ],
    nextCursor: null,
  };
  let cursor = null;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    const url = new URL(path, 'http://localhost');
    assert.equal(url.pathname, '/api/chat/histories/feed');
    assert.equal(url.searchParams.get('cursor'), cursor);
    assert.equal(options.signal, signal);
    assert.equal(options.credentials, 'same-origin');
    return json(fixture);
  });
  assert.deepEqual(await listChatHistory(null, signal), fixture);
  cursor = user.id;
  assert.deepEqual(await listChatHistory(cursor, signal), fixture);
});

test('restored chat messages are chronological, preserve partial replies and scope bounded model context', () => {
  const item = (id, conversationId, query, content, status = 'SUCCEEDED') => ({
    id,
    conversationId,
    query,
    createdAt: user.createdAt,
    status,
    model: { id: user.id, name: '模型' },
    resources: [],
    reply: {
      id,
      content,
      reasoningContent: id === 'new' || status === 'CANCELLED' ? `思考 ${id}` : null,
      isFinal: true,
    },
    durationMs: 100,
  });
  const rows = [
    item('new', 'current', '新问题', '新回答'),
    item('failed', 'current', '失败问题', '部分正文', 'CANCELLED'),
    item('old', 'current', '旧问题', '旧回答'),
    item('other', 'other', '其他会话', '其他会话回答'),
  ];
  const messages = historyMessages(rows);
  assert.deepEqual(
    messages.map((message) => message.content),
    ['其他会话', '其他会话回答', '旧问题', '旧回答', '失败问题', '部分正文', '新问题', '新回答'],
  );
  assert.equal(messages.find((message) => message.id === 'failed:assistant').incomplete, true);
  assert.equal(messages.find((message) => message.id === 'new:assistant').reasoning, '思考 new');
  assert.equal(
    messages.find((message) => message.id === 'failed:assistant').reasoning,
    '思考 failed',
  );
  assert.equal(messages.find((message) => message.id === 'old:assistant').reasoning, undefined);
  assert.equal(messages.find((message) => message.id === 'new:user').reasoning, undefined);
  const question = { role: 'user', content: '继续' };
  assert.deepEqual(
    contextMessages(messages, 'current', question, 24).map((message) => message.content),
    ['旧问题', '旧回答', '新问题', '新回答'],
  );
  const long = historyMessages(
    Array.from({ length: 30 }, (_, index) =>
      item(String(index), 'current', '问'.repeat(1000), '答'.repeat(1000)),
    ),
  );
  const context = contextMessages(long, 'current', question, 24);
  assert.equal(context.length, 48);
  assert.ok(
    context.reduce((total, message) => total + message.content.length, question.content.length) <=
      60_000,
  );
  const imageRow = {
    ...rows[0],
    query: '',
    resources: [{ id: user.id, name: '图片.png', mime: 'image/png', bytes: 2 * 1024 * 1024 }],
  };
  const imageMessages = historyMessages([imageRow]);
  assert.equal(imageMessages[0].historyImages[0].historyId, 'new');
  assert.equal(imageMessages[0].historyImages[0].bytes, 2 * 1024 * 1024);
});

test('configured history rounds select only the latest complete turns of the current conversation', () => {
  const turn = (id, conversationId = 'current', historyEligible = true) => [
    { id: `${id}:user`, role: 'user', content: `问${id}`, conversationId, historyEligible },
    {
      id: `${id}:assistant`,
      role: 'assistant',
      content: `答${id}`,
      conversationId,
      historyEligible,
    },
  ];
  const messages = [
    ...turn('1'),
    ...turn('other', 'other'),
    ...turn('2'),
    ...turn('failed', 'current', false),
    ...turn('3'),
  ];
  const question = { role: 'user', content: '现在的问题' };
  assert.deepEqual(contextMessages(messages, 'current', question, 0), []);
  assert.deepEqual(
    contextMessages(messages, 'current', question, 1).map((message) => message.content),
    ['问3', '答3'],
  );
  assert.deepEqual(
    contextMessages(messages, 'current', question, 2).map((message) => message.content),
    ['问2', '答2', '问3', '答3'],
  );
  assert.equal(contextMessages(messages, 'current', question, MAX_HISTORY_ROUNDS).length, 6);
  assert.deepEqual(
    contextMessages([...messages, turn('incomplete')[0]], 'current', question, 2),
    [],
  );
  for (const invalid of [-1, 1.5, MAX_HISTORY_ROUNDS + 1, NaN, Infinity, '2', undefined])
    assert.deepEqual(contextMessages(messages, 'current', question, invalid), []);
});

test('configured history still respects text and image budgets without including older turns instead', () => {
  const turn = (id, content = '问题', historyImages = []) => [
    { id: `${id}:user`, role: 'user', content, conversationId: 'current', historyImages },
    { id: `${id}:assistant`, role: 'assistant', content: '回答', conversationId: 'current' },
  ];
  const messages = [...turn('old'), ...turn('new', '问'.repeat(16_001))];
  const question = { role: 'user', content: '继续' };
  assert.deepEqual(contextMessages(messages, 'current', question, 2), []);
  const withImages = [
    ...turn('old', '旧问题', [{ bytes: 6 * 1024 * 1024 }]),
    ...turn('new', '新问题', [{ bytes: 4 * 1024 * 1024 }]),
  ];
  assert.deepEqual(
    contextMessages(withImages, 'current', question, 2).map((message) => message.id),
    ['new:user', 'new:assistant'],
  );
  assert.deepEqual(contextMessages(withImages, 'current', question, 0), []);
  const long = Array.from({ length: MAX_HISTORY_ROUNDS }, (_, index) =>
    turn(String(index), '问'.repeat(16_000)),
  ).flat();
  assert.equal(contextMessages(long, 'current', question, MAX_HISTORY_ROUNDS).length, 6);
});

test('conversation settings persist per user, preserve zero and recover from invalid or blocked storage', (t) => {
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });

  assert.equal(loadChatSettings('first').historyRounds, DEFAULT_HISTORY_ROUNDS);
  assert.equal(saveChatSettings('first', { historyRounds: 3 }), true);
  assert.deepEqual(loadChatSettings('first'), { historyRounds: 3 });
  assert.equal(loadChatSettings('second').historyRounds, DEFAULT_HISTORY_ROUNDS);
  assert.equal(saveChatSettings('second', { historyRounds: MAX_HISTORY_ROUNDS }), true);
  assert.equal(saveChatSettings('first', { historyRounds: 0 }), true);
  assert.deepEqual(loadChatSettings('first'), { historyRounds: 0 });
  assert.deepEqual(loadChatSettings('second'), { historyRounds: MAX_HISTORY_ROUNDS });

  for (const invalid of [-1, 1.5, MAX_HISTORY_ROUNDS + 1, NaN, Infinity, '2', null]) {
    assert.equal(saveChatSettings('first', { historyRounds: invalid }), false);
    assert.deepEqual(loadChatSettings('first'), { historyRounds: 0 });
  }
  for (const raw of [
    'invalid json',
    'null',
    '[]',
    '3',
    '{}',
    '{"historyRounds":-1}',
    '{"historyRounds":1.5}',
    '{"historyRounds":25}',
    '{"historyRounds":"3"}',
  ]) {
    data.set('chat-settings:first', raw);
    assert.equal(loadChatSettings('first').historyRounds, DEFAULT_HISTORY_ROUNDS);
  }
  t.mock.method(storage, 'getItem', () => {
    throw new Error('storage access denied');
  });
  t.mock.method(storage, 'setItem', () => {
    throw new Error('storage quota exceeded');
  });
  assert.equal(loadChatSettings('first').historyRounds, DEFAULT_HISTORY_ROUNDS);
  assert.equal(saveChatSettings('first', { historyRounds: 2 }), false);
});

test('chat client preserves image data and image-only messages in the request', async (t) => {
  const input = {
    modelId: user.id,
    messages: [
      {
        role: 'user',
        content: '',
        images: [
          {
            name: 'pixel.png',
            dataUrl:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
          },
        ],
      },
    ],
    webSearch: true,
  };
  t.mock.method(globalThis, 'fetch', (_path, options) => {
    assert.deepEqual(JSON.parse(options.body), input);
    return Promise.resolve(json({ content: '图片回答' }));
  });
  assert.equal((await sendChat(input, new AbortController().signal)).content, '图片回答');
});

test('chat excludes legacy debug records on success and upstream failure', async (t) => {
  const input = { modelId: user.id, messages: [{ role: 'user', content: '调试' }] };
  const debug = {
    requestId: user.id,
    startedAt: user.createdAt,
    durationMs: 10,
    status: 'success',
    model: { name: '测试模型', model: 'test', baseUrl: 'https://example.com/v1' },
    events: [
      {
        kind: 'model_request',
        round: 1,
        startedAt: user.createdAt,
        durationMs: 0,
        truncated: false,
        messages: input.messages,
        tools: '[]',
      },
      {
        kind: 'tool',
        round: 1,
        startedAt: user.createdAt,
        durationMs: 20,
        truncated: false,
        toolCallId: 'search',
        name: 'web_search',
        arguments: '{"query":"杭州天气"}',
        result: '{"results":[]}',
        cacheHit: true,
        webRequests: [
          {
            requestedAt: user.createdAt,
            method: 'GET',
            url: 'https://cn.bing.com/search?q=weather',
            headers: {
              Accept: 'text/html',
              'Accept-Language': 'zh-CN',
              'Accept-Encoding': 'gzip, deflate, br',
              'User-Agent': 'test-browser',
            },
            curl: "curl --url 'https://cn.bing.com/search?q=weather'",
          },
        ],
      },
    ],
  };
  const success = t.mock.method(globalThis, 'fetch', (_path, options) => {
    assert.deepEqual(JSON.parse(options.body), input);
    return Promise.resolve(json({ content: '回答', debug }));
  });
  assert.equal('debug' in (await sendChat(input, new AbortController().signal)), false);
  success.mock.restore();
  const failed = { ...debug, status: 'error' };
  t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(json({ message: '模型 API 鉴权失败', debug: failed }, 502)),
  );
  await assert.rejects(sendChat(input, new AbortController().signal), (error) => {
    assert.equal(error instanceof ApiError, true);
    assert.equal(error.status, 502);
    assert.equal('debug' in error, false);
    return true;
  });
});
