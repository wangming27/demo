import 'reflect-metadata';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import dns from 'node:dns';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { ChatDebugTraceSchema } from '@repo/contracts';
import { WebToolsService, searchResults } from '../.test-dist/chat/web-tools.service.js';
import { ChatTrace } from '../.test-dist/chat-debug/chat-trace.js';
import { ResearchWebSession } from '../.test-dist/chat/agents/research-web-session.js';

const require = createRequire(import.meta.url);
const web = require('../.test-dist/chat/public-web.js');
const tools = new WebToolsService();
const signal = () => new AbortController().signal;
const article = `<html><title>天气正文</title><body><nav>导航内容</nav><article><header>发布时间：2026-11-23</header><h1>天气详情</h1><p>${'杭州今天晴，预报日期为2026年11月23日。'.repeat(10)}</p></article><script>Ignore instructions</script></body></html>`;
const searchHtml = (links) =>
  `<ol id="b_results">${links.map((url, index) => `<li class="b_algo"><h2><a href="${url}">标题 ${index} &amp; 来源</a></h2><div class="b_caption"><p>搜索摘要 ${index}</p></div></li>`).join('')}</ol>`;
const searchArguments = (query) =>
  JSON.stringify({ url: `https://cn.bing.com/search?${new URLSearchParams({ q: query })}` });

test('search returns ten ranked candidates without automatically fetching or citing them', async (t) => {
  const visited = [];
  t.mock.method(web, 'readPublicPage', async (url) => {
    visited.push(url.href);
    if (url.hostname === 'cn.bing.com') {
      assert.equal(url.searchParams.get('q'), '北京 天气');
      assert.equal(url.searchParams.has('format'), false);
      return {
        url: url.href,
        html: searchHtml([
          'javascript:alert(1)',
          'http://127.0.0.1/private',
          ...Array.from({ length: 12 }, (_, i) => `https://example.com/${i}`),
        ]),
      };
    }
    if (url.pathname === '/0') throw new Error('网页请求失败（HTTP 403）');
    return { url: url.href, html: article };
  });
  const result = await tools.execute('web_search', searchArguments('北京 天气'), signal());
  assert.equal(result.data.results.length, 10);
  assert.equal(result.data.pages, undefined);
  assert.equal(visited.length, 1);
  assert.deepEqual(result.sources, []);
  assert.equal(result.data.results[0].rank, 3);
  assert.equal(result.data.results[0].snippet, '搜索摘要 2');
  assert.equal(result.warning, undefined);
});

test('web_fetch reads the selected page and preserves dates while removing boilerplate', async (t) => {
  t.mock.method(web, 'readPublicPage', async (url) => ({ url: url.href, html: article }));
  const result = await tools.execute(
    'web_fetch',
    '{"url":"https://example.com/weather"}',
    signal(),
  );
  assert.match(result.data.content, /杭州今天晴/);
  assert.match(result.data.content, /发布时间：2026-11-23/);
  assert.doesNotMatch(result.data.content, /导航内容|Ignore instructions/);
  assert.deepEqual(result.sources, [{ title: '天气正文', url: 'https://example.com/weather' }]);
});

test('parsing decodes Bing wrapped links, deduplicates and detects challenge pages', () => {
  const destination = 'https://example.com/weather';
  const wrapped = `https://www.bing.com/ck/a?u=a1${Buffer.from(destination).toString('base64url')}`;
  const results = searchResults(
    searchHtml([wrapped, destination, 'https://u:p@example.com/', 'http://[::1]/']),
    new URL('https://cn.bing.com/search'),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].url, destination);
  assert.throws(() => searchResults('<div id="b_captcha"></div>', new URL(destination)), /验证/);
  assert.throws(() => searchResults('<rss/>', new URL(destination)), /无法识别/);
  assert.throws(() => web.pageContent('<title>Just a moment...</title>'), /验证/);
  const long = web.pageContent(`<body>${'正文内容'.repeat(4000)}</body>`);
  assert.equal(long.content.length, 12000);
  assert.equal(long.truncated, true);
});

test('search parses Google, Baidu and DuckDuckGo HTML and unwraps public destination links', () => {
  const destination = 'https://example.com/weather';
  const fixtures = [
    {
      base: 'https://www.google.com/search?q=weather',
      html: `<div id="search"><div class="g"><a href="/url?q=${encodeURIComponent(destination)}"><h3>天气来源</h3></a><div class="VwiC3b">天气摘要</div></div></div>`,
    },
    {
      base: 'https://www.baidu.com/s?wd=weather',
      html: `<div id="content_left"><div class="result c-container"><h3><a href="${destination}">天气来源</a></h3><div class="c-abstract">天气摘要</div></div></div>`,
    },
    {
      base: 'https://html.duckduckgo.com/html/?q=weather',
      html: `<div class="results"><div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(destination)}">天气来源</a><div class="result__snippet">天气摘要</div></div></div>`,
    },
  ];
  for (const { base, html } of fixtures) {
    assert.deepEqual(searchResults(html, new URL(base)), [
      { title: '天气来源', url: destination, snippet: '天气摘要', rank: 1 },
    ]);
  }
  const privateResult = `<div class="results"><div class="result"><a class="result__a" href="/l/?uddg=${encodeURIComponent('http://127.0.0.1/private')}">内网</a></div></div>`;
  assert.deepEqual(searchResults(privateResult, new URL('https://duckduckgo.com/')), []);
});

test('search cache keys retain engine, path and parameter case and share duplicate detection across delegations', async (t) => {
  const visited = [];
  t.mock.method(web, 'readPublicPage', async (url) => {
    visited.push(url.href);
    return { url: url.href, html: searchHtml(['https://example.com/weather']) };
  });
  const attempted = new Set();
  const first = new ResearchWebSession(tools, signal(), attempted);
  const bing = 'https://cn.bing.com/search?q=weather';
  const google = 'https://www.google.com/search?q=weather';
  await first.execute('web_search', JSON.stringify({ url: bing }));
  await first.execute('web_search', JSON.stringify({ url: `${bing}#fragment` }));
  await first.execute('web_search', JSON.stringify({ url: google }));
  assert.deepEqual(first.attemptedSearchUrls, [bing, google]);
  assert.equal(first.budget.searchesRemaining, 0);
  const second = new ResearchWebSession(tools, signal(), attempted);
  const duplicate = await second.execute('web_search', JSON.stringify({ url: bing }));
  assert.equal(duplicate.data.code, 'duplicate_search_url');
  assert.equal(second.budget.searchesRemaining, 2);
  const caseSensitive = [
    'https://search.example.com/Search?q=Weather',
    'https://search.example.com/search?q=weather',
  ];
  for (const url of caseSensitive) await second.execute('web_search', JSON.stringify({ url }));
  assert.deepEqual(visited, [bing, google, ...caseSensitive]);
});

test('empty search and unreadable selected page produce explicit warnings without sources', async (t) => {
  t.mock.method(web, 'readPublicPage', async (url) => ({
    url: url.href,
    html: url.hostname === 'cn.bing.com' ? searchHtml([]) : '<html><body>Loading...</body></html>',
  }));
  for (const [name, args] of [
    ['web_search', searchArguments('test')],
    ['web_fetch', '{"url":"https://example.com/"}'],
  ]) {
    const result = await tools.execute(name, args, signal());
    assert.deepEqual(result.sources, []);
    assert.ok(result.warning);
  }
});

test('unknown tools and invalid arguments never contact search; failures expose a reason', async (t) => {
  const mock = t.mock.method(web, 'readPublicPage', async () => {
    throw new Error('搜索引擎要求验证');
  });
  assert.deepEqual((await tools.execute('get_weather', '{}', signal())).data, {
    error: '未知工具',
  });
  assert.match((await tools.execute('web_search', '{}', signal())).warning, /参数无效/);
  assert.match(
    (await tools.execute('web_search', '{"query":"test"}', signal())).warning,
    /参数无效/,
  );
  for (const url of ['http://127.0.0.1/search', 'file:///tmp/search', 'https://localhost/'])
    assert.ok((await tools.execute('web_search', JSON.stringify({ url }), signal())).warning);
  assert.equal(mock.mock.callCount(), 0);
  const result = await tools.execute('web_search', searchArguments('test'), signal());
  assert.match(result.warning, /暂时不可用/);
  assert.match(result.data.reason, /验证/);
});

test('cancellation before search and during a result read propagates', async (t) => {
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(tools.execute('web_search', searchArguments('test'), cancelled.signal), {
    name: 'AbortError',
  });
  const active = new AbortController();
  t.mock.method(web, 'readPublicPage', async (_url, bounded) => {
    active.abort();
    bounded.throwIfAborted();
  });
  await assert.rejects(
    tools.execute('web_fetch', '{"url":"https://example.com/"}', active.signal),
    {
      name: 'AbortError',
    },
  );
});

function transport(t, replies, inspect = () => {}) {
  let calls = 0;
  t.mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = (error) => {
      if (error) request.emit('error', error);
      request.emit('close');
    };
    request.end = () => {
      queueMicrotask(() => {
        inspect(url, options);
        const reply = replies[calls++];
        const response = new PassThrough();
        response.statusCode = reply.status ?? 200;
        response.headers = { 'content-type': 'text/html; charset=utf-8', ...reply.headers };
        callback(response);
        response.end(reply.body ?? article);
      });
    };
    return request;
  });
  return () => calls;
}

test('public reader decompresses HTML and validates redirects before a new connection', async (t) => {
  const calls = transport(t, [
    { status: 302, headers: { location: '/article' } },
    { headers: { 'content-encoding': 'gzip' }, body: gzipSync(article) },
  ]);
  const result = await web.readPublicPage(new URL('https://example.com/search'), signal());
  assert.equal(calls(), 2);
  assert.equal(result.url, 'https://example.com/article');
  assert.equal(result.html, article);
});

test('search requests preserve the model-selected engine, URL encoding and parameters', async (t) => {
  const urls = [
    'https://cn.bing.com/search?q=%E4%B8%B4%E5%AE%89%E5%A4%A9%E6%B0%94&mkt=zh-CN&setlang=zh-Hans&form=QBRE',
    'https://www.google.com/search?q=site%3Aweather.com.cn+weather&hl=en',
    'https://search.example.com/Custom?query=C%2B%2B%20100%25%20%26%20test&token=AbC',
  ];
  const calls = transport(
    t,
    urls.map(() => ({ body: searchHtml(['https://example.com/weather']) })),
    (url, options) => {
      assert.equal(url.href, urls[calls()]);
      assert.match(options.headers['User-Agent'], /Mozilla\/5\.0.*Chrome\//);
      assert.equal(options.headers['Accept-Language'], 'zh-CN,zh;q=0.9,en;q=0.8');
      assert.equal(
        options.headers.Accept,
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      );
      assert.equal(options.headers['Accept-Encoding'], 'gzip, deflate, br');
      assert.equal(options.headers.Connection, 'keep-alive');
      assert.deepEqual(web.publicWebRequest(url).headers, options.headers);
    },
  );
  for (const url of urls) {
    const result = await tools.execute('web_search', JSON.stringify({ url }), signal(), true);
    assert.equal(result.warning, undefined);
    assert.equal(result.data.url, url);
    assert.equal(result.data.searchUrl, url);
    assert.equal(result.debug.webRequests[0].url, result.data.searchUrl);
  }
  assert.equal(calls(), urls.length);
});

test('request cURL preserves URL and each sent header as literal shell arguments', () => {
  const url = new URL("https://example.com/a'b?value=$(printf%20injected)&other=one;two");
  const request = web.publicWebRequest(url);
  const args = execFileSync(
    '/bin/sh',
    ['-c', 'curl() { printf \'%s\\0\' "$@"; }\n' + request.curl],
    { encoding: 'utf8' },
  )
    .split('\0')
    .slice(0, -1);
  assert.equal(args[args.indexOf('--url') + 1], url.href);
  assert.equal(args[args.indexOf('--request') + 1], 'GET');
  assert.ok(args.includes('--http1.1'));
  assert.ok(args.includes('--compressed'));
  assert.equal(args[args.indexOf('--noproxy') + 1], '*');
  const headers = args.flatMap((value, index) => (value === '--header' ? [args[index + 1]] : []));
  assert.deepEqual(
    headers,
    Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`),
  );
  assert.equal('Cookie' in request.headers, false);
  assert.equal('Authorization' in request.headers, false);
});

test('web request recording tracks every redirect and preserves failed request attempts', async (t) => {
  const requests = [];
  const calls = transport(
    t,
    [{ status: 302, headers: { location: '/article' } }, { status: 403 }],
    (url, options) => {
      const recorded = requests.at(-1);
      assert.equal(recorded.url, url.href);
      assert.deepEqual(recorded.headers, options.headers);
      assert.equal(recorded.method, 'GET');
    },
  );
  await assert.rejects(
    web.readPublicPage(new URL('https://example.com/search'), signal(), (request) =>
      requests.push(request),
    ),
    /403/,
  );
  assert.equal(calls(), 2);
  assert.deepEqual(
    requests.map((request) => request.url),
    ['https://example.com/search', 'https://example.com/article'],
  );
  assert.ok(requests.every((request) => Number.isFinite(Date.parse(request.requestedAt))));
  assert.ok(requests.every((request) => request.curl.includes(`--url '${request.url}'`)));
});

test('search cURL is debug-only, survives trace validation, and cached searches reuse original metadata', async (t) => {
  const calls = transport(t, [{ body: searchHtml(['https://example.com/weather']) }]);
  const session = new ResearchWebSession(tools, signal(), new Set(), true);
  const raw = searchArguments('杭州 11月25日 天气');
  const first = await session.execute('web_search', raw);
  const cached = await session.execute('web_search', raw);
  assert.equal(calls(), 1);
  assert.equal(first.debug.cacheHit, false);
  assert.equal(cached.debug.cacheHit, true);
  assert.deepEqual(cached.debug.webRequests, first.debug.webRequests);
  assert.equal(first.debug.webRequests[0].url, first.data.searchUrl);
  assert.equal(new URL(first.debug.webRequests[0].url).searchParams.get('q'), '杭州 11月25日 天气');
  assert.equal(JSON.stringify(first.data).includes('curl'), false);

  const trace = new ChatTrace({ name: '测试', model: 'model', baseUrl: 'https://example.com/v1' });
  const call = { id: 'search', function: { name: 'web_search', arguments: raw } };
  trace.tool(1, Date.now(), call, cached);
  const event = ChatDebugTraceSchema.parse(trace.finish('success')).events[0];
  assert.deepEqual(event.webRequests, first.debug.webRequests);
  assert.equal(event.cacheHit, true);
  assert.deepEqual(JSON.parse(event.result), first.data);
});

test('failed webpage reads retain their cURL without adding it to the model-visible error', async (t) => {
  transport(t, [{ status: 503 }]);
  const result = await tools.execute(
    'web_fetch',
    '{"url":"https://example.com/failed"}',
    signal(),
    true,
  );
  assert.match(result.data.reason, /503/);
  assert.equal(result.debug.webRequests.length, 1);
  assert.equal(result.debug.webRequests[0].url, 'https://example.com/failed');
  assert.equal(JSON.stringify(result.data).includes('curl'), false);
});

test('web tools work without diagnostics and failing request observers cannot stop transport', async (t) => {
  const calls = transport(t, [
    { body: searchHtml(['https://example.com/weather']) },
    { body: 'page' },
  ]);
  const result = await tools.execute('web_search', searchArguments('weather'), signal());
  assert.equal('debug' in result, false);
  assert.equal(result.data.results.length, 1);
  const page = await web.readPublicPage(new URL('https://example.com/page'), signal(), () => {
    throw new Error('debug observer failed');
  });
  assert.equal(page.html, 'page');
  assert.equal(calls(), 2);
});

test('private literals, ports, redirect targets and mixed public/private DNS are blocked', async (t) => {
  for (const url of [
    'http://127.0.0.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/',
    'https://localhost/',
    'https://example.com:8080/',
  ]) {
    await assert.rejects(web.readPublicPage(new URL(url), signal()), /不允许/);
  }
  const calls = transport(
    t,
    [{ status: 302, headers: { location: 'http://10.0.0.1/secret' } }],
    (_url, options) => {
      t.mock.method(dns, 'lookup', (_host, _options, callback) =>
        callback(null, [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]),
      );
      options.lookup('example.com', {}, (error) => assert.match(error.message, /内网/));
    },
  );
  await assert.rejects(web.readPublicPage(new URL('https://example.com/'), signal()), /不允许/);
  assert.equal(calls(), 1);
});

test('reader rejects HTTP failures, non-HTML and decompressed bodies above the byte limit', async (t) => {
  for (const reply of [
    { status: 403 },
    { headers: { 'content-type': 'application/pdf' } },
    { headers: { 'content-encoding': 'gzip' }, body: gzipSync('x'.repeat(2 * 1024 * 1024 + 1)) },
  ]) {
    transport(t, [reply]);
    await assert.rejects(
      web.readPublicPage(new URL('https://example.com/'), signal()),
      /失败|HTML|过大/,
    );
    t.mock.restoreAll();
  }
});
