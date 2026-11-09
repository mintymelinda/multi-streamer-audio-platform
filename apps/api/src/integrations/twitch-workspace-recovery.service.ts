import type { VerifiedWorkspaceId } from '@platform/contracts';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { AuthenticatedUser, WorkspaceRequestContext } from '../identity/http.types.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { TwitchEventSubService } from './twitch-eventsub.service.js';
import { TwitchIntegrationService } from './twitch-integration.service.js';
import { TwitchRewardsService } from './twitch-rewards.service.js';
import { TwitchHelixService } from './twitch-helix.service.js';

@Injectable()
export class TwitchWorkspaceRecoveryService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TwitchIntegrationService) private readonly integration: TwitchIntegrationService,
    @Inject(TwitchEventSubService) private readonly eventSub: TwitchEventSubService,
    @Inject(TwitchRewardsService) private readonly rewards: TwitchRewardsService,
    @Inject(TwitchHelixService) private readonly helix: TwitchHelixService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async recover(workspace: WorkspaceRequestContext, actor: AuthenticatedUser) {
    if (workspace.role !== 'owner' || workspace.status !== 'active') {
      throw new ForbiddenException('Only the active workspace owner can recover Twitch integration.');
    }

    const status = await this.integration.getStatus(workspace, actor);
    if (
      status.status !== 'connected' ||
      status.externalAccountId !== actor.twitchUserId ||
      status.recoveryState !== 'pending_reconciliation'
    ) {
      throw new ConflictException('Reconnect the workspace broadcaster before starting recovery.');
    }

    await this.integration.getAccessToken(workspace, actor);
    await this.rewards.listRemoteRewards(workspace, actor);
    const mappings = await this.rewards.listMappings(workspace, actor);
    const activeMappingsReconciled = mappings.every(
      (mapping) => !mapping.enabled || mapping.sync_state === 'synced',
    );
    if (!activeMappingsReconciled) {
      throw new ConflictException('Twitch reward mappings still require attention.');
    }

    const remoteSubscriptions = await this.helix.listEventSubSubscriptions(actor.twitchUserId);
    const subscriptions = await this.eventSub.reconcileWorkspaceSubscriptions(
      workspace.id,
      actor.id,
      actor.twitchUserId,
      remoteSubscriptions,
    );
    if (subscriptions.total === 0 || subscriptions.enabled !== subscriptions.total) {
      throw new ConflictException('All configured Twitch EventSub subscriptions must be enabled before recovery.');
    }

    return this.database.transaction(
      { userId: actor.id, verifiedWorkspaceId: workspace.id },
      async (client) => {
        const updated = await client.query<{ id: string }>(
          `UPDATE workspace_integrations
              SET recovery_state = 'ready', paused_at = NULL, pause_reason = NULL,
                  last_error_code = NULL, updated_at = now()
            WHERE workspace_id = $1 AND provider = 'twitch'
              AND status = 'connected' AND external_account_id = $2
              AND recovery_state = 'pending_reconciliation'
            RETURNING id`,
          [workspace.id, actor.twitchUserId],
        );
        const integrationId = updated.rows[0]?.id;
        if (!integrationId) {
          throw new ConflictException('Twitch recovery state changed; reload and retry.');
        }
        await client.query(
          `INSERT INTO audit_events
            (workspace_id, actor_user_id, event_type, target_type, target_id, details)
           VALUES ($1,$2,'twitch.integration.recovered','workspace_integration',$3,$4::jsonb)`,
          [workspace.id, actor.id, integrationId, JSON.stringify({
            eventSubSubscriptionsReconciled: true,
            rewardMappingsReconciled: true,
          })],
        );
        await this.outbox.append(client, {
          workspaceId: workspace.id as VerifiedWorkspaceId,
          eventType: 'twitch.integration.recovered',
          aggregateType: 'workspace_integration',
          aggregateId: integrationId,
          idempotencyKey: `twitch.integration.recovered:${integrationId}`,
          payload: { eventSubSubscriptionsReconciled: true, rewardMappingsReconciled: true },
        });
        return { status: 'connected', recoveryState: 'ready' };
      },
    );
  }
}
