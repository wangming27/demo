import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ChatAgentService } from '../.test-dist/chat/chat-agent.service.js';
import { WebToolsService } from '../.test-dist/chat/web-tools.service.js';
import { ChatTrace } from '../.test-dist/chat/chat-trace.js';

const web = createRequire(import.meta.url)('../.test-dist/chat/public-web.js');
const history = [{ role: 'user', content: '请搜索北京今天的天气' }];
const toolCall = (id = 'search-1') => ({
  id,
  type: 'function',
  function: { name: 'web_search', arguments: '{"query":"北京 天气"}' },
});
async function modelServer(t, reply) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const result = reply(body, requests.length);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: result }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    model: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'fixture',
      model: 'fixture',
    },
    requests,
  };
}

test('agent passes search data into model, aggregates reasoning and attaches executed sources', async (t) => {
  const { model, requests } = await modelServer(t, (_body, round) =>
    round === 1
      ? { content: null, reasoning_content: '先查询。', tool_calls: [toolCall()] }
      : { content: '根据搜索资料作答。', reasoning: '整理资料。' },
  );
  t.mock.method(web, 'readPublicPage', async (url) => ({
    url: url.href,
    html:
      url.hostname === 'cn.bing.com'
        ? '<ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/weather">天气来源</a></h2><div class="b_caption"><p>搜索摘要</p></div></li></ol>'
        : `<title>天气来源</title><body><article>${'实际天气正文。'.repeat(30)}</article></body>`,
  }));
  const trace = new ChatTrace({ name: '调试模型', ...model });
  const answer = await new ChatAgentService(new WebToolsService()).complete(
    model,
    history,
    new AbortController().signal,
    trace,
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[0].tools.map((tool) => tool.function.name),
    ['web_search'],
  );
  assert.match(requests[0].messages[0].content, /天气查询请在搜索词中包含城市和日期/);
  assert.match(requests[0].messages[0].content, /搜索结果缺少日期或实时数据时明确说明信息不足/);
  const tool = requests[1].messages.at(-1);
  assert.equal(tool.role, 'tool');
  assert.equal(tool.tool_call_id, 'search-1');
  assert.equal(JSON.parse(tool.content).results[0].snippet, '搜索摘要');
  assert.match(JSON.parse(tool.content).pages[0].content, /实际天气正文/);
  assert.equal(answer.reasoning, '先查询。\n\n整理资料。');
  assert.deepEqual(answer.sources, [{ title: '天气来源', url: 'https://example.com/weather' }]);
  const debug = trace.finish('success');
  assert.deepEqual(
    debug.events.map((event) => [event.kind, event.round]),
    [
      ['model_request', 1],
      ['model_response', 1],
      ['tool', 1],
      ['model_request', 2],
      ['model_response', 2],
    ],
  );
  assert.equal(debug.events[0].messages[0].role, 'system');
  assert.equal(debug.events[0].messages.at(-1).content, history[0].content);
  assert.equal(debug.events[0].messages.length, 2); // Snapshot remains unchanged by later rounds.
  assert.equal(debug.events[2].toolCallId, tool.tool_call_id);
  assert.deepEqual(JSON.parse(debug.events[2].result), JSON.parse(tool.content));
  assert.equal(debug.events[3].messages.at(-1).toolCallId, tool.tool_call_id);
  assert.equal(JSON.parse(debug.events[4].message).content, answer.content);
  assert.equal('apiKey' in debug.model, false);
  assert.equal(JSON.stringify(debug).includes('"Authorization"'), false);
});

test('agent permits location clarification without invoking providers', async (t) => {
  const { model, requests } = await modelServer(t, () => ({
    content: '请问你想查询哪个城市的天气？',
  }));
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('unexpected fetch');
  });
  const answer = await new ChatAgentService(new WebToolsService()).complete(
    model,
    [{ role: 'user', content: '今天什么天气' }],
    new AbortController().signal,
  );
  assert.match(answer.content, /哪个城市/);
  assert.equal(mock.mock.callCount(), 0);
  assert.match(requests[0].messages[0].content, /缺少城市时先询问用户/);
  assert.equal(answer.sources, undefined);
});

test('provider failure is passed to model and displayed independently as a warning', async (t) => {
  const { model, requests } = await modelServer(t, (_body, round) =>
    round === 1
      ? { content: null, tool_calls: [toolCall()] }
      : { content: '查询失败，请稍后重试。' },
  );
  t.mock.method(web, 'readPublicPage', async () => {
    throw new Error('HTTP 503');
  });
  const answer = await new ChatAgentService(new WebToolsService()).complete(
    model,
    history,
    new AbortController().signal,
  );
  assert.match(JSON.parse(requests[1].messages.at(-1).content).error, /暂时不可用/);
  assert.match(answer.searchWarning, /暂时不可用/);
  assert.equal(answer.sources, undefined);
});

test('agent bounds tool calls and forces a final answer after exhausted budget', async (t) => {
  const { model, requests } = await modelServer(t, (_body, round) =>
    round === 1
      ? { content: null, tool_calls: Array.from({ length: 6 }, (_, i) => toolCall(`call-${i}`)) }
      : { content: '已有结果的总结。' },
  );
  let calls = 0;
  const agent = new ChatAgentService({
    execute: async () => {
      calls++;
      return { data: { result: '资料' }, sources: [] };
    },
  });
  const answer = await agent.complete(model, history, new AbortController().signal);
  assert.equal(calls, 4);
  assert.equal(requests[1].tool_choice, 'none');
  assert.equal(requests[1].messages.filter((message) => message.role === 'tool').length, 6);
  assert.match(answer.searchWarning, /次数已达上限/);
});

test('repeated tool rounds terminate and pre-aborted requests never contact model', async (t) => {
  const { model, requests } = await modelServer(t, (_body, round) => ({
    content: null,
    tool_calls: [toolCall(`call-${round}`)],
  }));
  const agent = new ChatAgentService({ execute: async () => ({ data: {}, sources: [] }) });
  await assert.rejects(
    agent.complete(model, history, new AbortController().signal),
    /超出联网查询次数/,
  );
  assert.equal(requests.length, 4);
  assert.equal(requests[3].tool_choice, 'none');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(agent.complete(model, history, controller.signal), { name: 'AbortError' });
  assert.equal(requests.length, 4);
});
