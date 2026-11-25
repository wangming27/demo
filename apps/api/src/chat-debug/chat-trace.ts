import { randomUUID } from 'node:crypto';
import type { ChatDebugEvent, ChatDebugTrace } from '@repo/contracts';
import type { ModelContent, ModelMessage, ModelTool, ModelTurn } from '../chat/model-api';
import { chatImageBytes } from '@repo/contracts';
import type { AgentScope, ToolResult } from '../chat/agents/agent-types';

const maxText = 8_000;
const maxTraceBytes = 2 * 1024 * 1024;
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

// Model credentials and authorization headers are excluded; public web requests use fixed headers.
export class ChatTrace {
  private readonly started = Date.now();
  private readonly events: ChatDebugEvent[] = [];
  private round = 1;
  private bytes = 0;
  private truncated = false;

  constructor(
    private readonly model: ChatDebugTrace['model'],
    private readonly requestId: string = randomUUID(),
  ) {}

  private capture(action: () => void) {
    if (this.events.length >= 768 || this.bytes >= maxTraceBytes) {
      this.truncated = true;
      return;
    }
    try {
      action();
    } catch {
      this.truncated = true;
    }
  }

  private append(event: ChatDebugEvent) {
    // Bound every string, including tool arguments and nested request metadata.
    const serialized = JSON.stringify(event, (_key, value: unknown) =>
      typeof value === 'string' ? text(value) : value,
    );
    const bytes = Buffer.byteLength(serialized);
    if (this.bytes + bytes > maxTraceBytes) {
      this.truncated = true;
      this.bytes = maxTraceBytes;
      return;
    }
    const bounded = JSON.parse(serialized) as ChatDebugEvent;
    if (serialized !== JSON.stringify(event)) bounded.truncated = true;
    this.events.push(bounded);
    this.bytes += bytes;
  }

  modelRequest(
    round: number,
    messages: ModelMessage[],
    tools?: ModelTool[],
    toolChoice?: 'auto' | 'none',
    scope?: AgentScope,
  ) {
    const started = Date.now();
    this.capture(() => {
      this.round = round;
      const serializedTools = JSON.stringify(tools ?? [], null, 2);
      this.append({
        kind: 'model_request',
        round,
        ...scope,
        startedAt: new Date(started).toISOString(),
        durationMs: 0,
        truncated:
          serializedTools.length > maxText ||
          messages.some(
            (message) =>
              (Array.isArray(message.content)
                ? message.content.some((part) => part.type === 'text' && part.text.length > maxText)
                : (message.content?.length ?? 0) > maxText) ||
              ('reasoning_content' in message &&
                (message.reasoning_content?.length ?? 0) > maxText),
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
    });
    return started;
  }

  modelResponse(round: number, started: number, message: ModelTurn, scope?: AgentScope) {
    this.capture(() => {
      const serialized = JSON.stringify(message, null, 2);
      this.append({
        kind: 'model_response',
        round,
        ...scope,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        message: text(serialized),
        truncated: serialized.length > maxText,
      });
    });
  }

  tool(
    round: number,
    started: number,
    call: NonNullable<ModelTurn['tool_calls']>[number],
    result: ToolResult,
    scope?: AgentScope,
  ) {
    this.capture(() => {
      const serialized = JSON.stringify(result.data, null, 2) ?? 'null';
      this.append({
        kind: 'tool',
        round,
        ...scope,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        toolCallId: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        result: json(result.data),
        truncated: serialized.length > maxText,
        ...(result.warning ? { warning: result.warning } : {}),
        ...(result.debug
          ? { webRequests: result.debug.webRequests, cacheHit: result.debug.cacheHit }
          : {}),
      });
    });
  }

  error(message: string, scope?: AgentScope, round = this.round) {
    this.capture(() => {
      const previous = this.events.at(-1);
      if (
        previous?.kind === 'error' &&
        previous.round === round &&
        previous.message === text(message) &&
        (!scope ||
          (previous.agent === scope.agent && previous.parentToolCallId === scope.parentToolCallId))
      )
        return;
      this.append({
        kind: 'error',
        round,
        ...scope,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        message: text(message),
        truncated: message.length > maxText,
      });
    });
  }

  finish(status: ChatDebugTrace['status']): ChatDebugTrace {
    return {
      requestId: this.requestId,
      startedAt: new Date(this.started).toISOString(),
      durationMs: Date.now() - this.started,
      status,
      model: { name: this.model.name, model: this.model.model, baseUrl: this.model.baseUrl },
      events: [...this.events],
      truncated: this.truncated,
    };
  }
}
