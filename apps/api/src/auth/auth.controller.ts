import { Controller, Header, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { authContract } from '@repo/contracts';
import { TsRest, TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import type { Request, Response } from 'express';
import { getEnvironment } from '../config/environment';
import { OriginGuard, SessionGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from './auth.types';
import { serializePublicUser } from '../contracts/serialize-user';
import { cookieOptions, readToken, SESSION_DURATION_MS } from './session';

@Controller()
@TsRest({ validateResponses: true })
@UseGuards(OriginGuard, ThrottlerGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @TsRestHandler(authContract.register)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  register(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return tsRestHandler(authContract.register, async ({ body }) => {
      const result = await this.authService.register(body, readToken(request));
      this.setSession(response, result.token);
      return { status: 201, body: { user: serializePublicUser(result.user) } };
    });
  }

  @TsRestHandler(authContract.login)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return tsRestHandler(authContract.login, async ({ body }) => {
      const result = await this.authService.login(body, readToken(request));
      this.setSession(response, result.token);
      return { status: 200, body: { user: serializePublicUser(result.user) } };
    });
  }

  @TsRestHandler(authContract.me)
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  me(@Req() request: AuthenticatedRequest) {
    return tsRestHandler(authContract.me, () => {
      if (!request.authUser) {
        throw new UnauthorizedException('请先登录');
      }
      return Promise.resolve({
        status: 200,
        body: { user: serializePublicUser(request.authUser) },
      });
    });
  }

  @TsRestHandler(authContract.logout)
  @Header('Cache-Control', 'no-store')
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return tsRestHandler(authContract.logout, async () => {
      await this.authService.logout(readToken(request));
      response.clearCookie(getEnvironment().cookieName, cookieOptions());
      return { status: 204, body: undefined };
    });
  }

  private setSession(response: Response, token: string): void {
    response.cookie(getEnvironment().cookieName, token, {
      ...cookieOptions(),
      maxAge: SESSION_DURATION_MS,
    });
  }
}
