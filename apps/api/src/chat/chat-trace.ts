import type { ChatDebugTrace } from '@repo/contracts';
import type { ModelMessage, ModelTool, ModelTurn } from './model-api';
import type { AgentScope, ToolResult } from './agents/agent-types';

// Observation contract only; the collector lives in the removable debug module.
export interface ChatTrace {
  modelRequest(
    round: number,
    messages: ModelMessage[],
    tools?: ModelTool[],
    toolChoice?: 'auto' | 'none',
    scope?: AgentScope,
  ): number;
  modelResponse(round: number, started: number, message: ModelTurn, scope?: AgentScope): void;
  tool(
    round: number,
    started: number,
    call: NonNullable<ModelTurn['tool_calls']>[number],
    result: ToolResult,
    scope?: AgentScope,
  ): void;
  error(message: string, scope?: AgentScope, round?: number): void;
  finish(status: ChatDebugTrace['status']): ChatDebugTrace;
}
