import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { SseDecoder, ChatStreamEventSchema } from '@repo/contracts';
import { ChatProgress } from '../.test-dist/chat/chat-progress.js';
import { ModelStream } from '../.test-dist/chat/model-stream.js';
import { callModelTurn } from '../.test-dist/chat/model-api.js';
import { ChatAgentService } from '../.test-dist/chat/chat-agent.service.js';

const frame = (delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\r\n\r\n`;
test('SSE frames handle split CRLF, comments and multiline data with bounded memory', () => {
  const decoder = new SseDecoder();
  assert.deepEqual(decoder.push(': comment\r'), []);
  assert.deepEqual(decoder.push('\ndata: hello\r'), []);
  assert.deepEqual(decoder.push('\ndata: world\r\n\r'), []);
  assert.deepEqual(decoder.push('\n'), ['hello\nworld']);
  assert.throws(() => decoder.push('x'.repeat(1_000_001)), /过大/);
});

test('model stream assembles split UTF8, tool arguments and usage-only terminal chunks', () => {
  const events = [];
  const stream = new ModelStream(2, { delta: (event) => events.push(event) });
  const text =
    frame({ role: 'assistant' }) +
    frame({ reasoning_content: '先想一想。' }) +
    frame({
      tool_calls: [
        {
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: 'web_', arguments: '{"query":' },
        },
      ],
    }) +
    frame({ tool_calls: [{ index: 0, function: { name: 'search', arguments: '"天气"}' } }] }) +
    'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":4}}\r\n\r\n' +
    'data: [DONE]\r\n\r\n';
  for (const byte of Buffer.from(text)) stream.push(Uint8Array.of(byte));
  const result = stream.finish();
  assert.deepEqual(result.usage, { prompt_tokens: 8, completion_tokens: 4 });
  assert.equal(result.choices[0].message.reasoning_content, '先想一想。');
  assert.deepEqual(result.choices[0].message.tool_calls, [
    {
      id: 'call-1',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"天气"}' },
    },
  ]);
  assert.equal(events.filter((event) => event.toolCall).length, 2);
  const truncated = new ModelStream(1, { delta() {} });
  truncated.push(Buffer.from(frame({ content: '部分回答' })));
  assert.throws(() => truncated.finish(), /结束标记/);
  const invalid = new ModelStream(1, { delta() {} });
  assert.throws(() => invalid.push(Buffer.from('data: {"error":"denied"}\n\n')));
  const oversized = new ModelStream(1, { delta() {} });
  assert.throws(() => oversized.push(Buffer.from(frame({ content: 'x'.repeat(100_001) }))), /过大/);
});

test('timings exclude initial wait, split reasoning spans and freeze tool boundaries across rounds', () => {
  let now = 100;
  const events = [];
  const progress = new ChatProgress(
    (event) => events.push(event),
    () => now,
  );
  progress.modelStart(1);
  now = 150;
  progress.delta({ type: 'delta', round: 1 });
  assert.equal(progress.snapshot().firstResponseMs, null);
  now = 200;
  progress.delta({ type: 'delta', round: 1, reasoning: '想' });
  now = 350;
  progress.delta({ type: 'delta', round: 1, toolCall: true });
  now = 400;
  progress.modelEnd();
  progress.toolStart(1, 'call-1', 'web_search');
  now = 900;
  progress.toolEnd();
  progress.modelStart(2);
  now = 1000;
  progress.delta({ type: 'delta', round: 2, reasoning: '整理' });
  now = 1200;
  progress.delta({ type: 'delta', round: 2, content: '回答' });
  now = 1300;
  progress.modelEnd();
  now = 1400;
  const timing = progress.finish();
  assert.equal(timing.firstResponseMs, 100);
  assert.equal(timing.elapsedMs, 1300);
  now = 2000;
  assert.deepEqual(progress.finish(), timing);
  assert.deepEqual(timing.thoughts, [
    { round: 1, startMs: 100, endMs: 250 },
    { round: 2, startMs: 900, endMs: 1100 },
  ]);
  assert.deepEqual(timing.tools, [
    { round: 1, id: 'call-1', name: 'web_search', startMs: 300, endMs: 800 },
  ]);
  for (const event of events) assert.equal(ChatStreamEventSchema.safeParse(event).success, true);
  assert.equal(events[0].timing.firstResponseMs, null);
});

async function upstream(t, handler) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    handler(JSON.parse(body), response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'fixture',
    model: 'fixture',
  };
}

test('streaming agent emits output before completion and retains multiple thought/tool rounds', async (t) => {
  let round = 0;
  let release;
  const gated = new Promise((resolve) => {
    release = resolve;
  });
  const model = await upstream(t, (body, response) => {
    assert.equal(body.stream, true);
    assert.equal(body.stream_options.include_usage, true);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    round++;
    response.write(frame({ reasoning_content: `思考${round}` }));
    if (round === 1) {
      response.end(
        frame({
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"天气"}' },
            },
          ],
        }) + 'data: [DONE]\n\n',
      );
    } else {
      response.write(frame({ content: '最终回答' }));
      void gated.then(() =>
        response.end(
          'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
        ),
      );
    }
  });
  let partial;
  const observed = new Promise((resolve) => {
    partial = resolve;
  });
  const events = [];
  const progress = new ChatProgress((event) => {
    events.push(event);
    if (event.type === 'delta' && event.content) partial();
  });
  const agent = new ChatAgentService({
    execute: async () => ({
      data: { result: '资料' },
      sources: [{ title: '来源', url: 'https://example.com' }],
    }),
  });
  let settled = false;
  const pending = agent
    .complete(
      model,
      [{ role: 'user', content: '问题' }],
      new AbortController().signal,
      undefined,
      progress,
    )
    .then((answer) => {
      settled = true;
      return answer;
    });
  await observed;
  assert.equal(settled, false);
  release();
  const answer = await pending;
  assert.equal(answer.reasoning, '思考1\n\n思考2');
  assert.equal(answer.content, '最终回答');
  assert.deepEqual(answer.usage, { inputTokens: 9, outputTokens: 5 });
  assert.equal(progress.finish().thoughts.length, 2);
  assert.equal(progress.finish().tools.length, 1);
});

test('stream transport rejects truncation and JSON fallback, and abort closes upstream', async (t) => {
  const observer = { modelStart() {}, delta() {}, modelEnd() {} };
  for (const mode of ['truncated', 'json']) {
    const model = await upstream(t, (_body, response) => {
      response.writeHead(200, {
        'Content-Type': mode === 'json' ? 'application/json' : 'text/event-stream',
      });
      response.end(
        mode === 'json'
          ? '{"choices":[{"message":{"content":"回答"}}]}'
          : frame({ content: '部分回复' }),
      );
    });
    await assert.rejects(
      callModelTurn(
        model.baseUrl,
        model.apiKey,
        model.model,
        [],
        new AbortController().signal,
        undefined,
        'auto',
        undefined,
        1,
        observer,
      ),
    );
  }
  let opened;
  let closed;
  const ready = new Promise((resolve) => {
    opened = resolve;
  });
  const disconnected = new Promise((resolve) => {
    closed = resolve;
  });
  const model = await upstream(t, (_body, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(frame({ reasoning_content: '思考中' }));
    response.once('close', closed);
    opened();
  });
  const controller = new AbortController();
  const pending = callModelTurn(
    model.baseUrl,
    model.apiKey,
    model.model,
    [],
    controller.signal,
    undefined,
    'auto',
    undefined,
    1,
    observer,
  );
  await ready;
  controller.abort();
  await assert.rejects(pending);
  await disconnected;
});
