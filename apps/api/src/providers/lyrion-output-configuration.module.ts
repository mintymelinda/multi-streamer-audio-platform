import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { ProviderCredentialsModule } from './provider-credentials.module.js';
import { ProviderInstanceModule } from './provider-instance.module.js';
import { QueueManagerModule } from '../queues/queue-manager.module.js';
import { LyrionOutputConfigurationController } from './lyrion-output-configuration.controller.js';

@Module({
  imports: [DatabaseModule, IdentityModule, WorkspacesModule, ProviderCredentialsModule, ProviderInstanceModule, QueueManagerModule],
  controllers: [LyrionOutputConfigurationController],
})
export class LyrionOutputConfigurationModule {}
