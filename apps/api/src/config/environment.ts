import { resolve } from 'node:path';
import dotenv from 'dotenv';

const production = process.env['NODE_ENV'] === 'production';
dotenv.config({
  path: [
    resolve(__dirname, '../../.env'),
    ...(production ? [] : [resolve(__dirname, '../../../../.env')]),
  ],
  quiet: true,
});

export interface Environment {
  production: boolean;
  databaseUrl: string;
  allowedOrigins: ReadonlySet<string>;
  cookieName: string;
  trustProxyHops: number;
}

export function getEnvironment(): Environment {
  const production = process.env['NODE_ENV'] === 'production';
  let databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl && !production) {
    const user = process.env['POSTGRES_USER'];
    const password = process.env['POSTGRES_PASSWORD'];
    const database = process.env['POSTGRES_DB'];
    const port = process.env['POSTGRES_PORT'] || '5432';
    if (user && password && database) {
      databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
    }
  }
  if (!databaseUrl) {
    throw new Error('Set DATABASE_URL, or configure local POSTGRES_* in the root .env');
  }
  const database = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  }

  const origins =
    process.env['AUTH_ALLOWED_ORIGINS'] ??
    (production ? '' : 'http://127.0.0.1:5173,http://localhost:5173');
  const allowedOrigins = new Set(
    origins
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  if (allowedOrigins.size === 0) {
    throw new Error('Set AUTH_ALLOWED_ORIGINS to the frontend origin');
  }
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      !['http:', 'https:'].includes(url.protocol) ||
      (production && url.protocol !== 'https:')
    ) {
      throw new Error('AUTH_ALLOWED_ORIGINS must contain exact origins; use HTTPS in production');
    }
  }

  const trustProxyHops = Number(process.env['TRUST_PROXY_HOPS'] ?? 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5');
  }

  return {
    production,
    databaseUrl,
    allowedOrigins,
    cookieName: production ? '__Host-demo_session' : 'demo_session',
    trustProxyHops,
  };
}
