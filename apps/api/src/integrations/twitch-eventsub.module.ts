import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { RequestsModule } from '../requests/requests.module.js';
import { TwitchEventSubController } from './twitch-eventsub.controller.js';
import { TwitchEventSubService } from './twitch-eventsub.service.js';
import { TwitchRedemptionRouterService } from './twitch-redemption-router.service.js';

@Module({
  imports: [DatabaseModule, RequestsModule],
  controllers: [TwitchEventSubController],
  providers: [TwitchEventSubService, TwitchRedemptionRouterService],
  exports: [TwitchEventSubService],
})
export class TwitchEventSubModule {}
