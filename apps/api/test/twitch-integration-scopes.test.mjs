import assert from 'node:assert/strict';
import test from 'node:test';
import { hasRequiredTwitchRewardScopes } from '../src/integrations/twitch-integration-scopes.ts';

test('Twitch reward management requires the broadcaster manage scope', () => {
  assert.equal(hasRequiredTwitchRewardScopes(['channel:manage:redemptions']), true);
  assert.equal(hasRequiredTwitchRewardScopes(['channel:read:redemptions']), false);
  assert.equal(
    hasRequiredTwitchRewardScopes(['channel:manage:redemptions', 'user:read:email']),
    true,
  );
  assert.equal(hasRequiredTwitchRewardScopes([]), false);
  assert.equal(hasRequiredTwitchRewardScopes(undefined), false);
  assert.equal(hasRequiredTwitchRewardScopes('channel:manage:redemptions'), false);
});
