import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PlannedMaintenanceController } from './planned-maintenance.controller.js';
import { PlannedMaintenanceService } from './planned-maintenance.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [PlannedMaintenanceController],
  providers: [PlannedMaintenanceService],
})
export class PlannedMaintenanceModule {}
