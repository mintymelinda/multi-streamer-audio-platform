import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { TwitchEventSubController } from './twitch-eventsub.controller.js';
import { TwitchEventSubService } from './twitch-eventsub.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [TwitchEventSubController],
  providers: [TwitchEventSubService],
  exports: [TwitchEventSubService],
})
export class TwitchEventSubModule {}
