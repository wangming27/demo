import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ChatDebugTraceSchema, ChatStreamEventSchema } from '@repo/contracts';
import { ChatAgentService } from '../.test-dist/chat/chat-agent.service.js';
import { WebToolsService } from '../.test-dist/chat/web-tools.service.js';
import { ResearchAgentService } from '../.test-dist/chat/agents/research-agent.service.js';
import { SubAgentRegistry } from '../.test-dist/chat/agents/sub-agent-registry.service.js';
import { AgentBudget } from '../.test-dist/chat/agents/agent-types.js';
import { ChatTrace } from '../.test-dist/chat-debug/chat-trace.js';
import { ChatProgress } from '../.test-dist/chat/chat-progress.js';

const web = createRequire(import.meta.url)('../.test-dist/chat/public-web.js');
const history = [{ role: 'user', content: '请查证北京今天的天气，排除杭州的信息' }];
const quote = '北京今天的天气信息已更新，白天晴朗，空气质量良好，适宜出门活动。';
const evidence = (url = 'https://example.com/beijing', text = quote) => ({
  findings: [{ claim: '北京今天适宜出门。', evidence: [{ url, quote: text }] }],
  gaps: [],
});
const call = (name, args, id = name) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const content = (value) => ({ content: JSON.stringify(value) });
const toolResult = (request) => JSON.parse(request.messages.at(-1).content);
const signal = () => new AbortController().signal;
const searchInput = (query, base = 'https://cn.bing.com/search') => {
  const url = new URL(base);
  url.searchParams.set('q', query);
  return { url: url.href };
};
const agent = (webTools = new WebToolsService()) =>
  new ChatAgentService(new SubAgentRegistry([new ResearchAgentService(webTools)]));

async function modelServer(t, reply) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (body.messages.some((message) => message.content === null && !message.tool_calls?.length)) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'invalid message content type: <nil>' } }));
      return;
    }
    const result = await reply(body, requests.length);
    if (result.providerError) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: result.providerError } }));
      return;
    }
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = {
        ...result,
        ...(result.tool_calls
          ? { tool_calls: result.tool_calls.map((tool, index) => ({ ...tool, index })) }
          : {}),
      };
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n` +
          'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":5}}\n\n' +
          'data: [DONE]\n\n',
      );
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: result }] }));
    }
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

test('main delegates isolated research, skips irrelevant top result and returns verified evidence', async (t) => {
  const visited = [];
  t.mock.method(web, 'readPublicPage', async (url) => {
    visited.push(url.href);
    return {
      url: url.href,
      html:
        url.hostname === 'cn.bing.com'
          ? '<ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/hangzhou">杭州天气</a></h2></li><li class="b_algo"><h2><a href="https://example.com/beijing">北京天气</a></h2></li></ol>'
          : `<title>北京天气</title><body><article>${quote.repeat(5)}</article></body>`,
    };
  });
  const { model, requests } = await modelServer(t, (body, round) => {
    if (round === 1)
      return {
        reasoning_content: '委派研究。',
        tool_calls: [call('research', { task: history[0].content })],
      };
    if (round === 2) {
      assert.equal(body.messages.length, 2);
      assert.equal(body.messages[1].content, history[0].content);
      return { tool_calls: [call('web_search', searchInput('北京 天气'))] };
    }
    if (round === 3) {
      assert.equal(toolResult(body).results[0].title, '杭州天气');
      assert.equal(toolResult(body).pages, undefined);
      return { tool_calls: [call('web_fetch', { url: 'https://example.com/beijing' })] };
    }
    if (round === 4) return content(evidence());
    assert.equal(toolResult(body).findings[0].evidence[0].quote, quote);
    assert.doesNotMatch(body.messages.at(-1).content, /杭州天气/);
    return { content: '根据北京正文，今天适宜出门。', reasoning_content: '核验结论。' };
  });
  const trace = new ChatTrace({ name: '测试模型', ...model });
  const answer = await agent().complete(model, history, signal(), trace);
  assert.equal(requests.length, 5);
  assert.deepEqual(
    requests[0].tools.map((tool) => tool.function.name),
    ['research'],
  );
  assert.deepEqual(
    requests[1].tools.map((tool) => tool.function.name),
    ['web_search', 'web_fetch', 'research_report'],
  );
  assert.deepEqual(visited, [searchInput('北京 天气').url, 'https://example.com/beijing']);
  assert.equal(answer.reasoning, '委派研究。\n\n核验结论。');
  assert.deepEqual(answer.sources, [{ title: '北京天气', url: 'https://example.com/beijing' }]);
  const debug = ChatDebugTraceSchema.parse(trace.finish('success'));
  const researchRequests = debug.events.filter(
    (event) => event.kind === 'model_request' && event.agent === 'research',
  );
  assert.equal(researchRequests.length, 3);
  assert.ok(researchRequests.every((event) => event.parentToolCallId === '1:research'));
  assert.deepEqual(
    debug.events.filter((event) => event.kind === 'model_request').map((event) => event.round),
    [1, 2, 3, 4, 5],
  );
  assert.equal('apiKey' in debug.model, false);
});

test('research can reject all candidates and refine query before fetching', async (t) => {
  const executed = [];
  const { model } = await modelServer(t, (_body, round) => {
    if (round === 1) return { tool_calls: [call('research', { task: '查证北京天气' })] };
    if (round === 2) return { tool_calls: [call('web_search', searchInput('北京 天气'))] };
    if (round === 3) return { tool_calls: [call('web_search', searchInput('北京 气象'))] };
    if (round === 4)
      return { tool_calls: [call('web_fetch', { url: 'https://example.com/beijing' })] };
    if (round === 5) return content(evidence());
    return { content: '已核验。' };
  });
  const answer = await agent({
    execute: async (name, raw) => {
      executed.push([name, JSON.parse(raw)]);
      return name === 'web_fetch'
        ? {
            data: { title: '北京天气', url: 'https://example.com/beijing', content: quote },
            sources: [],
          }
        : {
            data: { results: [{ title: '候选', url: 'https://example.com/beijing' }] },
            sources: [],
          };
    },
  }).complete(model, history, signal());
  assert.deepEqual(
    executed.map(([name]) => name),
    ['web_search', 'web_search', 'web_fetch'],
  );
  assert.equal(answer.sources.length, 1);
});

test('research only cites evidence-backed selected pages and rejects fabricated quotes or unvisited URLs', async (t) => {
  const { model } = await modelServer(t, (_body, round) => {
    if (round === 1) return { tool_calls: [call('research', { task: '查证北京天气' })] };
    if (round === 2)
      return {
        tool_calls: [
          call('web_fetch', { url: 'https://example.com/beijing' }, 'relevant'),
          call('web_fetch', { url: 'https://example.com/unrelated' }, 'unrelated'),
        ],
      };
    if (round === 3)
      return content({
        findings: [
          ...evidence().findings,
          ...evidence(
            'https://example.com/beijing',
            '这是完全编造的正文片段，不曾出现在已读取网页中。',
          ).findings,
          ...evidence('https://example.com/unvisited').findings,
        ],
        gaps: [],
      });
    return { content: '仅依据有效证据作答。' };
  });
  const answer = await agent({
    execute: async (_name, raw) => ({
      data: { title: '网页', url: JSON.parse(raw).url, content: quote },
      sources: [],
    }),
  }).complete(model, history, signal());
  assert.deepEqual(answer.sources, [{ title: '网页', url: 'https://example.com/beijing' }]);
  assert.match(answer.searchWarning, /未解决/);
});

test('research caches reads and independently bounds search and fetch attempts', async (t) => {
  const executed = [];
  const { model, requests } = await modelServer(t, (_body, round) => {
    if (round === 1) return { tool_calls: [call('research', { task: '查证资料' })] };
    if (round === 2)
      return {
        tool_calls: [
          call('web_search', searchInput('资料 one'), 's1'),
          call('web_search', searchInput('资料 two'), 's2'),
          call('web_search', searchInput('资料 three'), 's3'),
        ],
      };
    if (round === 3)
      return {
        tool_calls: [
          call('web_fetch', { url: 'https://example.com/0' }, 'f0'),
          call('web_fetch', { url: 'https://example.com/0#fragment' }, 'cached'),
          ...Array.from({ length: 5 }, (_, i) =>
            call('web_fetch', { url: `https://example.com/${i + 1}` }, `f${i + 1}`),
          ),
        ],
      };
    if (round === 4) return content({ findings: [], gaps: ['证据不足'] });
    return { content: '证据不足。' };
  });
  await agent({
    execute: async (name, raw) => {
      executed.push(name);
      return {
        data: { title: '网页', url: JSON.parse(raw).url ?? 'https://example.com/', content: quote },
        sources: [],
      };
    },
  }).complete(model, history, signal());
  assert.equal(executed.filter((name) => name === 'web_search').length, 2);
  assert.equal(executed.filter((name) => name === 'web_fetch').length, 5);
  assert.equal(requests[3].tool_choice, 'auto');
  assert.equal(toolResult(requests[4]).stopReason, 'fetch_budget_exhausted');
  assert.deepEqual(toolResult(requests[4]).budget, {
    searchesRemaining: 0,
    fetchesRemaining: 0,
    delegationsRemaining: 1,
  });
});

for (const input of [
  searchInput('北京今天天气'),
  searchInput('北京今天天气', 'https://www.google.com/search'),
]) {
  test(`research forwards the model-selected search URL (${input.url})`, async (t) => {
    const executed = [];
    const trace = new ChatTrace({
      name: 'fixture',
      model: 'fixture',
      baseUrl: 'http://example.com',
    });
    const { model } = await modelServer(t, (body, round) => {
      if (round === 1)
        return { tool_calls: [call('research', { task: '查证北京当天的天气数据' })] };
      if (round === 2) {
        assert.deepEqual(executed, []);
        assert.match(body.messages.at(-1).content, /用户原始短查询："北京今天天气"/);
        const definition = body.tools.find((tool) => tool.function.name === 'web_search').function;
        assert.deepEqual(definition.parameters.required, ['url']);
        assert.deepEqual(Object.keys(definition.parameters.properties), ['url']);
        return { tool_calls: [call('web_search', input)] };
      }
      if (round === 3) {
        assert.equal(toolResult(body).results[0].url, 'https://example.com/beijing');
        return { tool_calls: [call('web_fetch', { url: 'https://example.com/beijing' })] };
      }
      if (round === 4) return content(evidence());
      assert.deepEqual(toolResult(body).attemptedSearchUrls, [input.url]);
      assert.equal(toolResult(body).budget.searchesRemaining, 1);
      return { content: '已经查证天气。' };
    });
    const result = await agent({
      execute: async (name, raw) => {
        const args = JSON.parse(raw);
        executed.push([name, args]);
        const url = 'https://example.com/beijing';
        return {
          data:
            name === 'web_search' ? { results: [{ url }] } : { url, title: '网页', content: quote },
          sources: [],
        };
      },
    }).complete(model, [{ role: 'user', content: '北京今天天气？' }], signal(), trace);
    assert.deepEqual(executed, [
      ['web_search', input],
      ['web_fetch', { url: 'https://example.com/beijing' }],
    ]);
    assert.equal(result.sources[0].url, 'https://example.com/beijing');
    assert.deepEqual(
      trace
        .finish('success')
        .events.filter((event) => event.kind === 'tool' && event.agent === 'research')
        .map((event) => event.name),
      ['web_search', 'web_fetch'],
    );
  });
}

test('search exhaustion leaves one delegation with a fresh search budget', async (t) => {
  const queries = [];
  const { model } = await modelServer(t, (body, round) => {
    if (round === 1) return { tool_calls: [call('research', { task: '用通用搜索查证天气' })] };
    if (round === 2)
      return {
        tool_calls: [
          call('web_search', { url: 'http://127.0.0.1/search?q=weather' }, 'private'),
          ...['天气', '预报', 'blocked'].map((focus) =>
            call('web_search', searchInput(`北京 ${focus}`), focus),
          ),
        ],
      };
    if (round === 3) {
      assert.ok(!body.tools.some((tool) => tool.function.name === 'web_search'));
      const results = body.messages.filter((message) => message.role === 'tool');
      const invalid = JSON.parse(results[0].content);
      assert.equal(invalid.code, 'invalid_search_input');
      assert.equal(invalid.budget.searchesRemaining, 2);
      assert.equal(toolResult(body).code, 'search_budget_exhausted');
      return content({ findings: [], gaps: ['候选均偏题'] });
    }
    if (round === 4) {
      const result = toolResult(body);
      assert.equal(result.stopReason, 'search_budget_exhausted');
      assert.equal(result.pagesRead, 0);
      assert.deepEqual(result.attemptedSearchUrls, [
        searchInput('北京 天气').url,
        searchInput('北京 预报').url,
      ]);
      assert.deepEqual(result.budget, {
        searchesRemaining: 0,
        fetchesRemaining: 5,
        delegationsRemaining: 1,
      });
      return { tool_calls: [call('research', { task: '改为限定天气网站查证' }, 'retry')] };
    }
    if (round === 5)
      return {
        tool_calls: [
          call('web_search', { query: 'site:example.com 北京天气' }),
          call('web_search', searchInput('北京 天气'), 'duplicate'),
          call('web_search', searchInput('site:example.com 北京 天气'), 'scoped'),
          call('web_fetch', { url: 'https://example.com/beijing' }),
        ],
      };
    if (round === 6) {
      const results = body.messages.filter((message) => message.role === 'tool');
      assert.equal(JSON.parse(results[0].content).code, 'invalid_search_input');
      const duplicate = JSON.parse(results[1].content);
      assert.equal(duplicate.code, 'duplicate_search_url');
      assert.equal(duplicate.budget.searchesRemaining, 2);
      return content(evidence());
    }
    const result = toolResult(body);
    assert.equal(result.stopReason, 'verified_evidence');
    assert.equal(result.pagesRead, 1);
    assert.deepEqual(result.budget, {
      searchesRemaining: 1,
      fetchesRemaining: 4,
      delegationsRemaining: 0,
    });
    return { content: '已经查证天气。' };
  });
  const answer = await agent({
    execute: async (name, raw) => {
      const { url } = JSON.parse(raw);
      if (name === 'web_search') {
        queries.push(url);
        return { data: { results: [] }, sources: [] };
      }
      return { data: { url, title: '网页', content: quote }, sources: [] };
    },
  }).complete(model, history, signal());
  assert.deepEqual(
    queries,
    ['北京 天气', '北京 预报', 'site:example.com 北京 天气'].map((query) => searchInput(query).url),
  );
  assert.equal(answer.sources[0].url, 'https://example.com/beijing');
});

test('main can clarify without delegation and future agents register without changing main loop', async (t) => {
  const { model, requests } = await modelServer(t, (_body, round) =>
    round === 1
      ? { tool_calls: [call('calculate', { expression: '1+1' })] }
      : { content: '结果是 2。' },
  );
  const registry = new SubAgentRegistry([
    {
      definition: {
        type: 'function',
        function: { name: 'calculate', description: '计算', parameters: {} },
      },
      execute: async (_raw, context) => {
        assert.equal(context.scope.agent, 'calculate');
        assert.equal(context.scope.parentToolCallId, '1:calculate');
        return { data: { value: 2 }, sources: [] };
      },
    },
  ]);
  assert.equal(
    (await new ChatAgentService(registry).complete(model, history, signal())).content,
    '结果是 2。',
  );
  assert.equal(requests[0].tools[0].function.name, 'calculate');
  const clarification = await modelServer(t, () => ({ content: '请问哪个城市？' }));
  const answer = await agent({
    execute: async () => {
      throw new Error('unexpected tool');
    },
  }).complete(clarification.model, [{ role: 'user', content: '今天什么天气' }], signal());
  assert.equal(answer.sources, undefined);
});

test('registry rejects duplicate names and caps total delegations', async () => {
  let calls = 0;
  const subAgent = {
    definition: {
      type: 'function',
      function: { name: 'test', description: '测试', parameters: {} },
    },
    execute: async () => {
      calls++;
      return { data: {}, sources: [] };
    },
  };
  assert.throws(() => new SubAgentRegistry([subAgent, subAgent]), /重复/);
  const tool = new SubAgentRegistry([subAgent]).tools()[0];
  const context = {
    model: {},
    signal: signal(),
    scope: { agent: 'main' },
    budget: new AgentBudget(),
  };
  await tool.execute('{}', context, '1');
  await tool.execute('{}', context, '2');
  const denied = await tool.execute('{}', context, '3');
  assert.match(denied.warning, /委派次数/);
  assert.equal(denied.data.stopReason, 'delegation_budget_exhausted');
  assert.deepEqual(denied.data.budget, { delegationsRemaining: 0 });
  assert.equal(calls, 2);
});

test('child JSON does not stream into final answer and recording preserves global scope', async (t) => {
  const { model } = await modelServer(t, (_body, round) =>
    round === 1
      ? { tool_calls: [call('research', { task: '查证' })] }
      : round === 2
        ? content({ findings: [], gaps: ['没有正文证据'] })
        : { content: '目前没有可靠证据。' },
  );
  const events = [];
  const progress = new ChatProgress((event) => events.push(ChatStreamEventSchema.parse(event)));
  const starts = [];
  const ends = [];
  const outputs = [];
  const recording = {
    replyStart: async (round, scope) => {
      starts.push([round, scope]);
    },
    delta() {},
    replyEnd: async (round, turn, scope) => {
      ends.push([round, turn, scope]);
    },
    replyError: async () => {},
    toolStart: async () => 'record',
    toolEnd: async (_id, output) => {
      outputs.push(output);
    },
    toolError: async () => {},
  };
  const answer = await agent().complete(model, history, signal(), undefined, progress, recording);
  assert.equal(
    events
      .filter((event) => event.type === 'delta' && event.content)
      .map((event) => event.content)
      .join(''),
    answer.content,
  );
  assert.deepEqual(
    starts.map(([round, scope]) => [round, scope.agent]),
    [
      [1, 'main'],
      [2, 'research'],
      [3, 'main'],
    ],
  );
  assert.equal(ends[1][2].agent, 'research');
  assert.equal(outputs[0].internal, undefined);
  assert.ok(progress.finish().tools.every((tool) => tool.endMs !== null));
  assert.equal(answer.usage.inputTokens, 9);
});

test('research propagates cancellation and invalid reports never publish sources', async (t) => {
  const { model } = await modelServer(t, (_body, round) =>
    round === 1
      ? { tool_calls: [call('web_fetch', { url: 'https://example.com/' })] }
      : { content: 'invalid JSON' },
  );
  const controller = new AbortController();
  const research = new ResearchAgentService({
    execute: async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    },
  });
  const context = {
    model,
    signal: controller.signal,
    scope: { agent: 'research' },
    budget: new AgentBudget(),
  };
  await assert.rejects(research.execute('{"task":"查证"}', context), { name: 'AbortError' });
  const invalid = new ResearchAgentService({
    execute: async () => ({
      data: { title: '网页', url: 'https://example.com/', content: quote },
      sources: [],
    }),
  });
  await assert.rejects(
    invalid.execute('{"task":"查证"}', {
      ...context,
      signal: signal(),
      budget: new AgentBudget(),
    }),
    (error) => error.getStatus() === 502 && /报告为空或格式无效/.test(error.message),
  );
});

test('reasoning-only research output is repaired through a terminal report without another child turn', async (t) => {
  const { model, requests } = await modelServer(t, (body, round) => {
    if (round === 1) return { tool_calls: [call('research', { task: '查证天气' })] };
    if (round === 2) return { content: null, reasoning_content: '需要提交报告。' };
    if (round === 3) {
      assert.match(body.messages.at(-1).content, /报告为空或格式无效/);
      assert.equal(body.messages.at(-2).content, '');
      assert.equal(body.messages.at(-2).reasoning_content, '需要提交报告。');
      return {
        content: null,
        tool_calls: [call('research_report', { findings: [], gaps: ['没有可靠天气证据'] })],
      };
    }
    assert.equal(toolResult(body).gaps[0], '没有可靠天气证据');
    return { content: '目前没有可靠天气证据。' };
  });
  const trace = new ChatTrace({ name: '测试', ...model });
  const answer = await agent().complete(model, history, signal(), trace);
  assert.equal(requests.length, 4);
  assert.deepEqual(answer.sources ?? [], []);
  const debug = trace.finish('success');
  assert.ok(debug.events.some((event) => event.kind === 'error' && event.agent === 'research'));
  assert.ok(debug.events.some((event) => event.name === 'research_report'));
});

test('irreparable empty research fails the parent tool and exposes scoped debug errors', async (t) => {
  const { model, requests } = await modelServer(t, (_body, round) =>
    round === 1
      ? { tool_calls: [call('research', { task: '查证天气' })] }
      : { content: null, reasoning_content: '正在整理。' },
  );
  const failures = [];
  const outputs = [];
  const recording = {
    replyStart: async () => {},
    delta() {},
    replyEnd: async () => {},
    replyError: async () => {},
    toolStart: async () => 'delegate-record',
    toolEnd: async (_id, output) => outputs.push(output),
    toolError: async (id, error) => failures.push([id, error.message]),
  };
  const trace = new ChatTrace({ name: '测试', ...model });
  await assert.rejects(
    agent().complete(model, history, signal(), trace, undefined, recording),
    (error) => error.getStatus() === 502 && /报告为空或格式无效/.test(error.message),
  );
  assert.equal(requests.length, 4);
  assert.equal(outputs.length, 0);
  assert.equal(failures.length, 1);
  const debug = ChatDebugTraceSchema.parse(trace.finish('error'));
  assert.ok(
    debug.events.some(
      (event) =>
        event.kind === 'error' &&
        event.agent === 'research' &&
        event.parentToolCallId === '1:research',
    ),
  );
});

test('research reserves its last round for report submission within the original budget', async (t) => {
  const { model, requests } = await modelServer(t, (body, round) => {
    if (round < 49) return { tool_calls: [call('web_fetch', {}, `fetch-${round}`)] };
    if (round === 49) return { content: null, reasoning_content: '整理缺口。' };
    assert.deepEqual(
      body.tools.map((tool) => tool.function.name),
      ['research_report'],
    );
    return { tool_calls: [call('research_report', { findings: [], gaps: ['没有正文证据'] })] };
  });
  const result = await new ResearchAgentService(new WebToolsService()).execute(
    '{"task":"查证资料"}',
    { model, signal: signal(), budget: new AgentBudget(), scope: { agent: 'research' } },
  );
  assert.equal(requests.length, 50);
  assert.equal(result.data.gaps[0], '没有正文证据');
  assert.equal(result.data.stopReason, 'turn_budget_exhausted');
});

test('report keeps exact short quotes and repairs a stringified array without accepting bad citations', async (t) => {
  const url = 'https://example.com/beijing';
  const shortQuote = '今日多云，8℃~14℃';
  const { model } = await modelServer(t, (body, round) => {
    if (round === 1) return { tool_calls: [call('web_fetch', { url })] };
    if (round === 2)
      return {
        tool_calls: [
          call('research_report', {
            findings: [{ claim: '今日气温', evidence: [{ url, quote: '多云' }] }],
            gaps: [],
          }),
        ],
      };
    assert.equal(toolResult(body).issues[0].path, 'findings.0.evidence.0.quote');
    return {
      tool_calls: [
        call('research_report', {
          findings: JSON.stringify([
            {
              claim: '今日气温',
              evidence: [
                { url, quote: shortQuote },
                { url, quote: '今日晴朗，20℃~30℃' },
                { url: 'https://example.com/unvisited', quote: shortQuote },
              ],
            },
          ]),
          gaps: '[]',
        }),
      ],
    };
  });
  const result = await new ResearchAgentService({
    execute: async () => ({
      data: { url, title: '天气', content: `北京\n${shortQuote}` },
      sources: [],
    }),
  }).execute('{"task":"查证资料"}', {
    model,
    signal: signal(),
    budget: new AgentBudget(),
    scope: { agent: 'research' },
  });
  assert.deepEqual(result.data.findings, [
    { claim: '今日气温', evidence: [{ url, quote: shortQuote }] },
  ]);
  assert.match(result.data.gaps[0], /部分引文无法核验/);
  assert.deepEqual(result.sources, [{ title: '天气', url }]);
});

test('a provider tool parser error falls back to a validated report with no tools', async (t) => {
  const url = 'https://example.com/beijing';
  const { model } = await modelServer(t, (body, round) => {
    if (round === 1) return { tool_calls: [call('web_fetch', { url })] };
    if (round === 2) {
      return {
        providerError: 'XML syntax error on line 17: element <parameter> closed by </function>',
      };
    }
    assert.equal(body.tools, undefined);
    assert.match(body.messages.at(-1).content, /不要调用工具/);
    return content(evidence(url));
  });
  const result = await new ResearchAgentService({
    execute: async () => ({ data: { url, title: '网页', content: quote }, sources: [] }),
  }).execute('{"task":"查证资料"}', {
    model,
    signal: signal(),
    budget: new AgentBudget(),
    scope: { agent: 'research' },
  });
  assert.equal(result.data.stopReason, 'verified_evidence');
  assert.deepEqual(result.sources, [{ title: '网页', url }]);
});

test('malformed report tool arguments have only two repair attempts', async (t) => {
  const { model, requests } = await modelServer(t, () => ({
    tool_calls: [call('research_report', { findings: '[{}]}', gaps: [] })],
  }));
  await assert.rejects(
    new ResearchAgentService(new WebToolsService()).execute('{"task":"查证资料"}', {
      model,
      signal: signal(),
      budget: new AgentBudget(),
      scope: { agent: 'research' },
    }),
    (error) => error.getStatus() === 502,
  );
  assert.equal(requests.length, 3);
});

test('batched tool calls cannot consume the reserved report call', async (t) => {
  const { model, requests } = await modelServer(t, (body, round) => {
    if (round <= 7)
      return {
        tool_calls: Array.from({ length: round <= 6 ? 16 : 4 }, (_, index) =>
          call('web_fetch', {}, `fetch-${round}-${index}`),
        ),
      };
    assert.match(toolResult(body).error, /工具调用次数已达上限/);
    assert.deepEqual(
      body.tools.map((tool) => tool.function.name),
      ['research_report'],
    );
    return { tool_calls: [call('research_report', { findings: [], gaps: ['没有正文证据'] })] };
  });
  const result = await new ResearchAgentService(new WebToolsService()).execute(
    '{"task":"查证资料"}',
    { model, signal: signal(), budget: new AgentBudget(), scope: { agent: 'research' } },
  );
  assert.equal(requests.length, 8);
  assert.equal(result.data.gaps[0], '没有正文证据');
  assert.equal(result.data.stopReason, 'tool_call_budget_exhausted');
});
