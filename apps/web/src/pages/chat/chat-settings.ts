export const DEFAULT_HISTORY_ROUNDS = 0;
export const MAX_HISTORY_ROUNDS = 24;

export interface ChatSettings {
  historyRounds: number;
}

export function isHistoryRounds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_HISTORY_ROUNDS
  );
}

function storageKey(userId: string) {
  return `chat-settings:${userId}`;
}

export function loadChatSettings(userId: string): ChatSettings {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(userId)) ?? 'null');
    if (
      stored !== null &&
      typeof stored === 'object' &&
      'historyRounds' in stored &&
      isHistoryRounds(stored.historyRounds)
    )
      return { historyRounds: stored.historyRounds };
  } catch {
    // Unavailable storage or obsolete settings must not prevent chatting.
  }
  return { historyRounds: DEFAULT_HISTORY_ROUNDS };
}

export function saveChatSettings(userId: string, settings: ChatSettings): boolean {
  if (!isHistoryRounds(settings.historyRounds)) return false;
  try {
    localStorage.setItem(
      storageKey(userId),
      JSON.stringify({ historyRounds: settings.historyRounds }),
    );
    return true;
  } catch {
    return false;
  }
}
