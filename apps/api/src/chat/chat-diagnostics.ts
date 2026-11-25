import type { ChatDebugTrace } from '@repo/contracts';
import type { ChatTrace } from './chat-trace';

// The chat pipeline depends only on this optional observation port.
export const CHAT_DIAGNOSTICS = Symbol('CHAT_DIAGNOSTICS');
export interface ChatDiagnostics {
  start(userId: string, requestId: string, model: ChatDebugTrace['model']): ChatTrace;
  finish(
    userId: string,
    requestId: string,
    trace: ChatTrace,
    status: ChatDebugTrace['status'],
  ): void;
}

export function observe<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    // Diagnostics must never change chat responses or persistence.
    return undefined;
  }
}

export function safeTrace(trace: ChatTrace): ChatTrace {
  return {
    modelRequest: (...args) => observe(() => trace.modelRequest(...args)) ?? Date.now(),
    modelResponse: (...args) => {
      observe(() => trace.modelResponse(...args));
    },
    tool: (...args) => {
      observe(() => trace.tool(...args));
    },
    error: (...args) => {
      observe(() => trace.error(...args));
    },
    finish: (status) => trace.finish(status),
  };
}
