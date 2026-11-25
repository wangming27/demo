import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { ChatCompletion, CreateChatModel, UpdateChatModel } from '@repo/contracts';
import { PrismaService } from '../database/prisma.service';
import type { ChatModel } from '../generated/prisma/client';
import { callModel, modelEndpoint } from './model-api';
import { ChatAgentService } from './chat-agent.service';
import { CHAT_DIAGNOSTICS, observe, safeTrace } from './chat-diagnostics';
import type { ChatDiagnostics } from './chat-diagnostics';
import { resolveContextWindow } from './model-context';
import { ChatProgress } from './chat-progress';
import { ChatHistoryService } from './chat-history.service';

function serialize(model: ChatModel) {
  return {
    id: model.id,
    name: model.name,
    model: model.model,
    baseUrl: model.baseUrl,
    hasApiKey: Boolean(model.apiKey),
    contextWindow: model.contextWindow,
    createdAt: model.createdAt.toISOString(),
  };
}

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: ChatAgentService,
    private readonly histories: ChatHistoryService,
    @Optional() @Inject(CHAT_DIAGNOSTICS) private readonly diagnostics?: ChatDiagnostics,
  ) {}

  async list(userId: string) {
    const models = await this.prisma.chatModel.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { items: models.map(serialize) };
  }

  async create(userId: string, input: CreateChatModel) {
    modelEndpoint(input.baseUrl);
    const model = await this.prisma.chatModel.create({
      data: {
        userId,
        name: input.name,
        model: input.model,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        contextWindow: input.contextWindow ?? null,
      },
    });
    return { model: serialize(model) };
  }

  async update(userId: string, id: string, input: UpdateChatModel) {
    modelEndpoint(input.baseUrl);
    const result = await this.prisma.chatModel.updateManyAndReturn({
      where: { id, userId, deletedAt: null },
      data: {
        name: input.name,
        model: input.model,
        baseUrl: input.baseUrl,
        ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      },
    });
    const model = result[0];
    if (!model) throw new NotFoundException('模型配置不存在');
    return { model: serialize(model) };
  }

  async delete(userId: string, id: string) {
    const result = await this.prisma.chatModel.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!result.count) throw new NotFoundException('模型配置不存在');
  }

  async complete(
    userId: string,
    input: ChatCompletion,
    signal: AbortSignal,
    progress?: ChatProgress,
  ) {
    const recording = await this.histories.begin(userId, input, signal);
    if ('replay' in recording) return recording.replay;
    const journal = recording.journal;
    const model = await this.prisma.chatModel.findFirst({
      where: { id: input.modelId, userId, deletedAt: null },
    });
    if (!model) {
      const error = new NotFoundException('模型配置不存在，请重新选择');
      await journal.finishError(error);
      throw error;
    }
    const timing = progress ?? new ChatProgress(() => undefined);
    const requestId = journal.row.requestId;
    const collector = this.diagnostics
      ? observe(() =>
          this.diagnostics!.start(userId, requestId, {
            name: model.name,
            model: model.model,
            baseUrl: model.baseUrl,
          }),
        )
      : undefined;
    const trace = collector ? safeTrace(collector) : undefined;
    try {
      const answer = input.webSearch
        ? await this.agent.complete(model, input.messages, journal.signal, trace, progress, journal)
        : await callModel(
            model.baseUrl,
            model.apiKey,
            model.model,
            input.messages,
            journal.signal,
            trace,
            progress,
            journal,
          );
      const contextUsage = await resolveContextWindow(model, journal.signal);
      const completed = { ...answer, contextUsage, historyId: journal.row.id };
      await journal.finish(completed, timing.finish());
      if (trace) observe(() => this.diagnostics?.finish(userId, requestId, trace, 'success'));
      return completed;
    } catch (error) {
      await journal.finishError(error, timing.finish());
      if (trace)
        observe(() => {
          trace.error(error instanceof Error ? error.message : '请求失败');
          this.diagnostics?.finish(userId, requestId, trace, 'error');
        });
      throw error;
    }
  }
}
