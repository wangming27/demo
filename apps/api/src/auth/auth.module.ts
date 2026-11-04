import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { OriginGuard, SessionGuard } from './auth.guards';
import { AuthService } from './auth.service';

@Module({
  imports: [DatabaseModule, ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }])],
  controllers: [AuthController],
  providers: [AuthService, OriginGuard, SessionGuard, ThrottlerGuard],
  exports: [AuthService, SessionGuard],
})
export class AuthModule {}
