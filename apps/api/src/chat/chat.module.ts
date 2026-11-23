import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatAgentService } from './chat-agent.service';
import { WebToolsService } from './web-tools.service';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatAgentService, WebToolsService],
})
export class ChatModule {}
