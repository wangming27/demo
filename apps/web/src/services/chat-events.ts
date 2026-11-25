import type { ChatCompletion } from '@repo/contracts';

export type ChatRequestEvent =
  | { type: 'started'; requestId: string; input: ChatCompletion }
  | {
      type: 'finished';
      requestId: string;
      status: 'success' | 'error' | 'cancelled';
      error?: string;
    };

const listeners = new Set<(event: ChatRequestEvent) => void>();

export function subscribeChatRequests(listener: (event: ChatRequestEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishChatRequest(event: ChatRequestEvent) {
  // Observers run independently and cannot reject the chat promise.
  for (const listener of listeners) {
    queueMicrotask(() => {
      if (!listeners.has(listener)) return;
      try {
        listener(event);
      } catch {
        /* An observer failure does not affect chat. */
      }
    });
  }
}
