import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ProviderExecutionQueueModule } from '../providers/provider-execution-queue.module.js';
import { QueueManagerService } from './queue-manager.service.js';

@Module({
  imports: [DatabaseModule, ProviderExecutionQueueModule],
  providers: [QueueManagerService],
  exports: [QueueManagerService],
})
export class QueueManagerModule {}
