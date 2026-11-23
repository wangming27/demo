import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { BadGatewayException, BadRequestException, GatewayTimeoutException } from '@nestjs/common';
import { ChatCompletionResponseSchema } from '@repo/contracts';
import type { ChatCompletionResponse, ChatMessage } from '@repo/contracts';
import { z } from 'zod';
import type { ChatTrace } from './chat-trace';

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
): Promise<ModelTurn> {
  const started = trace?.modelRequest(round, messages, tools, toolChoice);
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
    messages,
    stream: false,
    ...(tools ? { tools, tool_choice: toolChoice } : {}),
  });
  const hasImages = messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'),
  );
  const turn = await new Promise<ModelTurn>((resolve, reject) => {
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
          response.resume();
          const status = response.statusCode;
          reject(
            new BadGatewayException(
              status === 401 || status === 403
                ? '模型 API 鉴权失败，请检查 API Key'
                : status === 429
                  ? '模型 API 请求过于频繁，请稍后重试'
                  : hasImages && status === 400
                    ? '模型无法处理图片，请确认所选模型支持视觉输入且推理服务版本支持该模型'
                    : tools && status === 400
                      ? '模型不支持联网工具调用或请求无效，请关闭联网搜索重试'
                      : '模型 API 请求失败，请检查地址和模型名称',
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            request.destroy(new Error('Model response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', () => reject(new BadGatewayException('模型响应中断，请重试')));
        response.on('end', () => {
          try {
            const body = upstreamSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            const usage = normalizeUsage(body.usage);
            resolve({ ...body.choices[0]!.message, ...(usage ? { usage } : {}) });
          } catch {
            reject(new BadGatewayException('模型返回了无法识别的内容'));
          }
        });
      },
    );
    const timeout = setTimeout(() => {
      reject(new GatewayTimeoutException('模型响应超时，请稍后重试'));
      request.destroy();
    }, 60_000);
    request.on('close', () => clearTimeout(timeout));
    request.on('error', () => reject(new BadGatewayException('无法连接模型 API，请检查配置')));
    request.end(payload);
  });
  if (started !== undefined) trace?.modelResponse(round, started, turn);
  return turn;
}
