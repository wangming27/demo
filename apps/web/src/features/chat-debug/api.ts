import { ChatDebugTraceSchema } from '@repo/contracts';

export async function readChatDebug(requestId: string, signal: AbortSignal) {
  const response = await fetch(`/api/chat-debug/${encodeURIComponent(requestId)}`, {
    credentials: 'same-origin',
    signal,
    cache: 'no-store',
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? '调试记录尚未生成、已过期或未启用，可稍后重试。'
        : `调试记录读取失败（HTTP ${response.status}）`,
    );
  return ChatDebugTraceSchema.parse(await response.json());
}
