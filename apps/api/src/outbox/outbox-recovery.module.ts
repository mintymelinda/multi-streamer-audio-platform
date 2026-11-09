import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { OutboxModule } from './outbox.module.js';
import { OutboxRecoveryController } from './outbox-recovery.controller.js';
import { OutboxRecoveryService } from './outbox-recovery.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule, WorkspacesModule, OutboxModule],
  controllers: [OutboxRecoveryController],
  providers: [OutboxRecoveryService],
})
export class OutboxRecoveryModule {}
