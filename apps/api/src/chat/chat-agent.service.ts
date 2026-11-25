import { BadGatewayException, Injectable } from '@nestjs/common';
import { ChatCompletionResponseSchema } from '@repo/contracts';
import type { ChatCompletionResponse, ChatMessage } from '@repo/contracts';
import { toModelMessages } from './model-api';
import type { ChatTrace } from './chat-trace';
import type { ChatProgress } from './chat-progress';
import type { ChatRecording } from './chat-recording';
import { AgentBudget } from './agents/agent-types';
import type { AgentModel } from './agents/agent-types';
import { runAgent } from './agents/agent-runtime';
import { SubAgentRegistry } from './agents/sub-agent-registry.service';
import { initialSearchQuery } from './research-query';
import { mainSystemPrompt } from './prompts/agent-prompts';
import { mainAgentLimits } from './agents/agent-limits';

@Injectable()
export class ChatAgentService {
  constructor(private readonly subAgents: SubAgentRegistry) {}

  async complete(
    model: AgentModel,
    history: ChatMessage[],
    signal: AbortSignal,
    trace?: ChatTrace,
    progress?: ChatProgress,
    recording?: ChatRecording,
  ): Promise<ChatCompletionResponse> {
    const first = history.length === 1 ? history[0] : undefined;
    const query =
      first?.role === 'user' && typeof first.content === 'string'
        ? initialSearchQuery(first.content)
        : undefined;
    const result = await runAgent(
      {
        model,
        signal,
        trace,
        progress,
        recording,
        budget: new AgentBudget(),
        attemptedSearchUrls: new Set<string>(),
        initialSearchQuery: query,
        scope: { agent: 'main' },
      },
      [
        {
          role: 'system',
          content: mainSystemPrompt(),
        },
        ...toModelMessages(history),
      ],
      this.subAgents.tools(),
      mainAgentLimits,
    );
    const parsed = ChatCompletionResponseSchema.safeParse({
      content: result.turn.content,
      ...(result.turn.usage ? { usage: result.turn.usage } : {}),
      ...(result.reasoning.length
        ? { reasoning: result.reasoning.join('\n\n').slice(0, 100_000) }
        : {}),
      ...(result.sources.length ? { sources: result.sources } : {}),
      ...(result.warnings.size
        ? { searchWarning: [...result.warnings].join('；').slice(0, 1000) }
        : {}),
    });
    if (!parsed.success) throw new BadGatewayException('模型未返回有效回复，请重试');
    return parsed.data;
  }
}
