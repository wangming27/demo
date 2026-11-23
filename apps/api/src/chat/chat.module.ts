import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatAgentService } from './chat-agent.service';
import { WebToolsService } from './web-tools.service';
import { ChatHistoryService } from './chat-history.service';
import { ChatStorageService } from './chat-storage.service';
import { ChatHistoryController } from './chat-history.controller';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
  ],
  controllers: [ChatController, ChatHistoryController],
  providers: [
    ChatService,
    ChatAgentService,
    WebToolsService,
    ChatHistoryService,
    ChatStorageService,
  ],
})
export class ChatModule {}
