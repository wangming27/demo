import type { ChatCompletionResponse, ChatWebRequest } from '@repo/contracts';
import type { ChatProgress } from '../chat-progress';
import type { ChatRecording } from '../chat-recording';
import type { ChatTrace } from '../chat-trace';
import type { ModelTool } from '../model-api';
import { maxAgentRounds, maxDelegations } from './agent-limits';

export interface ToolResult {
  data: unknown;
  sources: NonNullable<ChatCompletionResponse['sources']>;
  warning?: string;
  internal?: boolean;
  debug?: { webRequests: ChatWebRequest[]; cacheHit: boolean };
  // A completion tool may end its own agent loop with validated content.
  finalContent?: string;
}

export interface AgentScope {
  agent: string;
  parentToolCallId?: string;
}

export interface AgentModel {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// One request owns one budget, shared by the main agent and every delegate.
export class AgentBudget {
  private rounds = 0;
  private delegations = 0;

  get delegationsRemaining() {
    return maxDelegations - this.delegations;
  }

  nextRound() {
    if (this.rounds >= maxAgentRounds) throw new Error('任务推理次数已达上限');
    return ++this.rounds;
  }

  delegate() {
    if (this.delegationsRemaining === 0) return false;
    this.delegations++;
    return true;
  }
}

export interface AgentContext {
  model: AgentModel;
  signal: AbortSignal;
  budget: AgentBudget;
  attemptedSearchUrls?: Set<string> | undefined;
  initialSearchQuery?: string | undefined;
  scope: AgentScope;
  trace?: ChatTrace | undefined;
  progress?: ChatProgress | undefined;
  recording?: ChatRecording | undefined;
}

export interface AgentTool {
  definition: ModelTool;
  execute(rawArguments: string, context: AgentContext, callId: string): Promise<ToolResult>;
}

export type SubAgent = AgentTool;

export const SUB_AGENTS = Symbol('SUB_AGENTS');
