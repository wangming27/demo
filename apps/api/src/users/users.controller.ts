import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { OriginGuard, SessionGuard } from '../auth/auth.guards';
import { AuthenticatedRequest } from '../auth/auth.types';
import { AdminGuard } from './admin.guard';
import { CreateUserDto, ListUsersDto, UpdateUserDto } from './users.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(SessionGuard, AdminGuard, OriginGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() input: ListUsersDto) {
    return this.usersService.list(input);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  detail(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.usersService.detail(id);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Req() request: AuthenticatedRequest, @Body() input: CreateUserDto) {
    if (!request.authUser) throw new UnauthorizedException('请先登录');
    return this.usersService.create(request.authUser.id, input);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateUserDto,
  ) {
    if (!request.authUser) throw new UnauthorizedException('请先登录');
    return this.usersService.update(request.authUser.id, id, input);
  }
}
