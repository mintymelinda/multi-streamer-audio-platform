import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { RequestsModule } from '../requests/requests.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { TwitchEventSubController } from './twitch-eventsub.controller.js';
import { TwitchEventSubService } from './twitch-eventsub.service.js';
import { TwitchRedemptionRouterService } from './twitch-redemption-router.service.js';
import { EventSubRecoveryController } from './eventsub-recovery.controller.js';
import { EventSubRecoveryService } from './eventsub-recovery.service.js';

@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    OutboxModule,
    RequestsModule,
    WorkspacesModule,
  ],
  controllers: [TwitchEventSubController, EventSubRecoveryController],
  providers: [TwitchEventSubService, TwitchRedemptionRouterService, EventSubRecoveryService],
  exports: [TwitchEventSubService, EventSubRecoveryService],
})
export class TwitchEventSubModule {}
