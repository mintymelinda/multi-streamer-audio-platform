import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTwitchRedemptionRequest } from '../src/integrations/twitch-redemption-routing.ts';

const redemption = {
  id: 'redemption-123',
  user_id: '123456',
  user_name: 'viewer',
  user_input: 'https://example.com/watch?v=abc',
  reward: { id: 'reward-123', title: 'Untrusted display title' },
};

test('routes URL input for url_or_search and preserves Twitch requester identity', () => {
  const result = buildTwitchRedemptionRequest(
    redemption,
    'url_or_search',
    'redemption-123',
    'mapping-123',
    'reward-123',
  );
  assert.deepEqual(result, {
    title: 'https://example.com/watch?v=abc',
    mediaUrl: 'https://example.com/watch?v=abc',
    requesterTwitchUserId: '123456',
    requesterDisplayName: 'viewer',
    sourceEventId: 'redemption-123',
    metadata: {
      source: 'twitch_eventsub',
      rewardId: 'reward-123',
      mappingId: 'mapping-123',
    },
  });
});

test('url_only rejects non-URL input', () => {
  assert.equal(
    buildTwitchRedemptionRequest(
      { ...redemption, user_input: 'please play something' },
      'url_only',
      'redemption-123',
      'mapping-123',
      'reward-123',
    ),
    null,
  );
});

test('text_only never interprets input as a media URL', () => {
  const result = buildTwitchRedemptionRequest(
    redemption,
    'text_only',
    'redemption-123',
    'mapping-123',
    'reward-123',
  );
  assert.equal(result?.title, redemption.user_input);
  assert.equal(result?.mediaUrl, undefined);
});

test('rejects empty and oversized redemption input', () => {
  for (const user_input of ['', ' '.repeat(3), 'x'.repeat(501)]) {
    assert.equal(
      buildTwitchRedemptionRequest(
        { ...redemption, user_input },
        'url_or_search',
        'redemption-123',
        'mapping-123',
        'reward-123',
      ),
      null,
    );
  }
});

test('does not trust or use the reward display title as request input', () => {
  const result = buildTwitchRedemptionRequest(
    { ...redemption, user_input: 'song to find' },
    'url_or_search',
    'redemption-123',
    'mapping-123',
    'reward-123',
  );
  assert.equal(result?.title, 'song to find');
  assert.notEqual(result?.title, redemption.reward.title);
});
