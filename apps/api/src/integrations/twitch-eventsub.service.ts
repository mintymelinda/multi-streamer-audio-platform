import type { VerifiedWorkspaceId } from '@platform/contracts';
import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
  loadIntegrationKeyRing,
  type EncryptedCredentialEnvelope,
} from '../security/integration-credential-crypto.js';
import { DatabaseService } from '../database/database.service.js';
import { verifyTwitchEventSubSignature } from './twitch-eventsub-signature.js';
import type { TwitchEventSubSubscription } from './twitch-helix.service.js';
import { reconcileEventSubSubscriptions } from './twitch-eventsub-reconciliation.js';

type EventSubMessageType = 'webhook_callback_verification' | 'notification' | 'revocation';

type SubscriptionRecord = {
  workspace_id: VerifiedWorkspaceId;
  subscription_id: string;
  status: 'pending_verification' | 'enabled' | 'revoked' | 'disabled';
  event_type: string;
  event_version: string;
  secret_envelope: EncryptedCredentialEnvelope;
  service_actor_user_id: string | null;
};

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

@Injectable()
export class TwitchEventSubService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Called by the Twitch subscription-creation flow after Twitch returns its
   * subscription ID. The plaintext signing secret is never persisted.
   */
  async registerSubscription(input: {
    workspaceId: VerifiedWorkspaceId;
    actorUserId: string;
    subscriptionId: string;
    eventType: string;
    version: string;
    condition: Record<string, unknown>;
    signingSecret: string;
  }): Promise<void> {
    if (
      !input.subscriptionId ||
      input.subscriptionId.length > 128 ||
      !input.eventType ||
      input.eventType.length > 128 ||
      !input.version ||
      input.version.length > 16 ||
      input.signingSecret.length < 10 ||
      input.signingSecret.length > 100
    ) {
      throw new BadRequestException('Twitch EventSub subscription details are invalid.');
    }

    const envelope = encryptIntegrationCredentials(
      input.signingSecret,
      {
        workspaceId: input.workspaceId,
        provider: 'twitch-eventsub',
        credentialId: input.subscriptionId,
      },
      loadIntegrationKeyRing(),
    );

    await this.database.transaction(
      { userId: input.actorUserId, verifiedWorkspaceId: input.workspaceId },
      async (client) => {
        const owner = await client.query<{ owner_user_id: string }>(
          'SELECT owner_user_id FROM workspaces WHERE id = $1',
          [input.workspaceId],
        );
        const serviceActorUserId = owner.rows[0]?.owner_user_id;
        if (!serviceActorUserId) {
          throw new BadRequestException('The workspace owner is unavailable for EventSub routing.');
        }
        const result = await client.query(
          `INSERT INTO twitch_eventsub_subscriptions
            (subscription_id, workspace_id, event_type, event_version, condition, secret_envelope, service_actor_user_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
           ON CONFLICT (subscription_id) DO UPDATE
             SET event_type = EXCLUDED.event_type,
                 event_version = EXCLUDED.event_version,
                 condition = EXCLUDED.condition,
                 secret_envelope = EXCLUDED.secret_envelope,
                 service_actor_user_id = EXCLUDED.service_actor_user_id,
                 status = 'pending_verification',
                 revoked_reason = NULL,
                 updated_at = now()
             WHERE twitch_eventsub_subscriptions.workspace_id = EXCLUDED.workspace_id
           RETURNING subscription_id`,
          [
            input.subscriptionId,
            input.workspaceId,
            input.eventType,
            input.version,
            JSON.stringify(input.condition),
            JSON.stringify(envelope),
            serviceActorUserId,
          ],
        );
        if (!result.rows[0]) {
          throw new BadRequestException(
            'Twitch subscription ID is already assigned to another workspace.',
          );
        }
      },
    );
  }

  async listWorkspaceSubscriptions(
    workspaceId: VerifiedWorkspaceId,
    actorUserId: string,
    eventType: string,
  ): Promise<Array<{ subscriptionId: string; status: string }>> {
    const result = await this.database.transaction(
      { userId: actorUserId, verifiedWorkspaceId: workspaceId },
      (client) =>
        client.query<{ subscription_id: string; status: string }>(
          `SELECT subscription_id, status
             FROM twitch_eventsub_subscriptions
            WHERE workspace_id = $1 AND event_type = $2
            ORDER BY created_at ASC, subscription_id ASC`,
          [workspaceId, eventType],
        ),
    );
    return result.rows.map((row) => ({
      subscriptionId: row.subscription_id,
      status: row.status,
    }));
  }

  async reconcileWorkspaceSubscriptions(
    workspaceId: VerifiedWorkspaceId,
    actorUserId: string,
    broadcasterUserId: string,
    remoteSubscriptions: TwitchEventSubSubscription[],
  ): Promise<{ total: number; enabled: number; enabledSubscriptionIds: string[] }> {
    return this.database.transaction(
      { userId: actorUserId, verifiedWorkspaceId: workspaceId },
      async (client) => {
        const local = await client.query<{
          subscription_id: string;
          event_type: string;
          event_version: string;
        }>(
          `SELECT subscription_id, event_type, event_version
             FROM twitch_eventsub_subscriptions
            WHERE workspace_id = $1 FOR UPDATE`,
          [workspaceId],
        );
        const plan = reconcileEventSubSubscriptions(
          local.rows.map((subscription) => ({
            subscriptionId: subscription.subscription_id,
            eventType: subscription.event_type,
            eventVersion: subscription.event_version,
          })),
          remoteSubscriptions,
          broadcasterUserId,
        );
        for (const item of plan) {
          await client.query(
            `UPDATE twitch_eventsub_subscriptions
                SET status = $3, revoked_reason = $4, updated_at = now()
              WHERE workspace_id = $1 AND subscription_id = $2`,
            [workspaceId, item.subscriptionId, item.status, item.reason],
          );
        }
        const enabledSubscriptionIds = plan
          .filter((item) => item.status === 'enabled')
          .map((item) => item.subscriptionId);
        return {
          total: local.rows.length,
          enabled: enabledSubscriptionIds.length,
          enabledSubscriptionIds,
        };
      },
    );
  }

  async hasEnabledSubscriptions(
    workspaceId: VerifiedWorkspaceId,
    actorUserId: string,
  ): Promise<boolean> {
    const result = await this.database.transaction(
      { userId: actorUserId, verifiedWorkspaceId: workspaceId },
      (client) =>
        client.query<{ enabled_count: string }>(
          "SELECT count(*)::text AS enabled_count FROM twitch_eventsub_subscriptions WHERE workspace_id = $1 AND status = 'enabled'",
          [workspaceId],
        ),
    );
    return Number(result.rows[0]?.enabled_count ?? 0) > 0;
  }

  async receive(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<{ kind: 'challenge'; challenge: string } | { kind: 'accepted'; duplicate: boolean }> {
    if (rawBody.length === 0 || rawBody.length > 1024 * 1024) {
      throw new BadRequestException('Twitch EventSub body size is invalid.');
    }
    const messageId = header(headers, 'twitch-eventsub-message-id');
    const messageTimestamp = header(headers, 'twitch-eventsub-message-timestamp');
    const messageSignature = header(headers, 'twitch-eventsub-message-signature');
    const messageType = header(headers, 'twitch-eventsub-message-type') as
      | EventSubMessageType
      | undefined;
    if (
      !messageId ||
      messageId.length > 256 ||
      !messageTimestamp ||
      !messageSignature ||
      !messageType
    ) {
      throw new BadRequestException('Required Twitch EventSub headers are missing.');
    }
    if (
      messageType !== 'webhook_callback_verification' &&
      messageType !== 'notification' &&
      messageType !== 'revocation'
    ) {
      throw new BadRequestException('Unsupported Twitch EventSub message type.');
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = object(JSON.parse(rawBody.toString('utf8')));
      if (!parsed) throw new Error('EventSub payload must be an object.');
      payload = parsed;
    } catch {
      throw new BadRequestException('Twitch EventSub payload is not valid JSON.');
    }

    const subscription = object(payload.subscription);
    const subscriptionId = subscription?.id;
    if (typeof subscriptionId !== 'string' || subscriptionId.length > 128) {
      throw new BadRequestException('Twitch EventSub subscription ID is missing.');
    }

    const record = await this.database.transaction(
      { twitchLookupId: subscriptionId },
      async (client) => {
        const result = await client.query<SubscriptionRecord>(
          'SELECT workspace_id, subscription_id, status, event_type, event_version, secret_envelope, service_actor_user_id FROM twitch_eventsub_subscriptions WHERE subscription_id = $1',
          [subscriptionId],
        );
        return result.rows[0];
      },
    );
    if (!record) throw new UnauthorizedException('Unknown Twitch EventSub subscription.');
    if (
      subscription?.type !== record.event_type ||
      subscription?.version !== record.event_version
    ) {
      throw new UnauthorizedException('Twitch EventSub subscription metadata does not match.');
    }

    let signingSecret: string;
    try {
      signingSecret = decryptIntegrationCredentials(
        record.secret_envelope,
        {
          workspaceId: record.workspace_id,
          provider: 'twitch-eventsub',
          credentialId: record.subscription_id,
        },
        loadIntegrationKeyRing(),
      );
    } catch {
      throw new UnauthorizedException('Twitch EventSub signature verification is unavailable.');
    }

    const valid = verifyTwitchEventSubSignature(
      { messageId, messageTimestamp, messageSignature },
      rawBody,
      signingSecret,
    );
    if (!valid) throw new UnauthorizedException('Twitch EventSub signature is invalid.');

    if (messageType === 'webhook_callback_verification') {
      const challenge = payload.challenge;
      if (typeof challenge !== 'string' || challenge.length > 2048) {
        throw new BadRequestException('Twitch EventSub challenge is invalid.');
      }
      await this.database.transaction({ twitchLookupId: subscriptionId }, async (client) => {
        await client.query(
          "UPDATE twitch_eventsub_subscriptions SET status = 'enabled', revoked_reason = NULL, updated_at = now() WHERE subscription_id = $1",
          [subscriptionId],
        );
      });
      return { kind: 'challenge', challenge };
    }

    if (record.status !== 'enabled' && messageType !== 'revocation') {
      throw new UnauthorizedException('Twitch EventSub subscription is not enabled.');
    }

    return this.database.transaction({ twitchLookupId: subscriptionId }, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO twitch_eventsub_deliveries
          (workspace_id, subscription_id, message_id, message_type, payload, service_actor_user_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (message_id) DO NOTHING
         RETURNING id`,
        [
          record.workspace_id,
          subscriptionId,
          messageId,
          messageType,
          JSON.stringify(payload),
          record.service_actor_user_id,
        ],
      );
      const duplicate = inserted.rows.length === 0;
      if (messageType === 'revocation' && !duplicate) {
        const reason = typeof subscription.status === 'string' ? subscription.status : 'revoked';
        await client.query(
          "UPDATE twitch_eventsub_subscriptions SET status = 'revoked', revoked_reason = $2, updated_at = now() WHERE subscription_id = $1",
          [subscriptionId, reason],
        );
      }
      return { kind: 'accepted', duplicate };
    });
  }
}
