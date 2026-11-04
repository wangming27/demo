import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { getEnvironment } from '../config/environment';
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from './auth.types';
import { readToken } from './session';

@Injectable()
export class OriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return true;
    }
    const origin = request.get('origin');
    if (!origin || !getEnvironment().allowedOrigins.has(origin)) {
      throw new ForbiddenException('请求来源不受信任');
    }
    return true;
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.authUser = await this.authService.currentUser(readToken(request));
    return true;
  }
}
