import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderCredentialsService } from '../dist/providers/provider-credentials.service.js';

function createService() {
  const state = new Map();
  const audit = [];
  const ledgerWrites = [];
  const db = {
    transaction: async (_context, operation) =>
      operation({
        query: async (sql, values = []) => {
          if (sql.includes('INSERT INTO provider_credentials')) {
            state.set(values[0], {
              workspaceId: values[1],
              providerInstanceId: values[2],
              ciphertext: values[3],
              nonce: values[4],
              authTag: values[5],
            });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('SELECT') && sql.includes('provider_credentials')) {
            const value = state.get(values[0]);
            return { rows: value ? [value] : [], rowCount: value ? 1 : 0 };
          }
          if (sql.includes('DELETE FROM provider_credentials')) {
            const id = values.length === 2 && state.has(values[0])
              ? values[0]
              : [...state.entries()].find(([, row]) => row.workspaceId === values[0] && row.providerInstanceId === values[1])?.[0];
            if (!id) return { rows: [], rowCount: 0 };
            state.delete(id);
            return { rows: [{ id }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      }),
  };
  const service = new ProviderCredentialsService(
    db,
    {
      encrypt: async (value) => ({ ciphertext: `enc:${value}`, nonce: 'nonce', authTag: 'tag' }),
      decrypt: async (value) => value.ciphertext.slice(4),
    },
    { revoke: async () => ({ revoked: true }) },
    { append: async (_client, event) => audit.push(event) },
    undefined,
    { appendCredential: async (...args) => ledgerWrites.push(args) },
  );
  return { service, state, audit, ledgerWrites };
}

test('persists encrypted credentials and never returns plaintext to callers', async () => {
  const { service, state } = createService();
  const result = await service.connect({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    actorId: 'user-a',
    credentials: { accessToken: 'access-secret', refreshToken: 'refresh-secret' },
    grantedScopes: ['user-read-playback-state'],
    requestedScopes: ['user-read-playback-state'],
  });

  const stored = state.get(result.credentialId);
  assert.ok(stored.ciphertext.includes('enc:'));
  assert.equal(JSON.stringify(result).includes('access-secret'), false);
  assert.equal(JSON.stringify(result).includes('refresh-secret'), false);
});

test('rejects broader-than-requested scopes and credentials for a different workspace', async () => {
  const { service } = createService();
  await assert.rejects(
    service.connect({
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      actorId: 'user-a',
      credentials: { accessToken: 'token' },
      requestedScopes: ['user-read-playback-state'],
      grantedScopes: ['user-read-playback-state', 'user-modify-playback-state'],
    }),
  );
});

test('disconnect revokes provider authorization and removes credentials but preserves preferences', async () => {
  const { service, state, audit, ledgerWrites } = createService();
  const connected = await service.connect({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    actorId: 'user-a',
    credentials: { accessToken: 'access-secret' },
    requestedScopes: ['user-read-playback-state'],
    grantedScopes: ['user-read-playback-state'],
  });

  await service.disconnect({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    actorId: 'user-a',
  });

  assert.equal(state.has(connected.credentialId), false);
  assert.deepEqual(ledgerWrites, [[connected.credentialId, 'workspace-a', 'spotify-a']]);
  assert.equal(
    audit.some((event) => event.eventType === 'provider.disconnected'),
    true,
  );
});

test('disconnect-and-remove-data also removes integration settings and cache', async () => {
  const { service } = createService();
  const removed = [];
  service.setIntegrationDataStore({
    removeSettings: async (workspaceId, providerInstanceId) =>
      removed.push(['settings', workspaceId, providerInstanceId]),
    removeCache: async (workspaceId, providerInstanceId) =>
      removed.push(['cache', workspaceId, providerInstanceId]),
  });

  await service.disconnectAndRemoveData({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    actorId: 'user-a',
  });

  assert.deepEqual(removed, [
    ['settings', 'workspace-a', 'spotify-a'],
    ['cache', 'workspace-a', 'spotify-a'],
  ]);
});
