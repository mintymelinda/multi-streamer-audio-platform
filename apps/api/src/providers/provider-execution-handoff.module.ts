import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { PlaybackCoordinatorModule } from '../playback/playback-coordinator.module.js';
import { QueueManagerModule } from '../queues/queue-manager.module.js';
import { ProviderExecutionHandoffController } from './provider-execution-handoff.controller.js';
import { ProviderPlaybackMonitorController } from './provider-playback-monitor.controller.js';

@Module({
  imports: [DatabaseModule, PlaybackCoordinatorModule, QueueManagerModule],
  controllers: [ProviderExecutionHandoffController, ProviderPlaybackMonitorController],
})
export class ProviderExecutionHandoffModule {}
