import { createRequire } from 'node:module';
import { PrismaPg } from '@prisma/adapter-pg';
import config from '../prisma.config.mjs';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || process.argv.length !== 3) {
  console.error('Usage: corepack pnpm users:admin <existing-user-email>');
  process.exitCode = 1;
} else {
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require('../.test-dist/generated/prisma/client.js');
  const url = config.datasource?.url;
  if (!url) throw new Error('Configure DATABASE_URL first');
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: url },
      { schema: new URL(url).searchParams.get('schema') ?? 'public' },
    ),
  });
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      console.error('An existing active account is required.');
      process.exitCode = 1;
    } else {
      await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
      console.log('Administrator granted. Refresh the page or sign in again.');
    }
  } finally {
    await prisma.$disconnect();
  }
}
