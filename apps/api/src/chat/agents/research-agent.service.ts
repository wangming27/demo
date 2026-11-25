import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { z } from 'zod';
import { WebToolsService } from '../web-tools.service';
import { ResearchWebSession } from './research-web-session';
import { runAgent } from './agent-runtime';
import type { AgentContext, AgentTool, SubAgent, ToolResult } from './agent-types';
import { researchSystemPrompt } from '../prompts/agent-prompts';
import { promptText, toolPrompt } from '../prompts/prompt-store';
import { researchAgentLimits } from './agent-limits';

const taskSchema = z.object({ task: z.string().trim().min(1).max(6000) }).strict();
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const minQuoteLength = 6;
const maxQuoteLength = 1000;
function decodeArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded) ? decoded : value;
  } catch {
    return value;
  }
}

const reportSchema = z
  .object({
    findings: z.preprocess(
      decodeArray,
      z
        .array(
          z.object({
            claim: z.string().trim().min(1).max(1500),
            evidence: z
              .array(
                z.object({
                  url: z.string().url().max(2048),
                  quote: z
                    .string()
                    .max(maxQuoteLength)
                    .transform(normalize)
                    .pipe(z.string().min(minQuoteLength)),
                }),
              )
              .min(1)
              .max(3),
          }),
        )
        .max(12),
    ),
    gaps: z.preprocess(decodeArray, z.array(z.string().trim().min(1).max(500)).max(10)),
  })
  .strict();
const invalidReportMessage = '研究模型未提交有效报告（报告为空或格式无效），请重试';
function reportStopReason(
  findingsCount: number,
  pagesRead: number,
  budget: ResearchWebSession['budget'],
  completionLimit: Awaited<ReturnType<typeof runAgent>>['completionLimit'],
) {
  if (findingsCount > 0) return 'verified_evidence';
  if (completionLimit) return completionLimit;
  if (budget.fetchesRemaining === 0) return 'fetch_budget_exhausted';
  if (budget.searchesRemaining === 0) return 'search_budget_exhausted';
  return pagesRead === 0 ? 'no_pages_read' : 'insufficient_evidence';
}

function checkReport(content: string | null | undefined) {
  let raw: unknown;
  try {
    raw = JSON.parse(content ?? '');
  } catch {
    return { ok: false as const, issues: [{ path: '$', message: '请提交一个合法的 JSON 对象' }] };
  }
  const result = reportSchema.safeParse(raw);
  if (result.success) return { ok: true as const, report: result.data };
  return {
    ok: false as const,
    issues: result.error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.length ? issue.path.join('.') : '$',
      message: issue.message,
    })),
  };
}

@Injectable()
export class ResearchAgentService implements SubAgent {
  readonly definition: SubAgent['definition'] = {
    type: 'function',
    function: {
      name: 'research',
      description: toolPrompt('research'),
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: toolPrompt('research', 'task') },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
  };

  constructor(private readonly webTools: WebToolsService) {}

  async execute(rawArguments: string, context: AgentContext): Promise<ToolResult> {
    context.signal.throwIfAborted();
    let task: string;
    try {
      task = taskSchema.parse(JSON.parse(rawArguments)).task;
    } catch {
      return {
        data: {
          error: '研究任务参数无效',
          stopReason: 'invalid_task',
          budget: { delegationsRemaining: context.budget.delegationsRemaining },
        },
        sources: [],
        warning: '研究任务参数无效',
      };
    }
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(researchAgentLimits.timeoutMs),
    ]);
    // State belongs to this invocation, never the singleton service.
    const web = new ResearchWebSession(
      this.webTools,
      signal,
      context.attemptedSearchUrls,
      !!context.trace,
    );
    const pages = web.pages;
    const initialQuery = context.attemptedSearchUrls?.size ? undefined : context.initialSearchQuery;
    const reportTool: AgentTool = {
      definition: {
        type: 'function',
        function: {
          name: 'research_report',
          description: toolPrompt('research_report'),
          parameters: {
            type: 'object',
            properties: {
              findings: {
                type: 'array',
                maxItems: 12,
                items: {
                  type: 'object',
                  properties: {
                    claim: { type: 'string', minLength: 1, maxLength: 1500 },
                    evidence: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 3,
                      items: {
                        type: 'object',
                        properties: {
                          url: { type: 'string', format: 'uri', maxLength: 2048 },
                          quote: {
                            type: 'string',
                            minLength: minQuoteLength,
                            maxLength: maxQuoteLength,
                          },
                        },
                        required: ['url', 'quote'],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ['claim', 'evidence'],
                  additionalProperties: false,
                },
              },
              gaps: {
                type: 'array',
                maxItems: 10,
                items: { type: 'string', minLength: 1, maxLength: 500 },
              },
            },
            required: ['findings', 'gaps'],
            additionalProperties: false,
          },
        },
      },
      execute: (raw) => {
        const checked = checkReport(raw);
        if (!checked.ok) {
          return Promise.resolve({
            data: {
              error: invalidReportMessage,
              issues: checked.issues,
              hint: promptText('report-repair'),
            },
            sources: [],
            warning: invalidReportMessage,
          });
        }
        return Promise.resolve({
          data: checked.report,
          sources: [],
          finalContent: JSON.stringify(checked.report),
        });
      },
    };
    const tool = (name: 'web_search' | 'web_fetch'): AgentTool => ({
      definition: {
        type: 'function',
        function: {
          name,
          description: toolPrompt(name),
          parameters: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                format: 'uri',
                maxLength: 2048,
                description: toolPrompt(name, 'url'),
              },
            },
            required: ['url'],
            additionalProperties: false,
          },
        },
      },
      execute: async (raw: string) => {
        signal.throwIfAborted();
        return web.execute(name, raw);
      },
    });
    try {
      const { turn, completionLimit } = await runAgent(
        { ...context, signal },
        [
          {
            role: 'system',
            content: researchSystemPrompt(minQuoteLength, maxQuoteLength),
          },
          {
            role: 'user',
            content: initialQuery
              ? `${task}\n\n用户原始短查询：${JSON.stringify(initialQuery)}。可参考它组织搜索 URL。`
              : task,
          },
        ],
        [tool('web_search'), tool('web_fetch'), reportTool],
        {
          turns: researchAgentLimits.turns,
          calls: researchAgentLimits.calls,
          completionTool: 'research_report',
          recoverToolError: (error) =>
            error instanceof BadGatewayException &&
            /HTTP 500.*XML syntax error.*(?:parameter|function)/i.test(error.message)
              ? promptText('research-recovery')
              : undefined,
          isToolAvailable: (name) => name !== 'web_search' || web.budget.searchesRemaining > 0,
          validateFinal: (content) => checkReport(content).ok,
          invalidFinalMessage: invalidReportMessage,
        },
      );
      const checked = checkReport(turn.content);
      if (!checked.ok) throw new BadGatewayException(invalidReportMessage);
      const { report } = checked;
      const sources: ToolResult['sources'] = [];
      const gaps = [...report.gaps];
      const findings = report.findings.flatMap((finding) => {
        // Reject unvisited URLs and fabricated quotations. Relevance is judged by the agent.
        const evidence = finding.evidence.filter((evidence) => {
          const page = pages.get(evidence.url);
          return page && normalize(page.content).includes(evidence.quote);
        });
        if (!evidence.length) {
          if (gaps.length < 10) gaps.push(`缺少可核验的正文证据：${finding.claim}`.slice(0, 500));
          return [];
        }
        if (evidence.length < finding.evidence.length && gaps.length < 10)
          gaps.push(`部分引文无法核验，请仅采用剩余引文支持的内容：${finding.claim}`.slice(0, 500));
        for (const citation of evidence) {
          const page = pages.get(citation.url)!;
          if (sources.length < 20 && !sources.some((source) => source.url === page.url))
            sources.push({ title: page.title || page.url.slice(0, 300), url: page.url });
        }
        return [{ claim: finding.claim, evidence }];
      });
      const warning = !findings.length
        ? '研究未获得可核验的相关正文证据'
        : gaps.length
          ? '研究仍有未解决的问题，请结合证据和缺口回答'
          : undefined;
      const pagesRead = pages.size;
      const budget = { ...web.budget, delegationsRemaining: context.budget.delegationsRemaining };
      return {
        data: {
          task,
          findings,
          gaps,
          stopReason: reportStopReason(findings.length, pagesRead, budget, completionLimit),
          budget,
          attemptedSearchUrls: web.attemptedSearchUrls,
          pagesRead,
          sources,
          ...(warning ? { warning } : {}),
        },
        sources,
        ...(warning ? { warning } : {}),
      };
    } catch (error) {
      context.signal.throwIfAborted();
      if (signal.aborted) throw new GatewayTimeoutException('研究子任务超时，未完成证据核验');
      if (error instanceof HttpException) throw error;
      throw new BadGatewayException('研究子任务执行失败，请重试', { cause: error });
    }
  }
}
