import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { OverlayScenesController } from './overlay-scenes.controller.js';
import { OverlayScenesService } from './overlay-scenes.service.js';
import { OverlayRuntimeController } from './overlay-runtime.controller.js';
import { OverlayRuntimeService } from './overlay-runtime.service.js';
import { OverlayRealtimeGateway } from './overlay-realtime.gateway.js';
import { AssetsModule } from '../assets/assets.module.js';

@Module({
  imports: [DatabaseModule, IdentityModule, OutboxModule, WorkspacesModule, AssetsModule],
  controllers: [OverlayScenesController, OverlayRuntimeController],
  providers: [OverlayScenesService, OverlayRuntimeService, OverlayRealtimeGateway],
})
export class OverlayScenesModule {}
