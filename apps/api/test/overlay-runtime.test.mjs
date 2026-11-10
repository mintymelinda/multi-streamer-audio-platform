import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../dist/identity/security.js';
import { OverlayRuntimeService } from '../dist/overlay-scenes/overlay-runtime.service.js';

test('authenticates an overlay using only the hash of its bearer token', async () => {
  const token = 'a'.repeat(43);
  const calls = [];
  const database = {
    queryInfrastructure: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [{ scene_id: 'scene-1', workspace_id: 'workspace-1', scene_name: 'Now Playing', published_state: null }] };
    },
  };
  const runtime = new OverlayRuntimeService(database);
  const result = await runtime.authenticate('11111111-1111-4111-8111-111111111111', token);
  assert.equal(result.workspaceId, 'workspace-1');
  assert.equal(result.snapshot.name, 'Now Playing');
  assert.equal(calls[0].values[1], sha256(token));
  assert.notEqual(calls[0].values[1], token);
});

test('rejects malformed scene IDs and bearer tokens without database access', async () => {
  let queried = false;
  const runtime = new OverlayRuntimeService({
    queryInfrastructure: async () => { queried = true; return { rows: [] }; },
  });
  assert.equal(await runtime.authenticate('not-a-uuid', 'a'.repeat(43)), null);
  assert.equal(await runtime.authenticate('11111111-1111-4111-8111-111111111111', 'short'), null);
  assert.equal(queried, false);
});

test('returns no snapshot when the token is revoked or unknown', async () => {
  const runtime = new OverlayRuntimeService({
    queryInfrastructure: async () => ({ rows: [] }),
  });
  assert.equal(await runtime.snapshot('11111111-1111-4111-8111-111111111111', 'a'.repeat(43)), null);
});
