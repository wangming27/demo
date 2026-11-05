import { Injectable } from '@nestjs/common';

import type { HealthResponse } from '@repo/contracts';

@Injectable()
export class AppService {
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: '@repo/api',
      timestamp: new Date().toISOString(),
    };
  }
}
