import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { HttpReply } from './identity/http.types.js';
import { DATABASE_READINESS, type DatabaseReadinessProbe } from './database/database-readiness.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE_READINESS) private readonly database: DatabaseReadinessProbe,
  ) {}

  @Get('live')
  getLiveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async getReadiness(@Res({ passthrough: true }) reply: HttpReply) {
    try {
      await this.database.queryInfrastructure('SELECT 1');
      reply.code(HttpStatus.OK);
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        dependencies: { postgres: 'ready' },
      };
    } catch {
      reply.code(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        dependencies: { postgres: 'unavailable' },
      };
    }
  }
}
