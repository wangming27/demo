import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AdminGuard } from './admin.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [UsersController],
  providers: [UsersService, AdminGuard],
})
export class UsersModule {}
