import {
  BadRequestException,
  Body,
  Controller,
  Header,
  HttpException,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { chatContract, ChatCompletionSchema } from '@repo/contracts';
import type { ChatStreamEvent } from '@repo/contracts';
import { TsRest, TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import type { Response } from 'express';
import { OriginGuard, SessionGuard } from '../auth/auth.guards';
import { AuthenticatedRequest } from '../auth/auth.types';
import { ChatService } from './chat.service';
import { ChatProgress } from './chat-progress';

function userId(request: AuthenticatedRequest): string {
  if (!request.authUser) throw new UnauthorizedException('请先登录');
  return request.authUser.id;
}

@Controller()
@TsRest({ validateResponses: true })
@UseGuards(SessionGuard, OriginGuard, ThrottlerGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post('/api/chat/stream')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async stream(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    const parsed = ChatCompletionSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message));
    const id = userId(request);
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    response.once('close', disconnect);
    const emit = (event: ChatStreamEvent) => {
      if (controller.signal.aborted) return;
      if (!response.headersSent) {
        response.status(200).set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
      }
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      // Bound buffering when the consumer cannot keep up; cancellation also stops upstream work.
      if (response.writableLength > 2 * 1024 * 1024) {
        controller.abort();
        response.destroy();
      }
    };
    const progress = new ChatProgress(emit);
    try {
      const answer = await this.chat.complete(id, parsed.data, controller.signal, progress);
      emit({ type: 'done', answer, timing: progress.finish() });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!response.headersSent) throw error;
      const status = error instanceof HttpException ? error.getStatus() : 500;
      emit({
        type: 'error',
        status,
        message: error instanceof HttpException ? error.message : '服务暂时不可用，请稍后重试',
        timing: progress.finish(),
      });
    } finally {
      response.off('close', disconnect);
      if (response.headersSent && !response.destroyed) response.end();
    }
  }

  @TsRestHandler(chatContract.listModels)
  @Header('Cache-Control', 'no-store')
  list(@Req() request: AuthenticatedRequest) {
    return tsRestHandler(chatContract.listModels, async () => ({
      status: 200,
      body: await this.chat.list(userId(request)),
    }));
  }

  @TsRestHandler(chatContract.createModel)
  @Header('Cache-Control', 'no-store')
  create(@Req() request: AuthenticatedRequest) {
    return tsRestHandler(chatContract.createModel, async ({ body }) => ({
      status: 201,
      body: await this.chat.create(userId(request), body),
    }));
  }

  @TsRestHandler(chatContract.updateModel)
  @Header('Cache-Control', 'no-store')
  update(@Req() request: AuthenticatedRequest) {
    return tsRestHandler(chatContract.updateModel, async ({ params, body }) => ({
      status: 200,
      body: await this.chat.update(userId(request), params.id, body),
    }));
  }

  @TsRestHandler(chatContract.deleteModel)
  @Header('Cache-Control', 'no-store')
  delete(@Req() request: AuthenticatedRequest) {
    return tsRestHandler(chatContract.deleteModel, async ({ params }) => {
      await this.chat.delete(userId(request), params.id);
      return { status: 204, body: undefined };
    });
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @TsRestHandler(chatContract.complete)
  @Header('Cache-Control', 'no-store')
  complete(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
    return tsRestHandler(chatContract.complete, async ({ body }) => {
      const controller = new AbortController();
      const disconnect = () => controller.abort();
      response.once('close', disconnect);
      try {
        return {
          status: 200,
          body: await this.chat.complete(userId(request), body, controller.signal),
        };
      } finally {
        response.off('close', disconnect);
      }
    });
  }
}
