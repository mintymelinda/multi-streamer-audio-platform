import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { RequestsModule } from './requests/requests.module.js';
import { TwitchEventSubModule } from './integrations/twitch-eventsub.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    WorkspacesModule,
    OutboxModule,
    RequestsModule,
    TwitchEventSubModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
