import {
  Controller,
  Get,
  Header,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { ChatDebugTrace } from '@repo/contracts';
import { UserIdParamsSchema } from '@repo/contracts';
import { AuthModule } from '../auth/auth.module';
import { SessionGuard } from '../auth/auth.guards';
import { AuthenticatedRequest } from '../auth/auth.types';
import { CHAT_DIAGNOSTICS } from '../chat/chat-diagnostics';
import type { ChatDiagnostics } from '../chat/chat-diagnostics';
import { ChatTrace } from './chat-trace';
import type { ChatTrace as TraceCollector } from '../chat/chat-trace';

const ttl = 30 * 60_000;
const maxRecords = 30;
const maxBytes = 16 * 1024 * 1024;

@Injectable()
export class ChatDebugStore implements ChatDiagnostics {
  private readonly records = new Map<
    string,
    { expires: number; bytes: number; trace: ChatDebugTrace }
  >();
  private bytes = 0;

  start(_userId: string, requestId: string, model: ChatDebugTrace['model']) {
    return new ChatTrace(model, requestId);
  }

  finish(
    userId: string,
    requestId: string,
    collector: TraceCollector,
    status: ChatDebugTrace['status'],
  ) {
    this.prune();
    const trace = collector.finish(status);
    const bytes = Buffer.byteLength(JSON.stringify(trace));
    if (bytes > maxBytes) return;
    const key = `${userId}:${requestId}`;
    this.remove(key);
    while (this.records.size >= maxRecords || this.bytes + bytes > maxBytes) {
      const oldest = this.records.keys().next().value;
      if (!oldest) break;
      this.remove(oldest);
    }
    this.records.set(key, { expires: Date.now() + ttl, bytes, trace });
    this.bytes += bytes;
  }

  get(userId: string, requestId: string) {
    this.prune();
    return this.records.get(`${userId}:${requestId}`)?.trace;
  }

  private remove(key: string) {
    const record = this.records.get(key);
    if (record) this.bytes -= record.bytes;
    this.records.delete(key);
  }

  private prune() {
    for (const [key, record] of this.records) {
      if (record.expires <= Date.now()) this.remove(key);
    }
  }
}

@Controller('/api/chat-debug')
@UseGuards(SessionGuard)
export class ChatDebugController {
  constructor(private readonly store: ChatDebugStore) {}

  @Get('/:id')
  @Header('Cache-Control', 'no-store')
  get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    if (!request.authUser) throw new UnauthorizedException('请先登录');
    const parsed = UserIdParamsSchema.safeParse({ id });
    const trace = parsed.success ? this.store.get(request.authUser.id, parsed.data.id) : undefined;
    if (!trace) throw new NotFoundException('调试记录尚未生成、已过期或未启用');
    return trace;
  }
}

@Module({
  imports: [AuthModule],
  controllers: [ChatDebugController],
  providers: [ChatDebugStore, { provide: CHAT_DIAGNOSTICS, useExisting: ChatDebugStore }],
  exports: [CHAT_DIAGNOSTICS],
})
export class ChatDebugModule {}
