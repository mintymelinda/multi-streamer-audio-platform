import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { getHealthResponse } from '@platform/contracts';

@Controller('health')
export class HealthController {
  @Get('live')
  getLiveness() {
    return getHealthResponse();
  }

  @Get('ready')
  @HttpCode(HttpStatus.SERVICE_UNAVAILABLE)
  getReadiness() {
    return {
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      reason: 'Dependency readiness checks are not wired until database and queue integration.',
    };
  }
}
