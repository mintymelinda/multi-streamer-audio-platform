import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { RequestsModule } from './requests/requests.module.js';
import { TwitchEventSubModule } from './integrations/twitch-eventsub.module.js';
import { TwitchRewardsModule } from './integrations/twitch-rewards.module.js';
import { TwitchIntegrationModule } from './integrations/twitch-integration.module.js';
import { TwitchWorkspaceRecoveryModule } from './integrations/twitch-workspace-recovery.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { OutboxRecoveryModule } from './outbox/outbox-recovery.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { ProviderInstanceModule } from './providers/provider-instance.module.js';
import { ProviderCredentialsModule } from './providers/provider-credentials.module.js';
import { ProviderOutputAssignmentModule } from './providers/provider-output-assignment.module.js';
import { PlaybackCoordinatorModule } from './playback/playback-coordinator.module.js';
import { ProviderExecutionQueueModule } from './providers/provider-execution-queue.module.js';
import { SpotifyConnectOAuthModule } from './providers/spotify-connect-oauth.module.js';
import { RightsComplianceModule } from './compliance/rights-compliance.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { AccountExportsModule } from './account-exports/account-exports.module.js';

@Module({
  imports: [
    DatabaseModule, IdentityModule, WorkspacesModule, NotificationsModule, AccountExportsModule, ProviderInstanceModule, ProviderCredentialsModule,
    ProviderOutputAssignmentModule, PlaybackCoordinatorModule, ProviderExecutionQueueModule,
    SpotifyConnectOAuthModule, RightsComplianceModule, OutboxModule, RequestsModule, TwitchEventSubModule,
    TwitchRewardsModule, TwitchIntegrationModule, TwitchWorkspaceRecoveryModule, RealtimeModule, OutboxRecoveryModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
