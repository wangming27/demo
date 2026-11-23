import 'reflect-metadata';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { callModelTurn } from '../.test-dist/chat/model-api.js';

const require = createRequire(import.meta.url);
const configuration = require('../.test-dist/config/environment.js');
const keys = ['CHAT_MODEL_FIRST_RESPONSE_TIMEOUT_MS', 'CHAT_MODEL_IDLE_TIMEOUT_MS'];
const frame = (delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
const observer = { modelStart() {}, delta() {}, modelEnd() {} };

test('model timeout settings use defaults and reject invalid timer values', (t) => {
  const previous = keys.map((key) => process.env[key]);
  t.after(() => {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  for (const key of keys) delete process.env[key];
  assert.deepEqual(configuration.getModelTimeouts(), {
    modelFirstResponseTimeoutMs: 180_000,
    modelIdleTimeoutMs: 60_000,
  });
  process.env[keys[0]] = '300000';
  process.env[keys[1]] = '120000';
  assert.deepEqual(configuration.getModelTimeouts(), {
    modelFirstResponseTimeoutMs: 300_000,
    modelIdleTimeoutMs: 120_000,
  });
  for (const key of keys) {
    for (const value of ['', '0', '-1', '1.5', 'invalid', 'Infinity', '2147483648']) {
      process.env[key] = value;
      assert.throws(configuration.getModelTimeouts, new RegExp(key));
    }
    process.env[key] = '2147483647';
    assert.doesNotThrow(configuration.getModelTimeouts);
  }
});

async function upstream(t, handler, first = 250, idle = 200) {
  t.mock.method(configuration, 'getModelTimeouts', () => ({
    modelFirstResponseTimeoutMs: first,
    modelIdleTimeoutMs: idle,
  }));
  const server = createServer(async (request, response) => {
    request.resume();
    await once(request, 'end');
    handler(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function invoke(url, progress = observer, signal = new AbortController().signal) {
  return callModelTurn(
    url,
    'fixture',
    'fixture',
    [],
    signal,
    undefined,
    'auto',
    undefined,
    1,
    progress,
  );
}

function writeEvery(response, frames, interval = 75) {
  const timer = setInterval(() => {
    const next = frames.shift();
    if (next === undefined) response.end();
    else response.write(next);
  }, interval);
  response.once('close', () => clearInterval(timer));
}

test('headers, heartbeats and empty frames cannot extend the first-output deadline', async (t) => {
  const url = await upstream(
    t,
    (response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      const timer = setInterval(
        () =>
          response.write(
            ': heartbeat\n\n' +
              frame({ role: 'assistant' }) +
              'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":0}}\n\n',
          ),
        30,
      );
      response.once('close', () => clearInterval(timer));
    },
    150,
    1000,
  );
  await assert.rejects(invoke(url), (error) => {
    assert.equal(error.getStatus(), 504);
    assert.match(error.message, /首响应超时/);
    return true;
  });
});

test('reasoning, tool-call fragments and content keep a stream alive beyond the first deadline', async (t) => {
  const events = [];
  let ended = 0;
  const url = await upstream(t, (response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    writeEvery(response, [
      frame({ reasoning_content: '先思考' }),
      frame({ reasoning: '再分析' }),
      frame({
        tool_calls: [
          {
            index: 0,
            id: 'call-1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":' },
          },
        ],
      }),
      frame({ tool_calls: [{ index: 0, function: { arguments: '"天气"}' } }] }),
      frame({ content: '最终回答' }),
      'data: [DONE]\n\n',
    ]);
  });
  const turn = await invoke(url, {
    modelStart() {},
    delta(event) {
      events.push(event);
    },
    modelEnd() {
      ended++;
    },
  });
  assert.equal(turn.content, '最终回答');
  assert.equal(turn.reasoning_content, '先思考再分析');
  assert.equal(turn.tool_calls[0].function.arguments, '{"query":"天气"}');
  assert.equal(events.filter((event) => event.toolCall).length, 2);
  assert.equal(ended, 1);
});

test('a stalled stream times out despite heartbeats and disconnects the upstream', async (t) => {
  let closed;
  const disconnected = new Promise((resolve) => {
    closed = resolve;
  });
  const url = await upstream(
    t,
    (response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(frame({ content: '部分回答' }));
      const timer = setInterval(() => response.write(': heartbeat\n\n' + frame({})), 30);
      response.once('close', () => {
        clearInterval(timer);
        closed();
      });
    },
    1000,
    150,
  );
  await assert.rejects(invoke(url), (error) => {
    assert.equal(error.getStatus(), 504);
    assert.match(error.message, /长时间无输出/);
    return true;
  });
  await disconnected;
});

test('non-streaming response chunks reset the idle deadline without a total time cap', async (t) => {
  const url = await upstream(t, (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    writeEvery(response, ['{"choices":', '[{"message":', '{"content":', '"完整回答"', '}}]}']);
  });
  const turn = await callModelTurn(url, 'fixture', 'fixture', [], new AbortController().signal);
  assert.equal(turn.content, '完整回答');
});

test('non-streaming responses enforce both first-output and idle deadlines', async (t) => {
  for (const partial of [false, true]) {
    await t.test(partial ? 'partial body stalls' : 'headers without body', async (t) => {
      const url = await upstream(
        t,
        (response) => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.flushHeaders();
          if (partial) response.write('{"choices":');
        },
        150,
        150,
      );
      await assert.rejects(
        callModelTurn(url, 'fixture', 'fixture', [], new AbortController().signal),
        (error) => {
          assert.equal(error.getStatus(), 504);
          assert.match(error.message, partial ? /长时间无输出/ : /首响应超时/);
          return true;
        },
      );
    });
  }
});
