import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { BadGatewayException, BadRequestException, GatewayTimeoutException } from '@nestjs/common';
import { ChatCompletionResponseSchema } from '@repo/contracts';
import type { ChatCompletionResponse, ChatMessage } from '@repo/contracts';
import { z } from 'zod';
import type { ChatTrace } from './chat-trace';
import type { ModelObserver } from './chat-progress';
import { ModelStream } from './model-stream';
import type { ChatRecording } from './chat-recording';
import type { AgentScope } from './agents/agent-types';
import { getModelTimeouts } from '../config/environment';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
const publicIpv6 = new BlockList();
publicIpv6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');

export function modelEndpoint(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const localDevelopment =
    process.env['NODE_ENV'] !== 'production' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localDevelopment)) {
    throw new BadRequestException('外部模型 API 必须使用 HTTPS；本地开发允许 HTTP localhost');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url;
}

function allowedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && publicIpv6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

const upstreamSchema = z.object({
  // Optional metadata must never invalidate an otherwise usable answer.
  usage: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().max(200).nullish(),
        message: z.object({
          content: z.string().nullish(),
          reasoning_content: z.string().nullish(),
          reasoning: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1).max(200),
                type: z.literal('function'),
                function: z.object({
                  name: z.string().max(100),
                  arguments: z.string().max(16_000),
                }),
              }),
            )
            .max(16)
            .optional(),
        }),
      }),
    )
    .min(1),
});

export type ModelTurn = z.output<typeof upstreamSchema>['choices'][number]['message'] & {
  usage?: ChatCompletionResponse['usage'];
  finishReason?: string | null;
};
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z
  .object({ prompt_tokens: tokenCount, completion_tokens: tokenCount })
  .refine((usage) => Number.isSafeInteger(usage.prompt_tokens + usage.completion_tokens));

export function normalizeUsage(value: unknown): ChatCompletionResponse['usage'] {
  const parsed = usageSchema.safeParse(value);
  return parsed.success
    ? { inputTokens: parsed.data.prompt_tokens, outputTokens: parsed.data.completion_tokens }
    : undefined;
}
export type ModelContent =
  | string
  | null
  | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
export type ModelMessage =
  | {
      role: 'system' | 'user' | 'assistant';
      content: ModelContent;
      tool_calls?: ModelTurn['tool_calls'];
      reasoning_content?: string;
    }
  | { role: 'tool'; content: string; tool_call_id: string };
export interface ModelTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function upstreamErrorMessage(
  status: number | undefined,
  body: string,
  apiKey: string,
  hasImages: boolean,
): string {
  if (status === 401 || status === 403) return '模型 API 鉴权失败，请检查 API Key';
  if (status === 429) return '模型 API 请求过于频繁，请稍后重试';
  let detail = '';
  try {
    const parsed = z
      .object({
        error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
        message: z.string().optional(),
      })
      .parse(JSON.parse(body));
    detail =
      (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ??
      parsed.message ??
      '';
  } catch {
    // HTML and unrecognized upstream bodies are not useful diagnostics.
  }
  if (apiKey) detail = detail.split(apiKey).join('[已隐藏]');
  detail = detail
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, 500);
  if (detail) return `模型 API 请求失败（HTTP ${status ?? '未知'}）：${detail}`;
  return hasImages && status === 400
    ? '模型无法处理图片，请确认所选模型支持视觉输入且推理服务版本支持该模型'
    : `模型 API 请求失败（HTTP ${status ?? '未知'}），请检查地址、模型名称和请求格式`;
}

export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.images?.length
      ? [
          { type: 'text' as const, text: message.content || '请描述这张图片的内容。' },
          ...message.images.map((image) => ({
            type: 'image_url' as const,
            image_url: { url: image.dataUrl },
          })),
        ]
      : message.content,
  }));
}

export async function callModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  trace?: ChatTrace,
  observer?: ModelObserver,
  recording?: ChatRecording,
): Promise<ChatCompletionResponse> {
  const message = await callModelTurn(
    baseUrl,
    apiKey,
    model,
    toModelMessages(messages),
    signal,
    undefined,
    'auto',
    trace,
    1,
    observer,
    recording,
  );
  const reasoning = message.reasoning_content?.trim() || message.reasoning?.trim();
  try {
    return ChatCompletionResponseSchema.parse({
      content: message.content,
      ...(message.usage ? { usage: message.usage } : {}),
      ...(reasoning ? { reasoning } : {}),
    });
  } catch {
    throw new BadGatewayException('模型返回了无法识别的内容');
  }
}

export async function callModelTurn(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ModelMessage[],
  signal: AbortSignal,
  tools?: ModelTool[],
  toolChoice: 'auto' | 'none' = 'auto',
  trace?: ChatTrace,
  round = 1,
  observer?: ModelObserver,
  recording?: ChatRecording,
  scope?: AgentScope,
): Promise<ModelTurn> {
  signal.throwIfAborted();
  await recording?.replyStart(round, scope);
  try {
    const observed = observer
      ? {
          modelStart: (value: number) => observer.modelStart(value),
          delta: (event: Parameters<ModelObserver['delta']>[0]) => {
            recording?.delta(event);
            observer.delta(event);
          },
          modelEnd: () => observer.modelEnd(),
        }
      : undefined;
    const turn = await requestModelTurn(
      baseUrl,
      apiKey,
      model,
      messages,
      signal,
      tools,
      toolChoice,
      trace,
      round,
      observed,
      scope,
    );
    await recording?.replyEnd(round, turn, scope);
    return turn;
  } catch (error) {
    await recording?.replyError(round, error);
    trace?.error(error instanceof Error ? error.message : '模型请求失败', scope, round);
    throw error;
  }
}

async function requestModelTurn(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ModelMessage[],
  signal: AbortSignal,
  tools?: ModelTool[],
  toolChoice: 'auto' | 'none' = 'auto',
  trace?: ChatTrace,
  round = 1,
  observer?: ModelObserver,
  scope?: AgentScope,
): Promise<ModelTurn> {
  const timeouts = getModelTimeouts();
  observer?.modelStart(round);
  // Some OpenAI-compatible services reject null assistant content without tool calls.
  const requestMessages = messages.map((message) =>
    message.content === null ? { ...message, content: '' } : message,
  );
  const started = trace?.modelRequest(round, requestMessages, tools, toolChoice, scope);
  const url = modelEndpoint(baseUrl);
  const localDevelopment =
    process.env['NODE_ENV'] !== 'production' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const literalAddress = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literalAddress) && !localDevelopment && !allowedAddress(literalAddress)) {
    throw new BadRequestException('不能使用内网模型 API 地址');
  }
  const payload = JSON.stringify({
    model,
    messages: requestMessages,
    stream: Boolean(observer),
    ...(observer ? { stream_options: { include_usage: true } } : {}),
    ...(tools ? { tools, tool_choice: toolChoice } : {}),
  });
  const hasImages = messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'),
  );
  const turn = await new Promise<ModelTurn>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const clearDeadline = () => clearTimeout(timeout);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
      request.destroy();
    };
    const waitForOutput = (first: boolean) => {
      if (settled) return;
      clearDeadline();
      timeout = setTimeout(
        () =>
          fail(
            new GatewayTimeoutException(
              first ? '模型首响应超时，请稍后重试' : '模型长时间无输出，请稍后重试',
            ),
          ),
        first ? timeouts.modelFirstResponseTimeoutMs : timeouts.modelIdleTimeoutMs,
      );
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(payload),
        },
        // Validate and pin the resolved address, including on a fresh DNS lookup.
        lookup: (hostname, options, callback) => {
          lookup(hostname, { family: options.family, all: true }, (error, addresses) => {
            if (error) return callback(error, []);
            if (
              !addresses.length ||
              (!localDevelopment && addresses.some(({ address }) => !allowedAddress(address)))
            ) {
              return callback(new Error('Blocked model API address'), []);
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          const status = response.statusCode;
          const errorChunks: Buffer[] = [];
          let errorBytes = 0;
          const rejectResponse = () =>
            fail(
              new BadGatewayException(
                upstreamErrorMessage(
                  status,
                  Buffer.concat(errorChunks).toString('utf8'),
                  apiKey,
                  hasImages,
                ),
              ),
            );
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            errorBytes += chunk.length;
            if (errorBytes > 16 * 1024) {
              rejectResponse();
              return;
            }
            errorChunks.push(chunk);
          });
          response.on('end', rejectResponse);
          response.on('error', rejectResponse);
          return;
        }
        const chunks: Buffer[] = [];
        const stream = observer
          ? new ModelStream(round, {
              modelStart: (value) => observer.modelStart(value),
              delta: (event) => {
                if (event.content || event.reasoning || event.toolCall) waitForOutput(false);
                observer.delta(event);
              },
              modelEnd: () => observer.modelEnd(),
            })
          : undefined;
        if (stream && !response.headers['content-type']?.includes('text/event-stream')) {
          fail(new BadGatewayException('模型 API 未返回流式响应，请检查服务是否支持 SSE'));
          return;
        }
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (stream) {
            try {
              stream.push(chunk);
            } catch {
              fail(new BadGatewayException('模型返回了无效的流式数据'));
            }
            return;
          }
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            fail(new BadGatewayException('模型响应过大'));
            return;
          }
          if (chunk.length) waitForOutput(false);
          chunks.push(chunk);
        });
        response.on('error', () => fail(new BadGatewayException('模型响应中断，请重试')));
        response.on('end', () => {
          if (settled) return;
          try {
            const body = upstreamSchema.parse(
              stream ? stream.finish() : JSON.parse(Buffer.concat(chunks).toString('utf8')),
            );
            const usage = normalizeUsage(body.usage);
            settled = true;
            clearDeadline();
            resolve({
              ...body.choices[0]!.message,
              finishReason: body.choices[0]!.finish_reason ?? null,
              ...(usage ? { usage } : {}),
            });
          } catch {
            fail(
              new BadGatewayException(
                stream ? '模型流式响应未完整结束或格式无效，请重试' : '模型返回了无法识别的内容',
              ),
            );
          }
        });
      },
    );
    request.on('close', clearDeadline);
    request.on('error', () => fail(new BadGatewayException('无法连接模型 API，请检查配置')));
    waitForOutput(true);
    request.end(payload);
  });
  if (started !== undefined) trace?.modelResponse(round, started, turn, scope);
  observer?.modelEnd();
  return turn;
}
