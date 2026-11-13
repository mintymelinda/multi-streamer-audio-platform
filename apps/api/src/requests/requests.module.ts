import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { QueueManagerModule } from '../queues/queue-manager.module.js';
import { RequestsController } from './requests.controller.js';
import { RequestsService } from './requests.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule, OutboxModule, WorkspacesModule, QueueManagerModule],
  controllers: [RequestsController],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
