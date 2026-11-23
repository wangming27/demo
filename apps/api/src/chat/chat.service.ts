import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { ChatCompletion, CreateChatModel, UpdateChatModel } from '@repo/contracts';
import { PrismaService } from '../database/prisma.service';
import type { ChatModel } from '../generated/prisma/client';
import { callModel, modelEndpoint } from './model-api';
import { ChatAgentService } from './chat-agent.service';
import { ChatTrace } from './chat-trace';
import { resolveContextWindow } from './model-context';

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
  ) {}

  async list(userId: string) {
    const models = await this.prisma.chatModel.findMany({
      where: { userId },
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
      where: { id, userId },
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
    const result = await this.prisma.chatModel.deleteMany({ where: { id, userId } });
    if (!result.count) throw new NotFoundException('模型配置不存在');
  }

  async complete(userId: string, input: ChatCompletion, signal: AbortSignal) {
    const model = await this.prisma.chatModel.findFirst({ where: { id: input.modelId, userId } });
    if (!model) throw new NotFoundException('模型配置不存在，请重新选择');
    const trace = input.debug
      ? new ChatTrace({ name: model.name, model: model.model, baseUrl: model.baseUrl })
      : undefined;
    try {
      const answer = input.webSearch
        ? await this.agent.complete(model, input.messages, signal, trace)
        : await callModel(model.baseUrl, model.apiKey, model.model, input.messages, signal, trace);
      const contextUsage = await resolveContextWindow(model, signal);
      return { ...answer, contextUsage, ...(trace ? { debug: trace.finish('success') } : {}) };
    } catch (error) {
      if (trace && error instanceof HttpException && !signal.aborted) {
        trace.error(error.message);
        const body = error.getResponse();
        throw new HttpException(
          {
            ...(typeof body === 'string' ? { message: body } : body),
            debug: trace.finish('error'),
          },
          error.getStatus(),
        );
      }
      throw error;
    }
  }
}
