import { z } from 'zod';
import { publicWebUrl } from '../public-web';
import { WebToolsService } from '../web-tools.service';
import type { ToolResult } from './agent-types';
import { researchAgentLimits } from './agent-limits';
import { webUrlInputSchema } from '../research-query';

const pageSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  content: z.string(),
});

export class ResearchWebSession {
  readonly pages = new Map<string, z.output<typeof pageSchema>>();
  private readonly searchUrls: string[] = [];
  private readonly cache = new Map<string, ToolResult>();
  private searches = 0;
  private fetches = 0;
  constructor(
    private readonly web: WebToolsService,
    private readonly signal: AbortSignal,
    private readonly requestSearchUrls = new Set<string>(),
    private readonly collectDebug = false,
  ) {}

  get attemptedSearchUrls() {
    return [...this.searchUrls];
  }

  get budget() {
    return {
      searchesRemaining: researchAgentLimits.searches - this.searches,
      fetchesRemaining: researchAgentLimits.fetches - this.fetches,
    };
  }

  async execute(name: 'web_search' | 'web_fetch', raw: string): Promise<ToolResult> {
    this.signal.throwIfAborted();
    let key: string;
    let url: string;
    const search = name === 'web_search';
    try {
      const args: unknown = JSON.parse(raw);
      url = publicWebUrl(webUrlInputSchema.parse(args).url).href;
      key = `${search ? 'search' : 'fetch'}:${url}`;
    } catch {
      return {
        data: {
          error: '联网工具参数或地址无效，请提供完整的公开 HTTP/HTTPS URL',
          code: search ? 'invalid_search_input' : 'invalid_fetch_input',
          budget: this.budget,
        },
        sources: [],
      };
    }
    const previous = this.cache.get(key);
    if (previous)
      return {
        ...previous,
        ...(previous.debug ? { debug: { ...previous.debug, cacheHit: true } } : {}),
      };
    const budget = this.budget;
    if (search && this.requestSearchUrls.has(key))
      return {
        data: {
          error: '本次聊天已请求过该搜索 URL，请更换查询或搜索引擎',
          code: 'duplicate_search_url',
          url,
          budget,
        },
        sources: [],
      };
    if ((search ? budget.searchesRemaining : budget.fetchesRemaining) === 0)
      return {
        data: {
          error: `${name} 次数已达上限，请使用已有证据完成报告`,
          code: search ? 'search_budget_exhausted' : 'fetch_budget_exhausted',
          budget,
        },
        sources: [],
      };
    if (search) {
      this.searches++;
      this.requestSearchUrls.add(key);
      this.searchUrls.push(url);
    } else {
      this.fetches++;
    }
    const result = await this.web.execute(name, raw, this.signal, this.collectDebug);
    const parsed = name === 'web_fetch' ? pageSchema.safeParse(result.data) : undefined;
    if (parsed?.success) {
      this.pages.set(parsed.data.url, parsed.data);
      this.cache.set(`fetch:${parsed.data.url}`, result);
    }
    this.cache.set(key, result);
    return result;
  }
}
