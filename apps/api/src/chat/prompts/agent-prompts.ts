import { maxDelegations, researchAgentLimits } from '../agents/agent-limits';
import { promptText } from './prompt-store';

export function mainSystemPrompt(): string {
  return promptText('main', {
    currentTime: new Date().toISOString(),
    maxDelegations,
  });
}

export function researchSystemPrompt(minQuoteLength: number, maxQuoteLength: number): string {
  return promptText('research', {
    currentTime: new Date().toISOString(),
    maxSearches: researchAgentLimits.searches,
    maxFetches: researchAgentLimits.fetches,
    maxTurns: researchAgentLimits.turns,
    maxCalls: researchAgentLimits.calls,
    timeoutSeconds: researchAgentLimits.timeoutMs / 1000,
    minQuoteLength,
    maxQuoteLength,
  });
}
