import { Controller, Get, Inject } from '@nestjs/common';
import { ServiceStatusService } from './service-status.service.js';

@Controller('status')
export class ServiceStatusController {
  constructor(@Inject(ServiceStatusService) private readonly serviceStatus: ServiceStatusService) {}

  @Get()
  publicStatus() {
    return this.serviceStatus.publicStatus();
  }
}
