import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { getEnvironment } from '../config/environment';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const { databaseUrl } = getEnvironment();
    super({
      adapter: new PrismaPg(
        {
          connectionString: databaseUrl,
          max: 10,
          connectionTimeoutMillis: 5_000,
        },
        { schema: new URL(databaseUrl).searchParams.get('schema') ?? 'public' },
      ),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
