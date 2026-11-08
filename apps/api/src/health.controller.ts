import { Controller, Get } from '@nestjs/common';
import { getHealthResponse } from '@platform/contracts';

@Controller('health')
export class HealthController {
  @Get('live')
  getLiveness() {
    return getHealthResponse();
  }
}
