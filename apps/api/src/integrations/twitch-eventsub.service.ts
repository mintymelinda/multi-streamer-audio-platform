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

type EventSubMessageType = 'webhook_callback_verification' | 'notification' | 'revocation';

type SubscriptionRecord = {
  workspace_id: VerifiedWorkspaceId;
  subscription_id: string;
  status: 'pending_verification' | 'enabled' | 'revoked' | 'disabled';
  event_type: string;
  event_version: string;
  secret_envelope: EncryptedCredentialEnvelope;
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
        const result = await client.query(
          `INSERT INTO twitch_eventsub_subscriptions
            (subscription_id, workspace_id, event_type, event_version, condition, secret_envelope)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
           ON CONFLICT (subscription_id) DO UPDATE
             SET event_type = EXCLUDED.event_type,
                 event_version = EXCLUDED.event_version,
                 condition = EXCLUDED.condition,
                 secret_envelope = EXCLUDED.secret_envelope,
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
          ],
        );
        if (!result.rows[0]) {
          throw new BadRequestException('Twitch subscription ID is already assigned to another workspace.');
        }
      },
    );
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
    const messageType = header(headers, 'twitch-eventsub-message-type') as EventSubMessageType | undefined;
    if (!messageId || messageId.length > 256 || !messageTimestamp || !messageSignature || !messageType) {
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
          'SELECT workspace_id, subscription_id, status, event_type, event_version, secret_envelope FROM twitch_eventsub_subscriptions WHERE subscription_id = $1',
          [subscriptionId],
        );
        return result.rows[0];
      },
    );
    if (!record) throw new UnauthorizedException('Unknown Twitch EventSub subscription.');
    if (
      subscription?.type !== record.event_type ||
      subscription.version !== record.event_version
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
      await this.database.transaction(
        { twitchLookupId: subscriptionId },
        async (client) => {
          await client.query(
            "UPDATE twitch_eventsub_subscriptions SET status = 'enabled', updated_at = now() WHERE subscription_id = $1",
            [subscriptionId],
          );
        },
      );
      return { kind: 'challenge', challenge };
    }

    if (record.status !== 'enabled' && messageType !== 'revocation') {
      throw new UnauthorizedException('Twitch EventSub subscription is not enabled.');
    }

    return this.database.transaction(
      { twitchLookupId: subscriptionId },
      async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO twitch_eventsub_deliveries
            (workspace_id, subscription_id, message_id, message_type, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (message_id) DO NOTHING
           RETURNING id`,
          [record.workspace_id, subscriptionId, messageId, messageType, JSON.stringify(payload)],
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
      },
    );
  }
}
