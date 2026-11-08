import assert from 'node:assert/strict';
import test from 'node:test';

const REQUIRED_SCOPE = 'channel:manage:redemptions';

function hasRequiredScopes(scopes) {
  return Array.isArray(scopes) && scopes.includes(REQUIRED_SCOPE);
}

test('Twitch reward management requires the broadcaster manage scope', () => {
  assert.equal(hasRequiredScopes(['channel:manage:redemptions']), true);
  assert.equal(hasRequiredScopes(['channel:read:redemptions']), false);
  assert.equal(hasRequiredScopes(['channel:manage:redemptions', 'user:read:email']), true);
  assert.equal(hasRequiredScopes([]), false);
  assert.equal(hasRequiredScopes(undefined), false);
});
