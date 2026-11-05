import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { RequestValidationError } from '@ts-rest/nest';
import type { Response } from 'express';

@Catch(RequestValidationError)
export class ContractValidationFilter implements ExceptionFilter<RequestValidationError> {
  catch(exception: RequestValidationError, host: ArgumentsHost): void {
    const message = [
      exception.pathParams,
      exception.headers,
      exception.query,
      exception.body,
    ].flatMap((error) => error?.issues.map((issue) => issue.message) ?? []);
    host.switchToHttp().getResponse<Response>().status(400).json({
      statusCode: 400,
      error: 'Bad Request',
      message,
    });
  }
}
