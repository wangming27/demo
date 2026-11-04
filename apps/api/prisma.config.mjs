import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

const apiDir = import.meta.dirname;
dotenv.config({
  path: [resolve(apiDir, '.env'), resolve(apiDir, '../../.env')],
  quiet: true,
});

const localUrl =
  process.env.NODE_ENV !== 'production' &&
  process.env.POSTGRES_USER &&
  process.env.POSTGRES_PASSWORD &&
  process.env.POSTGRES_DB
    ? `postgresql://${encodeURIComponent(process.env.POSTGRES_USER)}:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@127.0.0.1:${process.env.POSTGRES_PORT || '5432'}/${encodeURIComponent(process.env.POSTGRES_DB)}`
    : '';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Client generation does not require a live database or production secrets.
  datasource: { url: process.env.DATABASE_URL || localUrl },
});
