import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { chatDebugEnabled } from '../config/environment';
import { ChatDebugModule } from '../chat-debug/chat-debug.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatAgentService } from './chat-agent.service';
import { WebToolsService } from './web-tools.service';
import { ChatHistoryService } from './chat-history.service';
import { ChatStorageService } from './chat-storage.service';
import { ChatHistoryController } from './chat-history.controller';
import { ResearchAgentService } from './agents/research-agent.service';
import { SubAgentRegistry } from './agents/sub-agent-registry.service';
import { SUB_AGENTS } from './agents/agent-types';

@Module({
  imports: [
    ...(chatDebugEnabled() ? [ChatDebugModule] : []),
    AuthModule,
    DatabaseModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
  ],
  controllers: [ChatController, ChatHistoryController],
  providers: [
    ChatService,
    ChatAgentService,
    WebToolsService,
    ResearchAgentService,
    {
      provide: SUB_AGENTS,
      useFactory: (research: ResearchAgentService) => [research],
      inject: [ResearchAgentService],
    },
    SubAgentRegistry,
    ChatHistoryService,
    ChatStorageService,
  ],
})
export class ChatModule {}
