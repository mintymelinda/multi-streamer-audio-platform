import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PlatformAdminController } from './platform-admin.controller.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { SupportAccessController } from './support-access.controller.js';
import { SupportAccessService } from './support-access.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [PlatformAdminController, SupportAccessController],
  providers: [PlatformAdminService, SupportAccessService],
})
export class PlatformAdminModule {}
