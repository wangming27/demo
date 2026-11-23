import { CHAT_IMAGES_MAX_BYTES, chatImageBytes } from '@repo/contracts';
import type { ChatCompletionResponse, ChatHistoryEntry, ChatMessage } from '@repo/contracts';
import type { DisplayTiming } from '../../components/chat/ChatTimings';

export interface HistoryImage {
  historyId: string;
  id: string;
  name: string;
  bytes: number;
}
export interface DisplayMessage extends ChatMessage {
  id: string;
  historyId?: string;
  conversationId?: string;
  modelName?: string;
  reasoning?: string;
  sources?: ChatCompletionResponse['sources'];
  searchWarning?: string;
  usage?: ChatCompletionResponse['usage'];
  contextUsage?: ChatCompletionResponse['contextUsage'];
  timing?: DisplayTiming;
  incomplete?: boolean;
  historyEligible?: boolean;
  historyImages?: HistoryImage[];
}

export function historyMessages(items: ChatHistoryEntry[]): DisplayMessage[] {
  return [...items].reverse().flatMap((item): DisplayMessage[] => {
    const complete = item.status === 'SUCCEEDED' && !!item.reply?.isFinal;
    const common = {
      historyId: item.id,
      conversationId: item.conversationId,
      historyEligible: complete,
    };
    const historyImages = item.resources
      .filter((resource) => resource.mime.startsWith('image/'))
      .map(({ id, name, bytes }) => ({ historyId: item.id, id, name, bytes }));
    return [
      { ...common, id: `${item.id}:user`, role: 'user', content: item.query, historyImages },
      {
        ...common,
        id: `${item.id}:assistant`,
        role: 'assistant',
        content: item.reply?.content ?? '',
        ...(item.reply?.reasoningContent ? { reasoning: item.reply.reasoningContent } : {}),
        modelName: item.model.name,
        incomplete: !complete,
        ...(item.reply?.usage ? { usage: item.reply.usage } : {}),
        ...(item.contextUsage ? { contextUsage: item.contextUsage } : {}),
        ...(item.sources ? { sources: item.sources } : {}),
        ...(item.searchWarning ? { searchWarning: item.searchWarning } : {}),
        ...(item.timing
          ? {
              timing: {
                server: { ...item.timing, phase: 'done' },
                started: 0,
                received: 0,
                firstResponseMs: item.timing.firstResponseMs,
                totalMs: item.durationMs ?? item.timing.elapsedMs,
              },
            }
          : {}),
      },
    ];
  });
}

// Browsing older records must not grow the model prompt past its HTTP limits.
export function contextMessages(
  messages: DisplayMessage[],
  conversationId: string,
  question: ChatMessage,
) {
  const eligible = messages.filter(
    (message) => message.conversationId === conversationId && message.historyEligible !== false,
  );
  let chars = question.content.length;
  let bytes = (question.images ?? []).reduce(
    (total, image) => total + chatImageBytes(image.dataUrl),
    0,
  );
  const selected: DisplayMessage[] = [];
  for (let index = eligible.length - 1; index > 0; index -= 2) {
    const answer = eligible[index]!;
    const query = eligible[index - 1]!;
    if (query.role !== 'user' || answer.role !== 'assistant') break;
    const nextChars = query.content.length + answer.content.length;
    const nextBytes =
      (query.images ?? []).reduce((total, image) => total + chatImageBytes(image.dataUrl), 0) +
      (query.historyImages ?? []).reduce((total, image) => total + image.bytes, 0);
    if (
      selected.length + 3 > 50 ||
      chars + nextChars > 60_000 ||
      bytes + nextBytes > CHAT_IMAGES_MAX_BYTES ||
      query.content.length > 16_000 ||
      answer.content.length > 16_000
    )
      break;
    selected.unshift(query, answer);
    chars += nextChars;
    bytes += nextBytes;
  }
  return selected;
}
