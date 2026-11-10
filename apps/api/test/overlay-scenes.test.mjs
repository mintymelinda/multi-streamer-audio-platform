import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../dist/identity/security.js';
import { OverlayScenesService } from '../dist/overlay-scenes/overlay-scenes.service.js';

function harness() {
  const calls = [];
  const database = {
    transaction: async (context, operation) => {
      calls.push({ context });
      return operation({
        query: async (sql, values = []) => {
          calls.push({ sql, values });
          if (sql.includes('INSERT INTO overlay_scenes')) {
            return {
              rows: [{
                id: values[0],
                name: values[2],
                sort_order: 0,
                created_at: new Date(),
                updated_at: new Date(),
                token_created_at: new Date(),
                token_revoked_at: null,
                has_active_access: true,
              }],
              rowCount: 1,
            };
          }
          if (sql.includes('UPDATE overlay_scenes') && sql.includes('access_token_hash = $3')) {
            return {
              rows: [{
                id: values[0],
                name: 'Starting Soon',
                sort_order: 0,
                created_at: new Date(),
                updated_at: new Date(),
                token_created_at: new Date(),
                token_revoked_at: null,
                has_active_access: true,
              }],
              rowCount: 1,
            };
          }
          if (sql.includes('UPDATE overlay_scenes') && sql.includes('access_token_hash = NULL')) {
            return { rows: [{ id: values[0], token_revoked_at: new Date() }], rowCount: 1 };
          }
          if (sql.includes('FROM overlay_scenes')) return { rows: [], rowCount: 0 };
          return { rows: [], rowCount: 1 };
        },
      });
    },
  };
  return { service: new OverlayScenesService(database), calls };
}

test('creates a scene with a high-entropy token and persists only its SHA-256 hash', async () => {
  const { service, calls } = harness();
  const result = await service.create('workspace-a', 'user-a', { name: '  Now Playing  ' });
  const insert = calls.find((call) => call.sql?.includes('INSERT INTO overlay_scenes'));
  assert.equal(insert.values[2], 'Now Playing');
  assert.equal(insert.values[3], sha256(result.accessToken));
  assert.match(result.accessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(insert.values[3], result.accessToken);
  assert.deepEqual(calls[0].context, {
    userId: 'user-a',
    verifiedWorkspaceId: 'workspace-a',
  });
  assert.equal(result.overlayPath, `/scene/${result.scene.id}`);
  assert.equal(result.scene.has_active_access, true);
  assert.ok(!JSON.stringify(result.scene).includes('access_token_hash'));
  const audit = calls.find((call) => call.sql?.includes('INSERT INTO audit_events'));
  assert.ok(!audit.values.includes(result.accessToken));
  assert.ok(!audit.values.includes(sha256(result.accessToken)));
});

test('lists scene metadata without selecting or returning token hashes', async () => {
  const { service, calls } = harness();
  await service.list('workspace-a', 'user-a');
  const query = calls.find((call) => call.sql?.includes('FROM overlay_scenes'));
  assert.ok(query.sql.includes('has_active_access'));
  assert.ok(!query.sql.includes('access_token_hash,'));
  assert.deepEqual(calls[0].context, {
    userId: 'user-a',
    verifiedWorkspaceId: 'workspace-a',
  });
});

test('rotates a scene token by replacing its hash and returning the new secret once', async () => {
  const { service, calls } = harness();
  const result = await service.rotateAccessToken('workspace-a', 'user-a', 'scene-a');
  const update = calls.find((call) => call.sql?.includes('access_token_hash = $3'));
  assert.equal(update.values[0], 'scene-a');
  assert.equal(update.values[1], 'workspace-a');
  assert.equal(update.values[2], sha256(result.accessToken));
  assert.equal(result.scene.has_active_access, true);
  assert.equal(result.overlayPath, '/scene/scene-a');
});

test('revokes a scene token without deleting the scene', async () => {
  const { service, calls } = harness();
  const result = await service.revokeAccessToken('workspace-a', 'user-a', 'scene-a');
  const update = calls.find((call) => call.sql?.includes('access_token_hash = NULL'));
  assert.deepEqual(update.values, ['scene-a', 'workspace-a']);
  assert.equal(result.sceneId, 'scene-a');
  assert.equal(result.hasActiveAccess, false);
  assert.ok(result.tokenRevokedAt instanceof Date);
});

test('rejects blank and oversized scene names before accessing the database', async () => {
  const { service, calls } = harness();
  await assert.rejects(service.create('workspace-a', 'user-a', { name: '   ' }), /between 1 and 80/);
  await assert.rejects(service.create('workspace-a', 'user-a', { name: 'x'.repeat(81) }), /between 1 and 80/);
  assert.equal(calls.length, 0);
});
