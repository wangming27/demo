import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ChatCompletionResponseSchema,
  ChatHistoryPageSchema,
  ChatTimingSchema,
} from '@repo/contracts';
import type { ChatCompletion, ChatCompletionResponse, ChatTiming } from '@repo/contracts';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { ChatHistory, ChatReply, ChatToolCall } from '../generated/prisma/client';
import { ChatStorageService, resourceSchema } from './chat-storage.service';
import type { ChatResource } from './chat-storage.service';
import type { ChatRecording } from './chat-recording';
import type { ModelTurn } from './model-api';
import type { ModelDelta } from './chat-progress';
import type { ToolResult } from './web-tools.service';

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
function failure(error: unknown, cancelled: boolean) {
  return {
    code: cancelled ? 'CANCELLED' : 'FAILED',
    message: error instanceof Error ? error.message : '请求失败',
  };
}
function serialize<T extends ChatHistory | ChatReply | ChatToolCall>(row: T) {
  return JSON.parse(
    JSON.stringify(row, (key, value: unknown) => {
      if (key === 'requestHash' || key === 'nextSequence' || key === 'key' || key === 'heartbeatAt')
        return undefined;
      if (typeof value === 'bigint') {
        const number = Number(value);
        if (!Number.isSafeInteger(number)) throw new Error('记录数值超出安全整数范围');
        return number;
      }
      return value;
    }),
  ) as Record<string, unknown>;
}

@Injectable()
export class ChatHistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatHistoryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private cleaning = false;
  constructor(
    readonly prisma: PrismaService,
    readonly storage: ChatStorageService,
  ) {}

  onModuleInit() {
    const run = () => {
      void this.maintain().catch((error: unknown) => this.logger.error('历史记录维护失败', error));
    };
    run();
    this.timer = setInterval(run, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async begin(userId: string, input: ChatCompletion, signal: AbortSignal) {
    const requestId = input.requestId ?? randomUUID();
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          modelId: input.modelId,
          messages: input.messages,
          webSearch: input.webSearch ?? false,
          conversationId: input.conversationId ?? null,
          previousHistoryId: input.previousHistoryId ?? null,
          retryOfHistoryId: input.retryOfHistoryId ?? null,
        }),
      )
      .digest('hex');
    const existing = await this.prisma.chatHistory.findUnique({
      where: { userId_requestId: { userId, requestId } },
    });
    if (existing) return this.duplicate(existing, requestHash);
    const model = await this.prisma.chatModel.findFirst({
      where: { id: input.modelId, userId, deletedAt: null },
      select: { id: true, contextWindow: true },
    });
    if (!model) throw new NotFoundException('模型配置不存在，请重新选择');
    const conversationId = input.conversationId ?? randomUUID();
    for (const id of [input.previousHistoryId, input.retryOfHistoryId]) {
      if (!id) continue;
      const linked = await this.prisma.chatHistory.findFirst({
        where: { id, userId, conversationId, deletedAt: null },
      });
      if (!linked) throw new BadRequestException('关联记录不属于当前用户和会话');
      if (id === input.previousHistoryId && linked.status !== 'SUCCEEDED')
        throw new BadRequestException('前一条记录尚未成功完成');
    }
    signal.throwIfAborted();
    const startedAt = new Date();
    let row: ChatHistory;
    try {
      row = await this.prisma.chatHistory.create({
        data: {
          userId,
          modelId: input.modelId,
          conversationId,
          requestId,
          requestHash,
          previousHistoryId: input.previousHistoryId ?? null,
          retryOfHistoryId: input.retryOfHistoryId ?? null,
          query: input.messages.at(-1)!.content,
          status: 'RUNNING',
          startedAt,
          contextWindowTokens: model.contextWindow,
          contextWindowSource: model.contextWindow ? 'configured' : 'unknown',
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.prisma.chatHistory.findUniqueOrThrow({
          where: { userId_requestId: { userId, requestId } },
        });
        return this.duplicate(duplicate, requestHash);
      }
      throw error;
    }
    const journal = new ChatJournal(this, row, signal);
    try {
      const resources = await this.storage.images(
        userId,
        row.id,
        input.messages.at(-1)!.images ?? [],
      );
      await this.prisma.chatHistory.update({
        where: { id: row.id },
        data: { resources: json(resources) },
      });
    } catch (error) {
      await journal.finishError(error);
      throw error;
    }
    return { journal };
  }

  private async duplicate(
    row: ChatHistory,
    hash: string,
  ): Promise<{ replay: ChatCompletionResponse }> {
    if (row.deletedAt || row.requestHash !== hash)
      throw new ConflictException('请求 ID 已用于其他提问');
    if (row.status !== 'SUCCEEDED')
      throw new ConflictException('请求已存在；重试请使用新的请求 ID');
    const reply = await this.prisma.chatReply.findFirst({
      where: { historyId: row.id, isFinal: true, status: 'SUCCEEDED' },
      orderBy: { round: 'desc' },
    });
    if (!reply?.content) throw new ConflictException('历史回复尚不可重放');
    const toolRows = await this.prisma.chatToolCall.findMany({
      where: { historyId: row.id },
      orderBy: { sequence: 'asc' },
    });
    const metadata = await this.toolMetadata(row, toolRows);
    return {
      replay: ChatCompletionResponseSchema.parse({
        historyId: row.id,
        content: reply.content,
        ...(reply.inputTokens !== null && reply.outputTokens !== null
          ? {
              usage: {
                inputTokens: Number(reply.inputTokens),
                outputTokens: Number(reply.outputTokens),
              },
            }
          : {}),
        contextUsage: { windowTokens: row.contextWindowTokens, source: row.contextWindowSource },
        ...metadata,
      }),
    };
  }

  private async toolMetadata(row: ChatHistory, toolRows: ChatToolCall[]) {
    const sources: NonNullable<ChatCompletionResponse['sources']> = [];
    const warnings = new Set<string>();
    for (const tool of toolRows) {
      let output: unknown = tool.output;
      const reference = z.object({ resourceId: z.string().uuid() }).safeParse(output);
      if (reference.success) {
        const resources = resourceSchema.array().parse(tool.resources);
        const descriptor = resources.find((item) => item.id === reference.data.resourceId);
        if (descriptor)
          output = JSON.parse(
            (await this.storage.read(row.userId, row.id, descriptor)).data.toString('utf8'),
          );
      }
      const metadata = z
        .object({
          sources: ChatCompletionResponseSchema.shape.sources,
          warning: z.string().optional(),
        })
        .safeParse(output);
      if (metadata.success) {
        if (metadata.data.warning) warnings.add(metadata.data.warning);
        for (const source of metadata.data.sources ?? [])
          if (sources.length < 20 && !sources.some((item) => item.url === source.url))
            sources.push(source);
      }
    }
    return {
      ...(sources.length ? { sources } : {}),
      ...(warnings.size ? { searchWarning: [...warnings].join('；').slice(0, 1000) } : {}),
    };
  }

  async feed(userId: string, cursor?: string) {
    const anchor = cursor
      ? await this.prisma.chatHistory.findFirst({
          where: { id: cursor, userId },
          select: { id: true, createdAt: true },
        })
      : null;
    if (cursor && !anchor) throw new BadRequestException('历史游标无效');
    const rows = await this.prisma.chatHistory.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(anchor
          ? {
              OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 11,
      include: {
        model: { select: { id: true, name: true } },
        replies: { orderBy: { round: 'desc' }, take: 1 },
        toolCalls: { orderBy: { sequence: 'asc' } },
      },
    });
    const items = await Promise.all(
      rows.slice(0, 10).map(async (row) => {
        const reply = row.replies[0];
        const timing = ChatTimingSchema.safeParse(row.timings);
        return {
          id: row.id,
          conversationId: row.conversationId,
          query: row.query,
          createdAt: row.createdAt.toISOString(),
          status: row.status,
          model: row.model,
          resources: resourceSchema
            .array()
            .parse(row.resources)
            .map(({ id, name, mime, bytes }) => ({ id, name, mime, bytes })),
          reply: reply
            ? {
                id: reply.id,
                content: reply.content,
                reasoningContent: reply.reasoningContent,
                isFinal: reply.isFinal,
                ...(reply.inputTokens !== null && reply.outputTokens !== null
                  ? {
                      usage: {
                        inputTokens: Number(reply.inputTokens),
                        outputTokens: Number(reply.outputTokens),
                      },
                    }
                  : {}),
              }
            : null,
          contextUsage: { windowTokens: row.contextWindowTokens, source: row.contextWindowSource },
          ...(timing.success ? { timing: timing.data } : {}),
          durationMs: row.durationMs === null ? null : Number(row.durationMs),
          ...(await this.toolMetadata(row, row.toolCalls)),
        };
      }),
    );
    return ChatHistoryPageSchema.parse({
      items,
      nextCursor: rows.length > 10 ? items.at(-1)!.id : null,
    });
  }

  async list(userId: string, page: number, pageSize: number) {
    const where = { userId, deletedAt: null };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.chatHistory.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.chatHistory.count({ where }),
    ]);
    return { items: items.map((row) => this.history(row)), total, page, pageSize };
  }
  private history(row: ChatHistory) {
    return {
      ...serialize(row),
      contextUsageRatio:
        row.contextUsedTokens !== null && row.contextWindowTokens
          ? Number(row.contextUsedTokens) / row.contextWindowTokens
          : null,
    };
  }
  async detail(userId: string, id: string) {
    const row = await this.prisma.chatHistory.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        replies: { orderBy: { sequence: 'asc' } },
        toolCalls: { orderBy: { sequence: 'asc' } },
      },
    });
    if (!row) throw new NotFoundException('历史记录不存在');
    const { replies, toolCalls, ...main } = row;
    return {
      history: this.history(main),
      replies: replies.map(serialize),
      toolCalls: toolCalls.map(serialize),
      replyChain: replies.map((item) => item.id),
      toolCallChain: toolCalls.map((item) => item.id),
    };
  }
  async resource(userId: string, id: string, resourceId: string) {
    const row = await this.prisma.chatHistory.findFirst({
      where: { id, userId, deletedAt: null },
      include: { replies: true, toolCalls: true },
    });
    if (!row) throw new NotFoundException('历史记录不存在');
    const descriptors = [row, ...row.replies, ...row.toolCalls].flatMap((item) =>
      resourceSchema.array().parse(item.resources),
    );
    const descriptor = descriptors.find((item) => item.id === resourceId);
    if (!descriptor) throw new NotFoundException('资源不存在');
    return this.storage.read(userId, id, descriptor);
  }
  async delete(userId: string, id: string) {
    const row = await this.prisma.chatHistory.findFirst({ where: { id, userId, deletedAt: null } });
    if (!row) throw new NotFoundException('历史记录不存在');
    if (row.status === 'RUNNING') throw new ConflictException('正在生成的记录不能删除');
    const result = await this.prisma.chatHistory.updateMany({
      where: { id, userId, deletedAt: null, status: { not: 'RUNNING' } },
      data: { deletedAt: new Date() },
    });
    if (!result.count) throw new ConflictException('记录状态已变化');
    await this.storage.remove(userId, id);
  }

  async maintain() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      const cutoff = new Date(Date.now() - 5 * 60_000);
      await this.prisma.$transaction(async (tx) => {
        const stale = await tx.chatHistory.updateManyAndReturn({
          where: { status: 'RUNNING', heartbeatAt: { lt: cutoff } },
          data: {
            status: 'INTERRUPTED',
            finishedAt: new Date(),
            error: { code: 'INTERRUPTED', message: '服务中断，未完成的请求已保留' },
          },
          select: { id: true },
        });
        const historyId = { in: stale.map((item) => item.id) };
        const data = {
          status: 'INTERRUPTED' as const,
          finishedAt: new Date(),
          error: { code: 'INTERRUPTED', message: '服务中断' },
        };
        await tx.chatReply.updateMany({ where: { historyId, status: 'RUNNING' }, data });
        await tx.chatToolCall.updateMany({ where: { historyId, status: 'RUNNING' }, data });
      });
      // A tombstone makes interrupted file deletion retryable.
      for (const row of await this.prisma.chatHistory.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, userId: true },
      }))
        await this.storage.remove(row.userId, row.id);
      await this.cleanOrphans();
    } finally {
      this.cleaning = false;
    }
  }

  private async cleanOrphans() {
    let users;
    try {
      users = await readdir(this.storage.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const user of users) {
      if (!user.isDirectory() || !z.string().uuid().safeParse(user.name).success) continue;
      for (const entry of await readdir(join(this.storage.root, user.name), {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue;
        const directory = this.storage.directory(user.name, entry.name);
        const row = await this.prisma.chatHistory.findFirst({
          where: { id: entry.name, userId: user.name },
          include: { replies: true, toolCalls: true },
        });
        if (row?.status === 'RUNNING') continue;
        const keys = new Set(
          row
            ? [row, ...row.replies, ...row.toolCalls].flatMap((item) =>
                resourceSchema
                  .array()
                  .parse(item.resources)
                  .map((resource) => resource.key),
              )
            : [],
        );
        for (const file of await readdir(directory, { withFileTypes: true })) {
          if (!file.isFile() || keys.has(file.name)) continue;
          const path = join(directory, file.name);
          if ((await stat(path)).mtimeMs < Date.now() - 24 * 60 * 60_000) await rm(path);
        }
      }
    }
  }
}

export class ChatJournal implements ChatRecording {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly replies = new Map<
    number,
    {
      id: string;
      content: string;
      reasoningContent: string;
      started: number;
      dirty: boolean;
      firstResponseMs: number | null;
    }
  >();
  private readonly tools = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private persistenceError: unknown;
  private readonly timer: ReturnType<typeof setInterval>;
  private tickPending = false;
  constructor(
    private readonly owner: ChatHistoryService,
    readonly row: ChatHistory,
    private readonly clientSignal: AbortSignal,
  ) {
    this.signal = AbortSignal.any([clientSignal, this.controller.signal]);
    this.timer = setInterval(() => {
      if (this.tickPending) return;
      this.tickPending = true;
      void this.flush()
        .finally(() => {
          this.tickPending = false;
        })
        .catch((error: unknown) => {
          this.persistenceError = error;
          this.controller.abort(error);
        });
    }, 1000);
    this.timer.unref();
  }
  private async sequence() {
    const row = await this.owner.prisma.chatHistory.update({
      where: { id: this.row.id, status: 'RUNNING' },
      data: { nextSequence: { increment: 1 } },
    });
    return row.nextSequence - 1;
  }
  private flush() {
    this.queue = this.queue.then(async () => {
      for (const reply of this.replies.values())
        if (reply.dirty) {
          const content = reply.content;
          const reasoningContent = reply.reasoningContent || null;
          reply.dirty = false;
          await this.owner.prisma.chatReply.updateMany({
            where: { id: reply.id, status: 'RUNNING' },
            data: { content, reasoningContent },
          });
        }
      await this.owner.prisma.chatHistory.updateMany({
        where: { id: this.row.id, status: 'RUNNING' },
        data: { heartbeatAt: new Date() },
      });
    });
    return this.queue;
  }
  async replyStart(round: number) {
    const startedAt = new Date();
    const reply = await this.owner.prisma.chatReply.create({
      data: {
        historyId: this.row.id,
        round,
        sequence: await this.sequence(),
        status: 'RUNNING',
        startedAt,
      },
    });
    this.replies.set(round, {
      id: reply.id,
      content: '',
      reasoningContent: '',
      started: startedAt.getTime(),
      dirty: false,
      firstResponseMs: null,
    });
  }
  delta(event: ModelDelta) {
    const reply = this.replies.get(event.round);
    if (!reply) return;
    if (event.content || event.reasoning || event.toolCall)
      reply.firstResponseMs ??= Date.now() - reply.started;
    if (event.content) {
      reply.content += event.content;
      reply.dirty = true;
    }
    if (event.reasoning) {
      reply.reasoningContent += event.reasoning;
      reply.dirty = true;
    }
  }
  async replyEnd(round: number, turn: ModelTurn) {
    await this.flush();
    const reply = this.replies.get(round)!;
    await this.owner.prisma.chatReply.updateMany({
      where: { id: reply.id, status: 'RUNNING' },
      data: {
        content: turn.content ?? null,
        reasoningContent: turn.reasoning_content || turn.reasoning || null,
        finishReason: turn.finishReason ?? null,
        isFinal: !turn.tool_calls?.length,
        inputTokens: turn.usage?.inputTokens ?? null,
        outputTokens: turn.usage?.outputTokens ?? null,
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        durationMs: Date.now() - reply.started,
        timings: { firstResponseMs: reply.firstResponseMs },
      },
    });
    await this.owner.prisma.chatHistory.updateMany({
      where: { id: this.row.id, status: 'RUNNING' },
      data: { contextUsedTokens: turn.usage?.inputTokens ?? null },
    });
  }
  async replyError(round: number, error: unknown) {
    await this.flush().catch(() => undefined);
    const reply = this.replies.get(round);
    if (!reply) return;
    await this.owner.prisma.chatReply.updateMany({
      where: { id: reply.id, status: 'RUNNING' },
      data: {
        content: reply.content || null,
        reasoningContent: reply.reasoningContent || null,
        status: this.clientSignal.aborted ? 'CANCELLED' : 'FAILED',
        finishedAt: new Date(),
        durationMs: Date.now() - reply.started,
        timings: { firstResponseMs: reply.firstResponseMs },
        error: failure(error, this.clientSignal.aborted),
      },
    });
  }
  async toolStart(round: number, call: NonNullable<ModelTurn['tool_calls']>[number]) {
    let args: Prisma.InputJsonValue | undefined;
    try {
      const parsed: unknown = JSON.parse(call.function.arguments);
      if (parsed !== null) args = json(parsed);
    } catch {
      /* Preserve invalid raw arguments. */
    }
    const startedAt = new Date();
    const tool = await this.owner.prisma.chatToolCall.create({
      data: {
        historyId: this.row.id,
        replyId: this.replies.get(round)!.id,
        round,
        sequence: await this.sequence(),
        toolCallId: call.id,
        toolName: call.function.name,
        argumentsRaw: call.function.arguments,
        arguments: args ?? Prisma.DbNull,
        status: 'RUNNING',
        startedAt,
      },
    });
    this.tools.set(tool.id, startedAt.getTime());
    return tool.id;
  }
  async toolEnd(id: string, result: ToolResult) {
    const buffer = Buffer.from(JSON.stringify(result));
    let output: Prisma.InputJsonValue = json(result);
    const resources: ChatResource[] = [];
    if (buffer.length > 128 * 1024) {
      const resource = await this.owner.storage.save(
        this.row.userId,
        this.row.id,
        'tool-output.json',
        'application/json',
        buffer,
      );
      resources.push(resource);
      output = { resourceId: resource.id };
    }
    await this.owner.prisma.chatToolCall.updateMany({
      where: { id, status: 'RUNNING' },
      data: {
        output,
        resources: json(resources),
        status: result.warning ? 'FAILED' : 'SUCCEEDED',
        ...(result.warning ? { error: { code: 'TOOL_WARNING', message: result.warning } } : {}),
        finishedAt: new Date(),
        durationMs: Date.now() - this.tools.get(id)!,
      },
    });
  }
  async toolError(id: string, error: unknown) {
    await this.owner.prisma.chatToolCall.updateMany({
      where: { id, status: 'RUNNING' },
      data: {
        status: this.clientSignal.aborted ? 'CANCELLED' : 'FAILED',
        error: failure(error, this.clientSignal.aborted),
        finishedAt: new Date(),
        durationMs: Date.now() - this.tools.get(id)!,
      },
    });
  }
  async finish(answer: ChatCompletionResponse, timing?: ChatTiming) {
    clearInterval(this.timer);
    await this.flush();
    if (this.persistenceError)
      throw this.persistenceError instanceof Error
        ? this.persistenceError
        : new Error('历史记录保存失败');
    this.signal.throwIfAborted();
    const used = answer.usage?.inputTokens;
    const result = await this.owner.prisma.chatHistory.updateMany({
      where: { id: this.row.id, status: 'RUNNING' },
      data: {
        status: 'SUCCEEDED',
        contextUsedTokens: used ?? null,
        contextWindowTokens: answer.contextUsage?.windowTokens ?? null,
        contextWindowSource: answer.contextUsage?.source ?? 'unknown',
        timings: timing ? json(timing) : {},
        finishedAt: new Date(),
        durationMs: Date.now() - this.row.startedAt!.getTime(),
      },
    });
    if (!result.count) throw new ConflictException('记录已被标记为中断');
  }
  async finishError(error: unknown, timing?: ChatTiming) {
    clearInterval(this.timer);
    await this.flush().catch(() => undefined);
    const data = {
      status: this.clientSignal.aborted ? ('CANCELLED' as const) : ('FAILED' as const),
      error: failure(this.persistenceError ?? error, this.clientSignal.aborted),
      finishedAt: new Date(),
    };
    await this.owner.prisma.$transaction(async (tx) => {
      await tx.chatHistory.updateMany({
        where: { id: this.row.id, status: 'RUNNING' },
        data: {
          ...data,
          durationMs: Date.now() - this.row.startedAt!.getTime(),
          timings: timing ? json(timing) : {},
        },
      });
      await tx.chatReply.updateMany({ where: { historyId: this.row.id, status: 'RUNNING' }, data });
      await tx.chatToolCall.updateMany({
        where: { historyId: this.row.id, status: 'RUNNING' },
        data,
      });
    });
  }
}
