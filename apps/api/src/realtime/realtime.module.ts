import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkspaceRealtimeGateway } from './workspace-realtime.gateway.js';
import { RealtimeSnapshotController } from './realtime-snapshot.controller.js';
import { RequestsModule } from '../requests/requests.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';

@Module({
  imports: [DatabaseModule, IdentityModule, RequestsModule, WorkspacesModule],
  controllers: [RealtimeSnapshotController],
  providers: [WorkspaceRealtimeGateway],
})
export class RealtimeModule {}
