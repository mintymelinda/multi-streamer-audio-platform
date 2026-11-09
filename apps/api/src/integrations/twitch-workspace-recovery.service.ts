import { randomBytes } from 'node:crypto';
import type { VerifiedWorkspaceId } from '@platform/contracts';
import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { AuthenticatedUser, WorkspaceRequestContext } from '../identity/http.types.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { TwitchEventSubService } from './twitch-eventsub.service.js';
import { TwitchIntegrationService } from './twitch-integration.service.js';
import { TwitchRewardsService } from './twitch-rewards.service.js';
import { TwitchHelixService } from './twitch-helix.service.js';
import { canResumeTwitchWorkspace } from './twitch-authorization-recovery.js';
import { hasRequiredTwitchRewardScopes } from './twitch-integration-scopes.js';

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
      throw new ForbiddenException(
        'Only the active workspace owner can recover Twitch integration.',
      );
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
    const redemptionEventType = 'channel.channel_points_custom_reward_redemption.add';
    const [localSubscriptions, remoteSubscriptions] = await Promise.all([
      this.eventSub.listWorkspaceSubscriptions(workspace.id, actor.id, redemptionEventType),
      this.helix.listEventSubSubscriptions(actor.twitchUserId),
    ]);
    const localIds = new Set(localSubscriptions.map((item) => item.subscriptionId));
    const remoteRedemptionSubscriptions = remoteSubscriptions.filter(
      (item) =>
        item.type === redemptionEventType &&
        item.condition.broadcaster_user_id === actor.twitchUserId,
    );
    const matchingRemote = remoteRedemptionSubscriptions.find((item) => localIds.has(item.id));

    if (matchingRemote?.status === 'webhook_callback_verification_pending') {
      await this.eventSub.reconcileWorkspaceSubscriptions(
        workspace.id,
        actor.id,
        actor.twitchUserId,
        remoteSubscriptions,
      );
      throw new ConflictException(
        'Twitch is verifying the EventSub callback. Retry workspace recovery after verification completes.',
      );
    }

    if (matchingRemote?.status !== 'enabled') {
      for (const remote of remoteRedemptionSubscriptions) {
        await this.helix.deleteEventSubSubscription(remote.id);
      }
      const signingSecret = randomBytes(32).toString('base64url');
      let created: Awaited<ReturnType<TwitchHelixService['createRedemptionEventSubSubscription']>>;
      try {
        created = await this.helix.createRedemptionEventSubSubscription(
          actor.twitchUserId,
          signingSecret,
        );
      } catch (error) {
        if (error instanceof ConflictException) {
          throw new ConflictException(
            'A Twitch EventSub subscription is being created concurrently. Retry recovery shortly.',
          );
        }
        throw error;
      }
      await this.eventSub.registerSubscription({
        workspaceId: workspace.id,
        actorUserId: actor.id,
        subscriptionId: created.id,
        eventType: created.type,
        version: created.version,
        condition: created.condition,
        signingSecret,
      });
      throw new ConflictException(
        'A Twitch EventSub subscription was created. Retry workspace recovery after Twitch verifies its callback.',
      );
    }

    await this.eventSub.reconcileWorkspaceSubscriptions(
      workspace.id,
      actor.id,
      actor.twitchUserId,
      remoteSubscriptions,
    );
    if (
      !canResumeTwitchWorkspace({
        authorizationValid: status.status === 'connected',
        broadcasterIdentityVerified: status.externalAccountId === actor.twitchUserId,
        requiredScopesGranted: hasRequiredTwitchRewardScopes(status.grantedScopes),
        eventSubReconciled: matchingRemote.status === 'enabled',
        rewardMappingsReconciled: activeMappingsReconciled,
      })
    ) {
      throw new ConflictException(
        'Twitch authorization, subscriptions, and reward mappings must all reconcile before recovery.',
      );
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
          [
            workspace.id,
            actor.id,
            integrationId,
            JSON.stringify({
              eventSubSubscriptionsReconciled: true,
              rewardMappingsReconciled: true,
            }),
          ],
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
