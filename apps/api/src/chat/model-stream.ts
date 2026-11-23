import { SseDecoder } from '@repo/contracts';
import { z } from 'zod';
import type { ModelObserver } from './chat-progress';

const chunkSchema = z.object({
  usage: z.unknown().optional(),
  choices: z.array(
    z.object({
      index: z.number().int().optional(),
      finish_reason: z.string().max(200).nullish(),
      delta: z.object({
        content: z.string().nullish(),
        reasoning_content: z.string().nullish(),
        reasoning: z.string().nullish(),
        tool_calls: z
          .array(
            z.object({
              index: z.number().int().min(0).max(15),
              id: z.string().optional(),
              type: z.literal('function').optional(),
              function: z
                .object({ name: z.string().optional(), arguments: z.string().optional() })
                .optional(),
            }),
          )
          .optional(),
      }),
    }),
  ),
});

export class ModelStream {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly sse = new SseDecoder();
  private done = false;
  private bytes = 0;
  private content = '';
  private reasoning = '';
  private usage: unknown;
  private finishReason: string | null = null;
  private readonly calls = new Map<
    number,
    { id: string; type: 'function'; function: { name: string; arguments: string } }
  >();
  constructor(
    private readonly round: number,
    private readonly observer: ModelObserver,
  ) {}
  push(chunk: Uint8Array) {
    this.bytes += chunk.length;
    if (this.bytes > 8 * 1024 * 1024) throw new Error('模型流式响应过大');
    this.consume(this.decoder.decode(chunk, { stream: true }));
  }
  private consume(text: string) {
    for (const data of this.sse.push(text)) {
      if (this.done) throw new Error('模型流式响应结束后仍有数据');
      if (data === '[DONE]') {
        this.done = true;
        continue;
      }
      const parsed = chunkSchema.parse(JSON.parse(data));
      if (parsed.usage !== undefined) this.usage = parsed.usage;
      const choice = parsed.choices.find((choice) => (choice.index ?? 0) === 0);
      if (choice?.finish_reason) this.finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) continue;
      const reasoning = delta.reasoning_content || delta.reasoning || '';
      const content = delta.content || '';
      this.content += content;
      this.reasoning += reasoning;
      if (this.content.length > 100_000 || this.reasoning.length > 100_000)
        throw new Error('模型内容过大');
      for (const fragment of delta.tool_calls ?? []) {
        const call = this.calls.get(fragment.index) ?? {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        call.id += fragment.id ?? '';
        call.function.name += fragment.function?.name ?? '';
        call.function.arguments += fragment.function?.arguments ?? '';
        if (
          call.id.length > 200 ||
          call.function.name.length > 100 ||
          call.function.arguments.length > 16_000
        )
          throw new Error('模型工具调用过大');
        this.calls.set(fragment.index, call);
      }
      this.observer.delta({
        type: 'delta',
        round: this.round,
        ...(reasoning ? { reasoning } : {}),
        ...(content ? { content } : {}),
        ...(delta.tool_calls?.length ? { toolCall: true } : {}),
      });
    }
  }
  finish() {
    this.consume(this.decoder.decode());
    if (!this.done) throw new Error('模型流式响应中断，未收到结束标记');
    return {
      usage: this.usage,
      choices: [
        {
          finish_reason: this.finishReason,
          message: {
            content: this.content || null,
            ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
            ...(this.calls.size
              ? {
                  tool_calls: [...this.calls.entries()]
                    .sort(([a], [b]) => a - b)
                    .map(([, call]) => call),
                }
              : {}),
          },
        },
      ],
    };
  }
}
