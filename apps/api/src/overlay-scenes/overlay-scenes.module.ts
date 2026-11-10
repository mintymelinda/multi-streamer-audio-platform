import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { OverlayScenesController } from './overlay-scenes.controller.js';
import { OverlayScenesService } from './overlay-scenes.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule, WorkspacesModule],
  controllers: [OverlayScenesController],
  providers: [OverlayScenesService],
})
export class OverlayScenesModule {}
