import { Inject, Injectable } from '@nestjs/common';
import { SUB_AGENTS } from './agent-types';
import type { AgentContext, AgentTool, SubAgent } from './agent-types';

@Injectable()
export class SubAgentRegistry {
  private readonly agents: AgentTool[];

  constructor(@Inject(SUB_AGENTS) agents: SubAgent[]) {
    const names = agents.map((agent) => agent.definition.function.name);
    if (new Set(names).size !== names.length) throw new Error('子 Agent 名称重复');
    if (names.includes('main')) throw new Error('main 是主 Agent 的保留名称');
    this.agents = agents.map((agent) => ({
      definition: agent.definition,
      execute: async (rawArguments: string, context: AgentContext, callId: string) => {
        context.signal.throwIfAborted();
        if (!context.budget.delegate())
          return {
            data: {
              error: '子任务委派次数已达上限，请根据已有证据回答',
              stopReason: 'delegation_budget_exhausted',
              budget: { delegationsRemaining: context.budget.delegationsRemaining },
            },
            sources: [],
            warning: '子任务委派次数已达上限',
          };
        return agent.execute(
          rawArguments,
          {
            ...context,
            scope: { agent: agent.definition.function.name, parentToolCallId: callId },
          },
          callId,
        );
      },
    }));
  }

  tools(): AgentTool[] {
    return [...this.agents];
  }
}
