import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { callModel, toModelMessages } from '../.test-dist/chat/model-api.js';
import { ChatAgentService } from '../.test-dist/chat/chat-agent.service.js';
import { ChatTrace } from '../.test-dist/chat/chat-trace.js';

const { ChatCompletionSchema, ChatImageSchema, CHAT_IMAGE_MAX_BYTES } = createRequire(
  import.meta.url,
)('@repo/contracts');
const image = {
  name: 'pixel.png',
  dataUrl:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
};
const input = (messages) => ({ modelId: '11111111-1111-4111-8111-111111111111', messages });
const user = { role: 'user', content: '识别这张图', images: [image] };

test('image contract supports image-only input, validates signatures, roles, sizes and history budget', () => {
  assert.equal(ChatCompletionSchema.safeParse(input([{ ...user, content: '' }])).success, true);
  for (const messages of [
    [{ role: 'user', content: '' }],
    [{ role: 'assistant', content: '图', images: [image] }, user],
    [{ ...user, images: Array(5).fill(image) }],
    [{ ...user, images: [{ ...image, dataUrl: 'https://example.com/image.png' }] }],
    [{ ...user, images: [{ ...image, dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }] }],
    [
      {
        ...user,
        images: [{ ...image, dataUrl: 'data:image/jpeg;base64,' + image.dataUrl.split(',')[1] }],
      },
    ],
    [{ ...user, images: [{ ...image, dataUrl: image.dataUrl + '???' }] }],
  ])
    assert.equal(ChatCompletionSchema.safeParse(input(messages)).success, false);
  const large = (bytes) => {
    const body = Buffer.alloc(bytes);
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(body);
    return {
      name: 'size-fixture.png',
      dataUrl: `data:image/png;base64,${body.toString('base64')}`,
    };
  };
  const boundary = large(CHAT_IMAGE_MAX_BYTES);
  assert.equal(ChatImageSchema.safeParse(boundary).success, true);
  assert.equal(ChatImageSchema.safeParse(large(CHAT_IMAGE_MAX_BYTES + 1)).success, false);
  assert.equal(
    ChatCompletionSchema.safeParse(input([{ ...user, images: Array(4).fill(boundary) }])).success,
    true,
  );
  assert.equal(
    ChatCompletionSchema.safeParse(
      input([
        { ...user, images: Array(4).fill(boundary) },
        { role: 'assistant', content: '回答' },
        user,
      ]),
    ).success,
    false,
  );
});

async function server(t, reply) {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const result = reply(body, requests.length);
    response.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: result.message }] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  return {
    model: {
      name: '视觉模型',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      apiKey: 'fixture',
      model: 'qwen3.5:9b',
    },
    requests,
  };
}

test('plain model receives OpenAI image parts and follow-up history, while debug omits base64', async (t) => {
  const { model, requests } = await server(t, () => ({ message: { content: '图片已读取' } }));
  const history = [
    user,
    { role: 'assistant', content: '之前的识别' },
    { role: 'user', content: '请继续' },
  ];
  const trace = new ChatTrace(model);
  await callModel(
    model.baseUrl,
    model.apiKey,
    model.model,
    history,
    new AbortController().signal,
    trace,
  );
  assert.deepEqual(requests[0].messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: user.content },
        { type: 'image_url', image_url: { url: image.dataUrl } },
      ],
    },
    ...history.slice(1),
  ]);
  const debug = JSON.stringify(trace.finish('success'));
  assert.match(debug, /image\/png/);
  assert.match(debug, /图片数据已省略/);
  assert.equal(debug.includes(image.dataUrl), false);
  assert.deepEqual(toModelMessages([{ ...user, content: '' }])[0].content, [
    { type: 'text', text: '请描述这张图片的内容。' },
    { type: 'image_url', image_url: { url: image.dataUrl } },
  ]);
});

test('agent keeps image parts across tool rounds and only executes requested tools', async (t) => {
  const { model, requests } = await server(t, (_body, round) => ({
    message:
      round === 1
        ? {
            content: null,
            tool_calls: [
              {
                id: 'image-search',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"图中地点"}' },
              },
            ],
          }
        : { content: '结合图片和搜索回答' },
  }));
  let calls = 0;
  const agent = new ChatAgentService({
    execute: async () => {
      calls++;
      return { data: { pages: [] }, sources: [] };
    },
  });
  const answer = await agent.complete(model, [user], new AbortController().signal);
  assert.equal(answer.content, '结合图片和搜索回答');
  assert.equal(calls, 1);
  assert.equal(requests.length, 2);
  for (const request of requests) assert.deepEqual(request.messages[1], toModelMessages([user])[0]);
});

test('image-incompatible upstream errors produce a clear message without discarding the image', async (t) => {
  const { model } = await server(t, () => ({ status: 400 }));
  await assert.rejects(
    callModel(model.baseUrl, model.apiKey, model.model, [user], new AbortController().signal),
    /模型无法处理图片/,
  );
});
