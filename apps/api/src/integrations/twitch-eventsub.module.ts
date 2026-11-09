import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { RequestsModule } from '../requests/requests.module.js';
import { TwitchEventSubController } from './twitch-eventsub.controller.js';
import { TwitchEventSubService } from './twitch-eventsub.service.js';
import { TwitchRedemptionRouterService } from './twitch-redemption-router.service.js';
import { EventSubRecoveryController } from './eventsub-recovery.controller.js';
import { EventSubRecoveryService } from './eventsub-recovery.service.js';

@Module({
  imports: [DatabaseModule, RequestsModule],
  controllers: [TwitchEventSubController, EventSubRecoveryController],
  providers: [TwitchEventSubService, TwitchRedemptionRouterService, EventSubRecoveryService],
  exports: [TwitchEventSubService, EventSubRecoveryService],
  exports: [TwitchEventSubService],
})
export class TwitchEventSubModule {}
