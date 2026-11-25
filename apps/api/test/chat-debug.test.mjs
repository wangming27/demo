import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { BadGatewayException } from '@nestjs/common';
import { ChatCompletionSchema, ChatDebugTraceSchema, SseDecoder } from '@repo/contracts';
import { ChatDebugStore, ChatDebugController } from '../.test-dist/chat-debug/chat-debug.module.js';
import { ChatTrace } from '../.test-dist/chat-debug/chat-trace.js';
import { ChatService } from '../.test-dist/chat/chat.service.js';
import { ChatController } from '../.test-dist/chat/chat.controller.js';
import { chatDebugEnabled } from '../.test-dist/config/environment.js';

const model = {
  id: randomUUID(),
  name: '模型',
  model: 'test',
  baseUrl: 'https://example.com/v1',
  apiKey: 'secret',
  contextWindow: 1000,
};
const userId = randomUUID();

function fixture(diagnostics, run) {
  const input = {
    modelId: model.id,
    requestId: randomUUID(),
    messages: [{ role: 'user', content: '你好' }],
    webSearch: true,
  };
  const journal = {
    row: { id: randomUUID(), requestId: input.requestId },
    signal: new AbortController().signal,
    async finish(answer) {
      this.answer = answer;
    },
    async finishError(error) {
      this.error = error;
    },
  };
  const service = new ChatService(
    { chatModel: { findFirst: async () => model } },
    { complete: async (_model, _messages, _signal, trace, progress) => run(trace, progress) },
    { begin: async () => ({ journal }) },
    diagnostics,
  );
  return { service, input, journal };
}

test('large debug history uses independent storage and never enlarges SSE completion', async () => {
  const store = new ChatDebugStore();
  const { service, input, journal } = fixture(store, (trace, progress) => {
    for (let round = 1; round <= 150; round++) {
      trace.modelRequest(
        round,
        Array.from({ length: 50 }, () => ({ role: 'user', content: '长'.repeat(8000) })),
      );
    }
    progress.delta({ type: 'delta', round: 1, content: '回答' });
    return { content: '回答' };
  });
  const chunks = [];
  const response = Object.assign(new EventEmitter(), {
    headersSent: false,
    destroyed: false,
    writableLength: 0,
    status() {
      return this;
    },
    set() {
      return this;
    },
    write(chunk) {
      this.headersSent = true;
      chunks.push(chunk);
    },
    end() {},
  });
  await new ChatController(service).stream({ authUser: { id: userId } }, input, response);
  const events = new SseDecoder().push(chunks.join('')).map((data) => JSON.parse(data));
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).answer.content, '回答');
  assert.equal('debug' in events.at(-1).answer, false);
  assert.equal('debug' in journal.answer, false);
  const trace = ChatDebugTraceSchema.parse(store.get(userId, input.requestId));
  assert.ok(Buffer.byteLength(JSON.stringify(trace)) > 1_000_000);
  assert.ok(Buffer.byteLength(JSON.stringify(trace)) < 2.1 * 1024 * 1024);
  assert.equal(trace.truncated, true);
});

test('start, record and store failures do not alter chat or its original error', async () => {
  const fail = () => {
    throw new Error('debug failed');
  };
  for (const diagnostics of [
    undefined,
    { start: fail, finish: fail },
    {
      start: () => ({
        modelRequest: fail,
        modelResponse: fail,
        tool: fail,
        error: fail,
        finish: fail,
      }),
      finish: fail,
    },
    { start: () => new ChatTrace(model), finish: fail },
  ]) {
    const { service, input, journal } = fixture(diagnostics, (trace) => {
      trace?.modelRequest(1, []);
      trace?.modelResponse(1, Date.now(), { content: '回答' });
      return { content: '回答' };
    });
    assert.equal((await service.complete(userId, input, journal.signal)).content, '回答');
    assert.equal(journal.answer.content, '回答');
    const original = new BadGatewayException('模型失败');
    const failed = fixture(diagnostics, () => {
      throw original;
    });
    await assert.rejects(
      failed.service.complete(userId, failed.input, failed.journal.signal),
      (error) => error === original,
    );
    assert.equal(failed.journal.error, original);
  }
});

test('trace serialization errors and excessive tool arguments remain bounded', () => {
  const trace = new ChatTrace(model);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() =>
    trace.tool(
      1,
      Date.now(),
      { id: 'call', function: { name: 'test', arguments: '{}' } },
      { data: cyclic },
    ),
  );
  for (let index = 0; index < 1000; index++) {
    trace.tool(
      1,
      Date.now(),
      { id: 'call', function: { name: 'test', arguments: 'x'.repeat(100_000) } },
      { data: { ok: true } },
    );
  }
  const record = ChatDebugTraceSchema.parse(trace.finish('success'));
  assert.equal(record.truncated, true);
  assert.ok(record.events.length <= 768);
  assert.ok(record.events.every((event) => event.arguments.length <= 8000 && event.truncated));
});

test('debug records are private, expire and evict oldest records', (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const store = new ChatDebugStore();
  const first = randomUUID();
  store.finish(userId, first, new ChatTrace(model, first), 'success');
  assert.equal(store.get(randomUUID(), first), undefined);
  const controller = new ChatDebugController(store);
  assert.throws(
    () => controller.get({}, first),
    (error) => error.getStatus() === 401,
  );
  assert.throws(
    () => controller.get({ authUser: { id: randomUUID() } }, first),
    (error) => error.getStatus() === 404,
  );
  for (let index = 0; index < 30; index++) {
    const id = randomUUID();
    store.finish(userId, id, new ChatTrace(model, id), 'success');
  }
  assert.equal(store.get(userId, first), undefined);
  const latest = randomUUID();
  store.finish(userId, latest, new ChatTrace(model, latest), 'error');
  assert.equal(store.get(userId, latest).status, 'error');
  now += 30 * 60_000;
  assert.equal(store.get(userId, latest), undefined);
});

test('production debug defaults off and chat no longer accepts a debug flag', (t) => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    CHAT_DEBUG_ENABLED: process.env.CHAT_DEBUG_ENABLED,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.NODE_ENV = 'production';
  delete process.env.CHAT_DEBUG_ENABLED;
  assert.equal(chatDebugEnabled(), false);
  const enabled = execFileSync(
    process.execPath,
    [
      '-e',
      `
    require('reflect-metadata');
    const { ChatModule } = require('./.test-dist/chat/chat.module.js');
    console.log(Reflect.getMetadata('imports', ChatModule).some((module) => module.name === 'ChatDebugModule'));
  `,
    ],
    {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, CHAT_DEBUG_ENABLED: 'false' },
      encoding: 'utf8',
    },
  );
  assert.equal(enabled.trim(), 'false');
  process.env.CHAT_DEBUG_ENABLED = 'true';
  assert.equal(chatDebugEnabled(), true);
  process.env.NODE_ENV = 'development';
  process.env.CHAT_DEBUG_ENABLED = 'false';
  assert.equal(chatDebugEnabled(), false);
  delete process.env.CHAT_DEBUG_ENABLED;
  assert.equal(chatDebugEnabled(), true);
  assert.equal(
    ChatCompletionSchema.safeParse({
      modelId: model.id,
      messages: [{ role: 'user', content: '你好' }],
      debug: true,
    }).success,
    false,
  );
});
