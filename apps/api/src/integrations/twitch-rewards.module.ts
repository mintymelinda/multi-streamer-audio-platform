import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { TwitchRewardsController } from './twitch-rewards.controller.js';
import { TwitchRewardsService } from './twitch-rewards.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule, OutboxModule, WorkspacesModule],
  controllers: [TwitchRewardsController],
  providers: [TwitchRewardsService],
})
export class TwitchRewardsModule {}
