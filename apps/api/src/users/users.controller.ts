import { Controller, Header, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { usersContract } from '@repo/contracts';
import { TsRest, TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { OriginGuard, SessionGuard } from '../auth/auth.guards';
import { AuthenticatedRequest } from '../auth/auth.types';
import { AdminGuard } from './admin.guard';
import { serializeManagedUser } from '../contracts/serialize-user';
import { UsersService } from './users.service';

@Controller()
@TsRest({ validateResponses: true })
@UseGuards(SessionGuard, AdminGuard, OriginGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @TsRestHandler(usersContract.list)
  @Header('Cache-Control', 'no-store')
  list() {
    return tsRestHandler(usersContract.list, async ({ query }) => {
      const result = await this.usersService.list(query);
      return {
        status: 200,
        body: { ...result, items: result.items.map(serializeManagedUser) },
      };
    });
  }

  @TsRestHandler(usersContract.detail)
  @Header('Cache-Control', 'no-store')
  detail() {
    return tsRestHandler(usersContract.detail, async ({ params }) => {
      const result = await this.usersService.detail(params.id);
      return { status: 200, body: { user: serializeManagedUser(result.user) } };
    });
  }

  @TsRestHandler(usersContract.create)
  @Header('Cache-Control', 'no-store')
  create(@Req() request: AuthenticatedRequest) {
    return tsRestHandler(usersContract.create, async ({ body }) => {
      if (!request.authUser) throw new UnauthorizedException('请先登录');
      const result = await this.usersService.create(request.authUser.id, body);
      return { status: 201, body: { user: serializeManagedUser(result.user) } };
    });
  }

  @TsRestHandler(usersContract.update)
  @Header('Cache-Control', 'no-store')
  update(@Req() request: AuthenticatedRequest) {
    return tsRestHandler(usersContract.update, async ({ params, body }) => {
      if (!request.authUser) throw new UnauthorizedException('请先登录');
      const result = await this.usersService.update(request.authUser.id, params.id, body);
      return { status: 200, body: { user: serializeManagedUser(result.user) } };
    });
  }
}
