import { Injectable } from '@nestjs/common';
import { load } from 'cheerio';
import { z } from 'zod';
import { pageContent, publicWebUrl, readPublicPage } from './public-web';
import { webUrlInputSchema } from './research-query';
import type { ToolResult } from './agents/agent-types';
import type { ChatWebRequest } from '@repo/contracts';
export type { ToolResult } from './agents/agent-types';

type Source = ToolResult['sources'][number];
const searchLayouts = [
  {
    root: '#b_results',
    items: 'li.b_algo',
    link: 'h2 a',
    snippet: '.b_caption p, .b_snippet',
  },
  {
    root: '#search, #rso',
    items: '.g:has(h3), .MjjYud:has(h3):not(:has(.g))',
    link: 'a:has(h3)',
    snippet: '.VwiC3b, .IsZvec',
  },
  {
    root: '#content_left',
    items: '.result, .c-container:has(h3)',
    link: 'h3 a',
    snippet: '.c-abstract, .content-right_8Zs40, [class*="content-right"]',
  },
  {
    root: '.results, #links',
    items: '.result',
    link: '.result__a, .result-link',
    snippet: '.result__snippet, .result-snippet',
  },
] as const;

export function searchResults(
  html: string,
  base: URL,
): (Source & { snippet: string; rank: number })[] {
  const $ = load(html);
  if (
    $('#b_captcha, #captcha, #challenge-form, .g-recaptcha, form[action*="/sorry/"]').length ||
    /^(Just a moment|Access Denied|人机验证|安全验证|验证码)/i.test($('title').text().trim())
  )
    throw new Error('搜索引擎要求验证');
  const layout = searchLayouts.find((layout) => $(layout.root).length);
  if (!layout) throw new Error('无法识别搜索结果页，请更换搜索 URL 或使用 web_fetch');
  const results: (Source & { snippet: string; rank: number })[] = [];
  $(layout.root)
    .find(layout.items)
    .each((index, element) => {
      if (results.length >= 10) return;
      const item = $(element);
      const link = item.find(layout.link).first();
      try {
        let url = publicWebUrl(link.attr('href') ?? '', base);
        // Bing's normal result links can wrap the destination in a1 + base64url.
        if (/(^|\.)bing\.com$/i.test(url.hostname) && url.pathname === '/ck/a') {
          const target = url.searchParams.get('u');
          if (!target?.startsWith('a1')) return;
          url = publicWebUrl(Buffer.from(target.slice(2), 'base64url').toString('utf8'));
        }
        if (/(^|\.)duckduckgo\.com$/i.test(url.hostname) && url.searchParams.has('uddg'))
          url = publicWebUrl(url.searchParams.get('uddg')!);
        else if (/(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === '/url') {
          const target = url.searchParams.get('q') ?? url.searchParams.get('url');
          if (!target) return;
          url = publicWebUrl(target);
        }
        const title = link.text().replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!title || !link.attr('href') || results.some((result) => result.url === url.href))
          return;
        results.push({
          title,
          url: url.href,
          rank: index + 1,
          snippet: item.find(layout.snippet).first().text().trim().slice(0, 1500),
        });
      } catch {
        // Invalid or private result links are never opened.
      }
    });
  return results;
}

@Injectable()
export class WebToolsService {
  async execute(
    name: string,
    rawArguments: string,
    signal: AbortSignal,
    collectDebug = false,
  ): Promise<ToolResult> {
    signal.throwIfAborted();
    const webRequests: ChatWebRequest[] | undefined = collectDebug ? [] : undefined;
    try {
      const args: unknown = JSON.parse(rawArguments);
      let result: ToolResult;
      if (name === 'web_search')
        result = await this.search(webUrlInputSchema.parse(args).url, signal, webRequests);
      else if (name === 'web_fetch')
        result = await this.fetch(webUrlInputSchema.parse(args).url, signal, webRequests);
      else return { data: { error: '未知工具' }, sources: [], warning: '模型请求了未知的联网工具' };
      return { ...result, ...(webRequests ? { debug: { webRequests, cacheHit: false } } : {}) };
    } catch (error) {
      signal.throwIfAborted();
      const warning =
        error instanceof z.ZodError || error instanceof SyntaxError
          ? '联网工具参数无效，请提供完整 URL'
          : '联网查询暂时不可用，请稍后重试';
      return {
        data: { error: warning, reason: error instanceof Error ? error.message : '未知错误' },
        sources: [],
        warning,
        ...(webRequests?.length ? { debug: { webRequests, cacheHit: false } } : {}),
      };
    }
  }

  private async search(
    value: string,
    signal: AbortSignal,
    webRequests?: ChatWebRequest[],
  ): Promise<ToolResult> {
    const url = publicWebUrl(value);
    const searchPage = await readPublicPage(
      url,
      signal,
      webRequests ? (request) => webRequests.push(request) : undefined,
    );
    const results = searchResults(searchPage.html, new URL(searchPage.url));
    const warning = !results.length ? '未找到可用的搜索结果' : undefined;
    return {
      data: {
        url: url.href,
        searchUrl: searchPage.url,
        retrievedAt: new Date().toISOString(), // ignore_security_alert
        results,
        ...(warning ? { warning } : {}),
      },
      sources: [],
      ...(warning ? { warning } : {}),
    };
  }

  private async fetch(
    value: string,
    signal: AbortSignal,
    webRequests?: ChatWebRequest[],
  ): Promise<ToolResult> {
    const page = await readPublicPage(
      publicWebUrl(value),
      signal,
      webRequests ? (request) => webRequests.push(request) : undefined,
    );
    const body = pageContent(page.html);
    return {
      data: { url: page.url, ...body, retrievedAt: new Date().toISOString() },
      sources: [{ title: body.title || page.url.slice(0, 300), url: page.url }],
    };
  }
}
