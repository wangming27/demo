import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { ChatHistoryQuerySchema } from '@repo/contracts';
import { OriginGuard, SessionGuard } from '../auth/auth.guards';
import { AuthenticatedRequest } from '../auth/auth.types';
import { ChatHistoryService } from './chat-history.service';

function owner(request: AuthenticatedRequest) {
  if (!request.authUser) throw new UnauthorizedException('请先登录');
  return request.authUser.id;
}
@Controller('/api/chat/histories')
@UseGuards(SessionGuard, OriginGuard, ThrottlerGuard)
export class ChatHistoryController {
  constructor(private readonly histories: ChatHistoryService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = z
      .object({
        page: z.coerce.number().int().min(1).max(100_000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .strict()
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException('分页参数无效');
    return this.histories.list(owner(request), parsed.data.page, parsed.data.pageSize);
  }
  @Get('feed')
  @Header('Cache-Control', 'no-store')
  feed(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = ChatHistoryQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('历史游标无效');
    return this.histories.feed(owner(request), parsed.data.cursor);
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  detail(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.histories.detail(owner(request), id);
  }
  @Get(':id/resources/:resourceId')
  async resource(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Res() response: Response,
  ) {
    const { resource, data } = await this.histories.resource(owner(request), id, resourceId);
    response.set({
      'Content-Type': resource.mime,
      'Content-Length': String(resource.bytes),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(resource.name)}`,
    });
    response.send(data);
  }
  @Delete(':id')
  @HttpCode(204)
  async delete(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.histories.delete(owner(request), id);
  }
}
