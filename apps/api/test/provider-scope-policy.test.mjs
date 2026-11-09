import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderScopePolicyService } from '../dist/providers/provider-scope-policy.service.js';

test('requests only the scopes required by enabled provider features', async () => {
  const service = new ProviderScopePolicyService({
    requiredScopes: {
      spotify: {
        playback: ['user-read-playback-state', 'user-modify-playback-state'],
        profile: ['user-read-private'],
      },
    },
  });
  assert.deepEqual(
    service.getRequestedScopes({ providerId: 'spotify', features: ['playback'] }),
    ['user-read-playback-state', 'user-modify-playback-state'],
  );
});

test('does not request optional scopes when the corresponding feature is disabled', async () => {
  const service = new ProviderScopePolicyService({
    requiredScopes: {
      spotify: {
        playback: ['user-read-playback-state'],
        profile: ['user-read-private'],
      },
    },
  });
  assert.deepEqual(
    service.getRequestedScopes({ providerId: 'spotify', features: [] }),
    [],
  );
});

test('rejects unrecognized, excessive, or silently broadened granted scopes', async () => {
  const service = new ProviderScopePolicyService({
    requiredScopes: { spotify: { playback: ['user-read-playback-state'] } },
  });
  assert.equal(service.validateGrantedScopes({
    providerId: 'spotify', requestedScopes: ['user-read-playback-state'],
    grantedScopes: ['user-read-playback-state'],
  }).valid, true);
  assert.equal(service.validateGrantedScopes({
    providerId: 'spotify', requestedScopes: ['user-read-playback-state'],
    grantedScopes: ['user-read-playback-state', 'user-modify-playback-state'],
  }).valid, false);
  assert.equal(service.validateGrantedScopes({
    providerId: 'spotify', requestedScopes: ['user-read-playback-state'],
    grantedScopes: ['unknown-admin-scope'],
  }).valid, false);
});

test('authorization expiry pauses provider execution and requires reconnect/reconciliation', async () => {
  const service = new ProviderScopePolicyService();
  const state = service.onAuthorizationExpired({ providerInstanceId: 'spotify-a' });
  assert.equal(state.connectionHealth, 'authorization_expired');
  assert.equal(state.executionAllowed, false);
  assert.equal(state.reconnectRequired, true);
});
