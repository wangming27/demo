import { Injectable } from '@nestjs/common';
import type { ChatCompletionResponse } from '@repo/contracts';
import { load } from 'cheerio';
import { z } from 'zod';
import { pageContent, publicWebUrl, readPublicPage } from './public-web';

type Source = NonNullable<ChatCompletionResponse['sources']>[number];
export interface ToolResult {
  data: unknown;
  sources: Source[];
  warning?: string;
}
const searchArgs = z.object({ query: z.string().trim().min(1).max(300) }).strict();

export function searchResults(html: string, base: URL): (Source & { snippet: string })[] {
  const $ = load(html);
  if ($('#b_captcha, #captcha, #challenge-form').length) throw new Error('搜索引擎要求验证');
  if (!$('#b_results').length) throw new Error('无法识别搜索结果页');
  const results: (Source & { snippet: string })[] = [];
  $('#b_results > li.b_algo').each((_index, element) => {
    if (results.length >= 5) return;
    const item = $(element);
    const link = item.find('h2 a').first();
    try {
      let url = publicWebUrl(link.attr('href') ?? '', base);
      // Bing's normal result links can wrap the destination in a1 + base64url.
      if (/(^|\.)bing\.com$/i.test(url.hostname) && url.pathname === '/ck/a') {
        const target = url.searchParams.get('u');
        if (!target?.startsWith('a1')) return;
        url = publicWebUrl(Buffer.from(target.slice(2), 'base64url').toString('utf8'));
      }
      const title = link.text().replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!title || !link.attr('href') || results.some((result) => result.url === url.href)) return;
      results.push({
        title,
        url: url.href,
        snippet: item.find('.b_caption p, .b_snippet').first().text().trim().slice(0, 1500),
      });
    } catch {
      // Invalid or private result links are never opened.
    }
  });
  return results;
}

@Injectable()
export class WebToolsService {
  async execute(name: string, rawArguments: string, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    try {
      const args: unknown = JSON.parse(rawArguments);
      if (name === 'web_search') return await this.search(searchArgs.parse(args).query, signal);
      return { data: { error: '未知工具' }, sources: [], warning: '模型请求了未知的联网工具' };
    } catch (error) {
      signal.throwIfAborted();
      const warning =
        error instanceof z.ZodError || error instanceof SyntaxError
          ? '联网工具参数无效，请明确搜索内容'
          : '联网查询暂时不可用，请稍后重试';
      return {
        data: { error: warning, reason: error instanceof Error ? error.message : '未知错误' },
        sources: [],
        warning,
      };
    }
  }

  private async search(query: string, signal: AbortSignal): Promise<ToolResult> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
    // Same GET endpoint and query field submitted by the ordinary Bing search form.
    const url = new URL('https://cn.bing.com/search');
    url.searchParams.set('q', query);
    const searchPage = await readPublicPage(url, bounded);
    const results = searchResults(searchPage.html, new URL(searchPage.url));
    const pages: (Source & { content: string; truncated: boolean })[] = [];
    const failures: (Source & { error: string })[] = [];
    // Trust the search engine's relevance ranking; try up to five, read up to three.
    for (const result of results) {
      signal.throwIfAborted();
      if (pages.length >= 3 || bounded.aborted) break;
      try {
        const page = await readPublicPage(new URL(result.url), bounded);
        const body = pageContent(page.html);
        if (pages.some((item) => item.url === page.url)) continue;
        pages.push({
          title: body.title || result.title,
          url: page.url,
          content: body.content,
          truncated: body.truncated,
        });
      } catch (error) {
        signal.throwIfAborted();
        failures.push({
          title: result.title,
          url: result.url,
          error: error instanceof Error ? error.message : '网页读取失败',
        });
      }
    }
    const warning = !results.length
      ? '未找到可用的搜索结果'
      : !pages.length
        ? '找到搜索结果，但未能读取网页正文；搜索摘要不足以确认事实'
        : failures.length || bounded.aborted
          ? '部分搜索结果网页未能读取，已返回成功读取的正文'
          : undefined;
    return {
      data: {
        query,
        searchUrl: searchPage.url,
        retrievedAt: new Date().toISOString(),
        results,
        pages,
        failures,
        ...(warning ? { warning } : {}),
      },
      sources: pages.map(({ title, url: sourceUrl }) => ({ title, url: sourceUrl })),
      ...(warning ? { warning } : {}),
    };
  }
}
