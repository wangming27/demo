import { randomUUID } from 'node:crypto';
import type { ChatDebugEvent, ChatDebugTrace } from '@repo/contracts';
import type { ModelContent, ModelMessage, ModelTool, ModelTurn } from './model-api';
import { chatImageBytes } from '@repo/contracts';
import type { ToolResult } from './web-tools.service';

const maxText = 200_000;
function text(value: string): string {
  return value.slice(0, maxText);
}
function json(value: unknown): string {
  return text(JSON.stringify(value, null, 2) ?? 'null');
}

function messageText(content: ModelContent): string | null {
  if (!Array.isArray(content)) return content === null ? null : text(content);
  return text(
    content
      .map((part) =>
        part.type === 'text'
          ? part.text
          : `[图片：${part.image_url.url.slice(5, part.image_url.url.indexOf(';'))}，${chatImageBytes(part.image_url.url)} 字节；图片数据已省略]`,
      )
      .join('\n'),
  );
}

// Only explicit message/tool fields are recorded. Model credentials and HTTP headers are excluded.
export class ChatTrace {
  private readonly requestId = randomUUID();
  private readonly started = Date.now();
  private readonly events: ChatDebugEvent[] = [];
  private round = 1;

  constructor(private readonly model: ChatDebugTrace['model']) {}

  modelRequest(
    round: number,
    messages: ModelMessage[],
    tools?: ModelTool[],
    toolChoice?: 'auto' | 'none',
  ) {
    this.round = round;
    const started = Date.now();
    const serializedTools = JSON.stringify(tools ?? [], null, 2);
    this.events.push({
      kind: 'model_request',
      round,
      startedAt: new Date(started).toISOString(),
      durationMs: 0,
      truncated:
        serializedTools.length > maxText ||
        messages.some(
          (message) =>
            (Array.isArray(message.content)
              ? message.content.some((part) => part.type === 'text' && part.text.length > maxText)
              : (message.content?.length ?? 0) > maxText) ||
            ('reasoning_content' in message && (message.reasoning_content?.length ?? 0) > maxText),
        ),
      messages: messages.map((message) => ({
        role: message.role,
        content: messageText(message.content),
        ...(message.role === 'tool' ? { toolCallId: message.tool_call_id } : {}),
        ...('tool_calls' in message && message.tool_calls
          ? {
              toolCalls: message.tool_calls.map((call) => ({
                id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
              })),
            }
          : {}),
        ...('reasoning_content' in message && message.reasoning_content
          ? { reasoning: text(message.reasoning_content) }
          : {}),
      })),
      tools: text(serializedTools),
      ...(tools && toolChoice ? { toolChoice } : {}),
    });
    return started;
  }

  modelResponse(round: number, started: number, message: ModelTurn) {
    const serialized = JSON.stringify(message, null, 2);
    this.events.push({
      kind: 'model_response',
      round,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      message: text(serialized),
      truncated: serialized.length > maxText,
    });
  }

  tool(
    round: number,
    started: number,
    call: NonNullable<ModelTurn['tool_calls']>[number],
    result: ToolResult,
  ) {
    const serialized = JSON.stringify(result.data, null, 2) ?? 'null';
    this.events.push({
      kind: 'tool',
      round,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      toolCallId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      result: json(result.data),
      truncated: serialized.length > maxText,
      ...(result.warning ? { warning: result.warning } : {}),
    });
  }

  error(message: string) {
    this.events.push({
      kind: 'error',
      round: this.round,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      message: text(message),
      truncated: message.length > maxText,
    });
  }

  finish(status: ChatDebugTrace['status']): ChatDebugTrace {
    return {
      requestId: this.requestId,
      startedAt: new Date(this.started).toISOString(),
      durationMs: Date.now() - this.started,
      status,
      model: { name: this.model.name, model: this.model.model, baseUrl: this.model.baseUrl },
      events: this.events.slice(0, 32),
    };
  }
}
