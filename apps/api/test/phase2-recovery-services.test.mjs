import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import {
  TwitchWorkspaceRecoveryService,
} from '../src/integrations/twitch-workspace-recovery.service.ts';
import { EventSubRecoveryService } from '../src/integrations/eventsub-recovery.service.ts';
import { OutboxRecoveryService } from '../src/outbox/outbox-recovery.service.ts';

const workspace = { id: 'workspace-a', role: 'owner', status: 'active' };
const actor = { id: 'user-a', twitchUserId: 'broadcaster-a' };
const deliveryId = '11111111-1111-4111-8111-111111111111';
const outboxId = '22222222-2222-4222-8222-222222222222';

function databaseFor(queryHandler) {
  return {
    transaction: async (_context, operation) => operation({
      query: queryHandler,
    }),
  };
}

test(
  'Twitch recovery resumes only after live authorization, reward, and EventSub reconciliation',
  async () => {
  const calls = [];
  const database = databaseFor(async (sql) => {
    calls.push(sql);
    if (sql.includes('UPDATE workspace_integrations')) {
      return { rows: [{ id: 'integration-a' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const integration = {
    getStatus: async () => ({
      status: 'connected',
      recoveryState: 'pending_reconciliation',
      externalAccountId: actor.twitchUserId,
      grantedScopes: ['channel:manage:redemptions'],
    }),
    getAccessToken: async () => 'token',
  };
  const eventSub = {
    listWorkspaceSubscriptions: async () => [
      { subscriptionId: 'sub-a', status: 'enabled' },
    ],
    reconcileWorkspaceSubscriptions: async () => ({ total: 1, enabled: 1 }),
  };
  const rewards = {
    listRemoteRewards: async () => [],
    listMappings: async () => [{ enabled: true, sync_state: 'synced' }],
  };
  const helix = {
    listEventSubSubscriptions: async () => [{
      id: 'sub-a',
      status: 'enabled',
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: actor.twitchUserId },
    }],
  };
  const outbox = { append: async () => 'outbox-event-a' };
  const service = new TwitchWorkspaceRecoveryService(
    database,
    integration,
    eventSub,
    rewards,
    helix,
    outbox,
  );

  const result = await service.recover(workspace, actor);
  assert.deepEqual(result, { status: 'connected', recoveryState: 'ready' });
    assert.equal(calls.some((sql) => sql.includes('UPDATE workspace_integrations')), true);
  },
);

test(
  'Twitch recovery provisions a missing redemption subscription and waits for callback verification',
  async () => {
    let registered = false;
    let resumed = false;
    const database = databaseFor(async (sql) => {
      if (sql.includes('UPDATE workspace_integrations')) resumed = true;
      return { rows: [{ id: 'integration-a' }], rowCount: 1 };
    });
    const service = new TwitchWorkspaceRecoveryService(
      database,
      {
        getStatus: async () => ({
          status: 'connected',
          recoveryState: 'pending_reconciliation',
          externalAccountId: actor.twitchUserId,
          grantedScopes: ['channel:manage:redemptions'],
        }),
        getAccessToken: async () => 'token',
      },
      {
        listWorkspaceSubscriptions: async () => [],
        reconcileWorkspaceSubscriptions: async () => ({ total: 0, enabled: 0 }),
        registerSubscription: async () => {
          registered = true;
        },
      },
      {
        listRemoteRewards: async () => [],
        listMappings: async () => [],
      },
      {
        listEventSubSubscriptions: async () => [],
        createRedemptionEventSubSubscription: async () => ({
          id: 'sub-new',
          status: 'webhook_callback_verification_pending',
          type: 'channel.channel_points_custom_reward_redemption.add',
          version: '1',
          condition: { broadcaster_user_id: actor.twitchUserId },
        }),
      },
      { append: async () => 'outbox-event-a' },
    );

    await assert.rejects(service.recover(workspace, actor), ConflictException);
    assert.equal(registered, true);
    assert.equal(resumed, false);
  },
);

test('EventSub retry records the actor, reason, and transactional outbox event', async () => {
  const statements = [];
  const database = databaseFor(async (sql) => {
    statements.push(sql);
    if (sql.includes('SELECT id, message_id')) {
      return {
        rows: [{
          id: deliveryId,
          message_id: 'message-a',
          message_type: 'notification',
          status: 'failed',
          attempts: 8,
          last_error: 'eventsub_processing_exhausted',
          received_at: new Date(),
        }],
      };
    }
    if (sql.includes('UPDATE twitch_eventsub_deliveries')) return { rowCount: 1, rows: [] };
    return { rowCount: 1, rows: [] };
  });
  const appended = [];
  const service = new EventSubRecoveryService(database, {
    append: async (_client, event) => appended.push(event),
  });

  const result = await service.retry(
    workspace,
    actor,
    deliveryId,
    'Verified webhook payload after retry review',
  );
  assert.deepEqual(result, { deliveryId, status: 'accepted' });
  assert.equal(statements.some((sql) => sql.includes('INSERT INTO audit_events')), true);
  assert.equal(appended[0]?.eventType, 'twitch.eventsub.delivery.retry');
  assert.equal(appended[0]?.payload.reason, 'Verified webhook payload after retry review');
});

test('Outbox dismissal is durable and cannot be repeated for a non-failed event', async () => {
  let failed = true;
  const database = databaseFor(async (sql) => {
    if (sql.includes('SELECT id, event_type')) {
      return {
        rows: failed
          ? [{
              id: outboxId,
              event_type: 'request.created',
              aggregate_type: 'media_request',
              aggregate_id: 'request-a',
              attempt_count: 8,
              last_error_code: 'outbox_dispatch_exhausted',
              occurred_at: new Date(),
            }]
          : [],
      };
    }
    if (sql.includes('UPDATE outbox_events')) {
      failed = false;
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  });
  const appended = [];
  const service = new OutboxRecoveryService(database, {
    append: async (_client, event) => appended.push(event),
  });

  assert.deepEqual(
    await service.dismiss(workspace, actor, outboxId, 'Reviewed and intentionally discarded'),
    { eventId: outboxId, status: 'dismissed' },
  );
  assert.equal(appended[0]?.eventType, 'outbox.delivery.dismiss');
  await assert.rejects(
    service.dismiss(workspace, actor, outboxId, 'Reviewed and intentionally discarded'),
    ConflictException,
  );
  assert.equal(appended.length, 1);
});
