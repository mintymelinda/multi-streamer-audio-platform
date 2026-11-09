import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileEventSubSubscriptions,
} from '../src/integrations/twitch-eventsub-reconciliation.ts';

const local = [
  {
    subscriptionId: 'sub-enabled',
    eventType: 'channel.channel_points_custom_reward_redemption.add',
    eventVersion: '1',
  },
  { subscriptionId: 'sub-missing', eventType: 'channel.update', eventVersion: '1' },
  { subscriptionId: 'sub-disabled', eventType: 'channel.update', eventVersion: '1' },
  { subscriptionId: 'sub-mismatch', eventType: 'channel.update', eventVersion: '1' },
];

test('reconciles only remote enabled subscriptions with matching identity and metadata', () => {
  const result = reconcileEventSubSubscriptions(
    local,
    [
      {
        id: 'sub-enabled',
        status: 'enabled',
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: { broadcaster_user_id: 'broadcaster-1' },
      },
      {
        id: 'sub-disabled',
        status: 'webhook_callback_verification_pending',
        type: 'channel.update',
        version: '1',
        condition: { broadcaster_user_id: 'broadcaster-1' },
      },
      {
        id: 'sub-mismatch',
        status: 'enabled',
        type: 'channel.update',
        version: '1',
        condition: { broadcaster_user_id: 'broadcaster-2' },
      },
    ],
    'broadcaster-1',
  );

  assert.deepEqual(result, [
    { subscriptionId: 'sub-enabled', status: 'enabled', reason: null },
    { subscriptionId: 'sub-missing', status: 'revoked', reason: 'missing_on_twitch' },
    { subscriptionId: 'sub-disabled', status: 'disabled', reason: 'not_enabled_on_twitch' },
    {
      subscriptionId: 'sub-mismatch',
      status: 'disabled',
      reason: 'subscription_metadata_mismatch',
    },
  ]);
});

test('does not treat metadata mismatch or remote absence as a valid recovery subscription', () => {
  const result = reconcileEventSubSubscriptions(
    [{ subscriptionId: 'sub-1', eventType: 'channel.update', eventVersion: '1' }],
    [{
      id: 'sub-1',
      status: 'enabled',
      type: 'channel.update',
      version: '2',
      condition: {},
    }],
    'broadcaster-1',
  );
  assert.equal(result[0]?.status, 'disabled');
  assert.equal(result[0]?.reason, 'subscription_metadata_mismatch');
});
