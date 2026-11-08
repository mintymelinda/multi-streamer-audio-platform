import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { TwitchIntegrationController } from './twitch-integration.controller.js';
import { TwitchIntegrationService } from './twitch-integration.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule, OutboxModule, WorkspacesModule],
  controllers: [TwitchIntegrationController],
  providers: [TwitchIntegrationService],
  exports: [TwitchIntegrationService],
})
export class TwitchIntegrationModule {}
