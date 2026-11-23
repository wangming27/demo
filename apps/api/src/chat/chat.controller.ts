import { Controller, Header, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { chatContract } from '@repo/contracts';
import { TsRest, TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import type { Response } from 'express';
import { OriginGuard, SessionGuard } from '../auth/auth.guards';
import { AuthenticatedRequest } from '../auth/auth.types';
import { ChatService } from './chat.service';

function userId(request: AuthenticatedRequest): string {
  if (!request.authUser) throw new UnauthorizedException('请先登录');
  return request.authUser.id;
}

@Controller()
@TsRest({ validateResponses: true })
@UseGuards(SessionGuard, OriginGuard, ThrottlerGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

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
