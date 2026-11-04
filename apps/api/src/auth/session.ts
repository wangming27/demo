import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request } from 'express';
import { getEnvironment } from '../config/environment';

export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

export function createToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function readToken(request: Request): string | undefined {
  const name = getEnvironment().cookieName;
  const cookie = request.headers.cookie
    ?.split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  const token = cookie?.slice(name.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: getEnvironment().production,
    sameSite: 'lax',
    path: '/',
  };
}
