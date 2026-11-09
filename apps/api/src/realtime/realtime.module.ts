import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkspaceRealtimeGateway } from './workspace-realtime.gateway.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  providers: [WorkspaceRealtimeGateway],
})
export class RealtimeModule {}
