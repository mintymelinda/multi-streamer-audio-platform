import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { TwitchEventSubModule } from './twitch-eventsub.module.js';
import { TwitchIntegrationModule } from './twitch-integration.module.js';
import { TwitchRewardsModule } from './twitch-rewards.module.js';
import { TwitchWorkspaceRecoveryController } from './twitch-workspace-recovery.controller.js';
import { TwitchWorkspaceRecoveryService } from './twitch-workspace-recovery.service.js';

@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    OutboxModule,
    WorkspacesModule,
    TwitchIntegrationModule,
    TwitchEventSubModule,
    TwitchRewardsModule,
  ],
  controllers: [TwitchWorkspaceRecoveryController],
  providers: [TwitchWorkspaceRecoveryService],
})
export class TwitchWorkspaceRecoveryModule {}
