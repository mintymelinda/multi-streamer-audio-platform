import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { PlaybackCoordinatorModule } from '../playback/playback-coordinator.module.js';
import { ProviderExecutionHandoffController } from './provider-execution-handoff.controller.js';

@Module({
  imports: [DatabaseModule, PlaybackCoordinatorModule],
  controllers: [ProviderExecutionHandoffController],
})
export class ProviderExecutionHandoffModule {}
