import { Controller } from '@nestjs/common';
import { healthContract } from '@repo/contracts';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @TsRestHandler(healthContract.get, { validateResponses: true })
  getHealth() {
    return tsRestHandler(healthContract.get, () =>
      Promise.resolve({
        status: 200,
        body: this.appService.getHealth(),
      }),
    );
  }
}
