import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { mapPublicError } from './public-errors.js';

interface RequestWithId {
  id?: string;
}

interface ReplyLike {
  status(statusCode: number): {
    send(payload: unknown): void;
  };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithId>();
    const response = context.getResponse<ReplyLike>();
    const statusCode = exception instanceof HttpException ? exception.getStatus() : 500;
    const publicError = mapPublicError(statusCode);

    if (statusCode >= 500) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error('Unhandled API exception', stack);
    }

    response.status(statusCode).send({
      error: publicError,
      requestId: request.id ?? null,
      timestamp: new Date().toISOString(),
    });
  }
}
