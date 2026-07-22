import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { YormunError } from '../errors/yormun-error';

/** Traduce YormunError.httpStatus a una respuesta HTTP real (ej. RBAC 403). */
@Catch(YormunError)
export class YormunErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(YormunErrorFilter.name);

  catch(exception: YormunError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception.httpStatus ?? 500;

    this.logger.error(`[${exception.code}] ${exception.message}`);

    response.status(status).json({
      statusCode: status,
      code: exception.code,
      message: exception.message,
    });
  }
}
