import 'reflect-metadata';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { normalizeUsage, callModel } from '../.test-dist/chat/model-api.js';
import { localOllamaOrigin, resolveContextWindow } from '../.test-dist/chat/model-context.js';
import { ChatAgentService } from '../.test-dist/chat/chat-agent.service.js';

const require = createRequire(import.meta.url);
const modelApi = require('../.test-dist/chat/model-api.js');
const { CreateChatModelSchema } = require('@repo/contracts');
const model = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'fixture:9b',
  apiKey: 'fixture-key',
};
const signal = () => new AbortController().signal;

async function metadataServer(t, reply) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: body ? JSON.parse(body) : null });
    const result = reply(req.url);
    if (!result) return;
    res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const original = http.request;
  t.mock.method(http, 'request', (url, ...args) =>
    original(new URL(`${url.pathname}`, `http://127.0.0.1:${server.address().port}`), ...args),
  );
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return requests;
}

test('usage accepts reported input/output including zero, ignores malformed metadata and billing total', () => {
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 200, completion_tokens: 30, total_tokens: 999 }),
    {
      inputTokens: 200,
      outputTokens: 30,
    },
  );
  assert.deepEqual(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }), {
    inputTokens: 0,
    outputTokens: 0,
  });
  for (const value of [
    null,
    undefined,
    {},
    { prompt_tokens: '10', completion_tokens: 1 },
    { prompt_tokens: -1, completion_tokens: 1 },
    { prompt_tokens: 1.5, completion_tokens: 1 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
  ])
    assert.equal(normalizeUsage(value), undefined);
});

test('plain replies preserve usage without failing on invalid usage', async (t) => {
  let usage = { prompt_tokens: 120, completion_tokens: 15 };
  const server = http.createServer((req, res) => {
    req.resume();
    res.end(JSON.stringify({ choices: [{ message: { content: '回答' } }], usage }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const complete = () =>
    callModel(
      `http://127.0.0.1:${server.address().port}/v1`,
      'fixture',
      'fixture',
      [{ role: 'user', content: '你好' }],
      signal(),
    );
  assert.deepEqual((await complete()).usage, { inputTokens: 120, outputTokens: 15 });
  usage = { prompt_tokens: -2 };
  assert.deepEqual(await complete(), { content: '回答' });
});

test('tool rounds return only final inference usage and omit earlier usage from next prompt', async (t) => {
  let round = 0;
  let reportFinalUsage = true;
  t.mock.method(modelApi, 'callModelTurn', async (_url, _key, _model, messages) => {
    round++;
    if (round === 1)
      return {
        content: null,
        usage: { inputTokens: 100, outputTokens: 20 },
        tool_calls: [
          {
            id: 'tool-1',
            type: 'function',
            function: { name: 'research', arguments: '{"task":"查证测试"}' },
          },
        ],
      };
    assert.equal('usage' in messages.at(-2), false);
    return {
      content: '最终回复',
      ...(reportFinalUsage ? { usage: { inputTokens: 500, outputTokens: 40 } } : {}),
    };
  });
  const answer = await new ChatAgentService({
    tools: () => [
      {
        definition: {
          type: 'function',
          function: { name: 'research', description: '研究', parameters: {} },
        },
        execute: async () => ({ data: { findings: [] }, sources: [] }),
      },
    ],
  }).complete(model, [{ role: 'user', content: '搜索' }], signal());
  assert.equal(round, 2);
  assert.deepEqual(answer.usage, { inputTokens: 500, outputTokens: 40 });
  reportFinalUsage = false;
  round = 0;
  const missing = await new ChatAgentService({
    tools: () => [
      {
        definition: {
          type: 'function',
          function: { name: 'research', description: '研究', parameters: {} },
        },
        execute: async () => ({ data: {}, sources: [] }),
      },
    ],
  }).complete(model, [{ role: 'user', content: '搜索' }], signal());
  assert.equal(missing.usage, undefined);
});

test('only known local development Ollama endpoint is probed', (t) => {
  assert.equal(localOllamaOrigin(model.baseUrl).hostname, '127.0.0.1');
  assert.equal(
    localOllamaOrigin('http://localhost:11434/v1/chat/completions/').hostname,
    '127.0.0.1',
  );
  for (const url of [
    'https://example.com/v1',
    'http://127.0.0.1:11435/v1',
    'http://127.0.0.1:11434/other/v1',
    'https://localhost:11434/v1',
  ])
    assert.equal(localOllamaOrigin(url), undefined);
  const previous = process.env.NODE_ENV;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  process.env.NODE_ENV = 'production';
  assert.equal(localOllamaOrigin(model.baseUrl), undefined);
});

test('runtime window takes priority, matches selected model and reads fresh each turn', async (t) => {
  let window = 131072;
  const requests = await metadataServer(t, () => ({
    body: {
      models: [
        { name: 'different', context_length: 4096 },
        { model: model.model, context_length: window },
      ],
    },
  }));
  assert.deepEqual(await resolveContextWindow({ ...model, contextWindow: 8192 }, signal()), {
    windowTokens: 131072,
    source: 'runtime',
  });
  window = 32768;
  assert.equal((await resolveContextWindow(model, signal())).windowTokens, 32768);
  assert.deepEqual(
    requests.map((req) => req.path),
    ['/api/ps', '/api/ps'],
  );
});

test('manual fallback precedes declaration; declaration is labeled and uses model architecture', async (t) => {
  const requests = await metadataServer(t, (path) => ({
    body:
      path === '/api/ps'
        ? { models: [] }
        : {
            model_info: {
              'general.architecture': 'qwen3_5',
              'qwen3_5.context_length': 262144,
              'unrelated.context_length': 8192,
            },
          },
  }));
  assert.deepEqual(await resolveContextWindow({ ...model, contextWindow: 16384 }, signal()), {
    windowTokens: 16384,
    source: 'configured',
  });
  assert.deepEqual(await resolveContextWindow(model, signal()), {
    windowTokens: 262144,
    source: 'declared',
  });
  assert.deepEqual(requests.at(-1), { path: '/api/show', body: { model: model.model } });
});

test('failed or malformed metadata degrades gracefully; timeout and cancellation are bounded', async (t) => {
  let reply = { status: 503, body: {} };
  const requests = await metadataServer(t, () => reply);
  assert.deepEqual(await resolveContextWindow(model, signal()), {
    windowTokens: null,
    source: 'unknown',
  });
  reply = { body: { models: [{ name: model.model, context_length: -1 }] } };
  assert.equal((await resolveContextWindow(model, signal())).source, 'unknown');
  reply = null;
  assert.deepEqual(await resolveContextWindow({ ...model, contextWindow: 8192 }, signal()), {
    windowTokens: 8192,
    source: 'configured',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  await assert.rejects(resolveContextWindow(model, controller.signal), { name: 'AbortError' });
  clearTimeout(timer);
  const count = requests.length;
  await assert.rejects(resolveContextWindow(model, controller.signal), { name: 'AbortError' });
  assert.equal(requests.length, count);
});

test('remote model capacity is explicitly configured or unknown; configuration rejects invalid windows', async () => {
  const remote = { ...model, baseUrl: 'https://example.com/v1' };
  assert.deepEqual(await resolveContextWindow(remote, signal()), {
    windowTokens: null,
    source: 'unknown',
  });
  assert.equal(
    (await resolveContextWindow({ ...remote, contextWindow: 64000 }, signal())).source,
    'configured',
  );
  const input = { ...remote, name: '测试' };
  for (const contextWindow of [0, -1, 1.1, 2147483648, '32768'])
    assert.equal(CreateChatModelSchema.safeParse({ ...input, contextWindow }).success, false);
  assert.equal(CreateChatModelSchema.safeParse({ ...input, contextWindow: null }).success, true);
});
