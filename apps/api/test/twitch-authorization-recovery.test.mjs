import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTwitchAuthorizationFailure,
  canResumeTwitchWorkspace,
  shouldPauseTwitchWorkspace,
} from '../src/integrations/twitch-authorization-recovery.ts';

test('classifies definitive credential rejection as reauthorization-required', () => {
  assert.equal(
    classifyTwitchAuthorizationFailure({ status: 401, code: 'invalid_grant' }),
    'reauth_required',
  );
  assert.equal(
    classifyTwitchAuthorizationFailure({ status: 403, code: 'missing_scope' }),
    'reauth_required',
  );
});

test('does not convert transient provider failures into authorization loss', () => {
  for (const error of [
    { status: 429, code: 'rate_limited' },
    { status: 500, code: 'provider_error' },
    { status: 503, code: 'unavailable' },
    { code: 'network_timeout' },
  ]) {
    assert.equal(classifyTwitchAuthorizationFailure(error), 'temporarily_unavailable');
  }
});

test('pauses only on definitive authorization loss and only once per state transition', () => {
  assert.equal(shouldPauseTwitchWorkspace({ currentStatus: 'connected', failure: 'reauth_required' }), true);
  assert.equal(shouldPauseTwitchWorkspace({ currentStatus: 'reauth_required', failure: 'reauth_required' }), false);
  assert.equal(shouldPauseTwitchWorkspace({ currentStatus: 'connected', failure: 'temporarily_unavailable' }), false);
  assert.equal(shouldPauseTwitchWorkspace({ currentStatus: 'disconnected', failure: 'reauth_required' }), false);
});

test('recovery is blocked until authorization, broadcaster identity, scopes, subscriptions, and rewards reconcile', () => {
  const complete = {
    authorizationValid: true,
    broadcasterIdentityVerified: true,
    requiredScopesGranted: true,
    eventSubReconciled: true,
    rewardMappingsReconciled: true,
  };
  assert.equal(canResumeTwitchWorkspace(complete), true);
  for (const key of Object.keys(complete)) {
    assert.equal(canResumeTwitchWorkspace({ ...complete, [key]: false }), false, key);
  }
});

test('recovery cannot be triggered by a transient outage or a token refresh without reconciliation', () => {
  assert.equal(canResumeTwitchWorkspace({ authorizationValid: true }), false);
  assert.equal(canResumeTwitchWorkspace({ authorizationValid: false, eventSubReconciled: true }), false);
});
