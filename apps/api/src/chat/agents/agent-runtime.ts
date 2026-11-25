import { BadGatewayException } from '@nestjs/common';
import { callModelTurn } from '../model-api';
import type { ModelMessage } from '../model-api';
import type { AgentContext, AgentTool } from './agent-types';
import type { ToolResult } from './agent-types';
import { promptText } from '../prompts/prompt-store';

// The loop knows tools, not business domains. Agents supply their own prompt and tools.
export async function runAgent(
  context: AgentContext,
  messages: ModelMessage[],
  tools: AgentTool[],
  limits: {
    turns: number;
    calls: number;
    completionTool?: string;
    isToolAvailable?: (name: string) => boolean;
    recoverToolError?: (error: unknown) => string | undefined;
    validateFinal?: (content: string | null | undefined) => boolean;
    invalidFinalMessage?: string;
  },
) {
  const names = new Set(tools.map((tool) => tool.definition.function.name));
  if (names.size !== tools.length) throw new Error('Agent 工具名称重复');
  const sources: ToolResult['sources'] = [];
  const warnings = new Set<string>();
  const reasoning: string[] = [];
  let calls = 0;
  let repairs = 0;
  let textRecovery = false;
  for (let index = 0; index < limits.turns; index++) {
    context.signal.throwIfAborted();
    const round = context.budget.nextRound();
    const completionLimit =
      calls >= limits.calls - (limits.completionTool ? 1 : 0)
        ? 'tool_call_budget_exhausted'
        : index === limits.turns - 1
          ? 'turn_budget_exhausted'
          : undefined;
    const final = completionLimit !== undefined;
    const availableTools = final
      ? tools.filter((tool) => tool.definition.function.name === limits.completionTool)
      : tools.filter((tool) => limits.isToolAvailable?.(tool.definition.function.name) ?? true);
    const child = context.scope.agent !== 'main';
    const observer = context.progress
      ? child
        ? { modelStart() {}, delta() {}, modelEnd() {} }
        : context.progress
      : undefined;
    let turn: Awaited<ReturnType<typeof callModelTurn>>;
    try {
      turn = await callModelTurn(
        context.model.baseUrl,
        context.model.apiKey,
        context.model.model,
        messages,
        context.signal,
        textRecovery ? undefined : availableTools.map((tool) => tool.definition),
        textRecovery || (final && !limits.completionTool) ? 'none' : 'auto',
        context.trace,
        round,
        observer,
        context.recording,
        context.scope,
      );
    } catch (error) {
      context.signal.throwIfAborted();
      const recovery = !textRecovery && !final ? limits.recoverToolError?.(error) : undefined;
      if (!recovery) throw error;
      textRecovery = true;
      messages.push({ role: 'user', content: recovery });
      continue;
    }
    const thought = turn.reasoning_content?.trim() || turn.reasoning?.trim();
    if (thought) reasoning.push(thought);
    if (!turn.tool_calls?.length) {
      if (!limits.validateFinal || limits.validateFinal(turn.content))
        return { turn, sources, warnings, reasoning, completionLimit };
      const message = limits.invalidFinalMessage ?? '模型返回了无法识别的任务结果';
      context.trace?.error(message, context.scope, round);
      if (final || repairs++ >= 2) throw new BadGatewayException(message);
      messages.push(
        {
          role: 'assistant',
          content: turn.content ?? '',
          ...(thought ? { reasoning_content: thought } : {}),
        },
        {
          role: 'user',
          content: promptText('invalid-final', { message }),
        },
      );
      continue;
    }
    if (
      textRecovery ||
      (final && turn.tool_calls.some((call) => call.function.name !== limits.completionTool))
    )
      throw new BadGatewayException('模型超出任务工具调用预算，请缩小问题范围后重试');
    if (new Set(turn.tool_calls.map((call) => call.id)).size !== turn.tool_calls.length)
      throw new BadGatewayException('模型返回了重复的工具调用标识');
    if (
      turn.tool_calls.some(
        (call, index) =>
          call.function.name === limits.completionTool && index !== turn.tool_calls!.length - 1,
      )
    )
      throw new BadGatewayException('结束任务的工具必须是本轮最后一个调用');
    messages.push({
      role: 'assistant',
      content: turn.content ?? null,
      tool_calls: turn.tool_calls,
      ...(thought ? { reasoning_content: thought } : {}),
    });
    for (const call of turn.tool_calls) {
      context.signal.throwIfAborted();
      const started = Date.now();
      const executionId = `${round}:${call.id}`;
      const recordId = await context.recording?.toolStart(round, call);
      context.progress?.toolStart(round, executionId, call.function.name);
      let result: ToolResult;
      try {
        const tool = tools.find((item) => item.definition.function.name === call.function.name);
        const callLimit =
          limits.calls -
          (limits.completionTool && call.function.name !== limits.completionTool ? 1 : 0);
        const exhausted = calls >= callLimit;
        if (!exhausted) calls++;
        result = exhausted
          ? {
              data: { error: '工具调用次数已达上限' },
              sources: [],
              warning: '工具调用次数已达上限',
            }
          : tool
            ? await tool.execute(call.function.arguments, context, executionId)
            : { data: { error: '未知工具' }, sources: [], warning: '模型请求了未知工具' };
        if (child) result = { ...result, internal: true };
        if (recordId) await context.recording?.toolEnd(recordId, result);
      } catch (error) {
        if (recordId) await context.recording?.toolError(recordId, error);
        context.trace?.error(
          error instanceof Error ? error.message : '工具执行失败',
          context.scope,
          round,
        );
        throw error;
      } finally {
        context.progress?.toolEnd(executionId);
      }
      context.trace?.tool(round, started, call, result, context.scope);
      if (result.warning) warnings.add(result.warning);
      for (const source of result.sources)
        if (sources.length < 20 && !sources.some((item) => item.url === source.url))
          sources.push(source);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result.data) });
      if (result.finalContent !== undefined)
        return {
          turn: { ...turn, content: result.finalContent, tool_calls: undefined },
          sources,
          warnings,
          reasoning,
          completionLimit,
        };
      if (call.function.name === limits.completionTool) {
        const message = limits.invalidFinalMessage ?? '模型返回了无法识别的任务结果';
        context.trace?.error(message, context.scope, round);
        if (final || repairs++ >= 2) throw new BadGatewayException(message);
      }
    }
  }
  throw new BadGatewayException('任务未能完成，请重试');
}
