import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { TwitchIntegrationModule } from './twitch-integration.module.js';
import { TwitchHelixService } from './twitch-helix.service.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { TwitchRewardsController } from './twitch-rewards.controller.js';
import { TwitchRewardsService } from './twitch-rewards.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule, OutboxModule, WorkspacesModule, TwitchIntegrationModule],
  controllers: [TwitchRewardsController],
  providers: [TwitchRewardsService, TwitchHelixService],
})
export class TwitchRewardsModule {}
