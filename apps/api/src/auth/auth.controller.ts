import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { getEnvironment } from '../config/environment';
import { CredentialsDto, RegisterDto } from './auth.dto';
import { OriginGuard, SessionGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { AuthenticatedRequest, PublicUser } from './auth.types';
import { cookieOptions, readToken, SESSION_DURATION_MS } from './session';

@Controller('auth')
@UseGuards(OriginGuard, ThrottlerGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async register(
    @Body() input: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: PublicUser }> {
    const result = await this.authService.register(input, readToken(request));
    this.setSession(response, result.token);
    return { user: result.user };
  }

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Body() input: CredentialsDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: PublicUser }> {
    const result = await this.authService.login(input, readToken(request));
    this.setSession(response, result.token);
    return { user: result.user };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  me(@Req() request: AuthenticatedRequest): { user: PublicUser } {
    if (!request.authUser) {
      throw new UnauthorizedException('请先登录');
    }
    return { user: request.authUser };
  }

  @Post('logout')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.logout(readToken(request));
    response.clearCookie(getEnvironment().cookieName, cookieOptions());
  }

  private setSession(response: Response, token: string): void {
    response.cookie(getEnvironment().cookieName, token, {
      ...cookieOptions(),
      maxAge: SESSION_DURATION_MS,
    });
  }
}
