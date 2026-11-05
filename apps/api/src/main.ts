import 'reflect-metadata';
import './config/environment';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { getEnvironment } from './config/environment';
import { ContractValidationFilter } from './contracts/validation.filter';

async function bootstrap(): Promise<void> {
  const environment = getEnvironment();
  const port = Number(process.env['PORT'] ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.disable('x-powered-by');
  if (environment.trustProxyHops > 0) {
    app.set('trust proxy', environment.trustProxyHops);
  }
  app.useBodyParser('json', { limit: '16kb' });
  app.useGlobalFilters(new ContractValidationFilter());
  app.enableShutdownHooks();

  try {
    await app.listen(port, '127.0.0.1');
    Logger.log(`API ready at http://127.0.0.1:${port}/api/health`, 'Bootstrap');
  } catch (error: unknown) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.stack : String(error), undefined, 'Bootstrap');
  process.exitCode = 1;
});
