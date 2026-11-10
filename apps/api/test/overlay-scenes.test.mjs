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
  const result = await service.create('workspace-a', 'user-a', '  Now Playing  ');
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
  await assert.rejects(service.create('workspace-a', 'user-a', '   '), /between 1 and 80/);
  await assert.rejects(service.create('workspace-a', 'user-a', 'x'.repeat(81)), /between 1 and 80/);
  assert.equal(calls.length, 0);
});

test('saves a draft with optimistic revision control without changing published state', async () => {
  const statements = [];
  const database = {
    transaction: async (_context, operation) => operation({
      query: async (sql, values = []) => {
        statements.push({ sql, values });
        if (sql.includes('UPDATE overlay_scenes') && sql.includes('draft_state = $4')) {
          return { rows: [{ id: values[0], name: 'Starting Soon', draft_state: JSON.parse(values[3]), draft_revision: '3', updated_at: new Date() }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    }),
  };
  const service = new OverlayScenesService(database, { append: async () => 'outbox-id' });
  const result = await service.saveDraft('workspace-a', 'user-a', 'scene-a', { version: 1, elements: [{ text: 'Draft' }] }, 2);
  const update = statements.find((entry) => entry.sql.includes('UPDATE overlay_scenes'));
  assert.deepEqual(update.values.slice(0, 3), ['scene-a', 'workspace-a', 2]);
  assert.ok(update.sql.includes('draft_state = $4::jsonb'));
  assert.ok(!update.sql.includes('published_state ='));
  assert.equal(result.draftRevision, 3);
  assert.equal(result.draftState.elements[0].text, 'Draft');
});

test('rejects stale draft revisions instead of overwriting another editor', async () => {
  const database = {
    transaction: async (_context, operation) => operation({
      query: async (sql) => sql.includes('SELECT 1 FROM overlay_scenes')
        ? { rows: [{ '?column?': 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    }),
  };
  const service = new OverlayScenesService(database, { append: async () => 'unused' });
  await assert.rejects(
    service.saveDraft('workspace-a', 'user-a', 'scene-a', { version: 1, elements: [] }, 0),
    /changed elsewhere/,
  );
});

test('publishes the saved draft transactionally and emits an invalidation outbox event', async () => {
  const statements = [];
  const events = [];
  const publishedAt = new Date('2026-11-10T12:00:00.000Z');
  const database = {
    transaction: async (_context, operation) => operation({
      query: async (sql, values = []) => {
        statements.push({ sql, values });
        if (sql.includes('UPDATE overlay_scenes') && sql.includes('published_state = draft_state')) {
          return { rows: [{ id: values[0], name: 'Now Playing', published_state: { version: 1, elements: [] }, draft_revision: '4', published_at: publishedAt }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    }),
  };
  const service = new OverlayScenesService(database, {
    append: async (_client, event) => { events.push(event); return 'outbox-id'; },
  });
  const result = await service.publishDraft('workspace-a', 'user-a', 'scene-a', 4);
  assert.equal(result.publishedRevision, 4);
  assert.equal(result.publishedAt, publishedAt);
  const update = statements.find((entry) => entry.sql.includes('published_state = draft_state'));
  assert.ok(update);
  assert.ok(!update.sql.includes('draft_state = $'));
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'overlay.scene.published');
  assert.equal(events[0].aggregateId, 'scene-a');
  assert.equal(events[0].payload.draftRevision, 4);
});

test('rejects scene documents larger than 256 KiB', async () => {
  const { service, calls } = harness();
  await assert.rejects(
    service.saveDraft('workspace-a', 'user-a', 'scene-a', { text: 'x'.repeat(270 * 1024) }, 0),
    /must not exceed 256 KiB/,
  );
  assert.equal(calls.length, 0);
});

test('creates exactly one starter scene per workspace and returns its token only on creation', async () => {
  const calls = [];
  const starters = new Map();
  let inserts = 0;
  const database = {
    transaction: async (context, operation) => {
      calls.push({ context });
      return operation({
        query: async (sql, values = []) => {
          calls.push({ sql, values });
          if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
          if (sql.includes('SELECT id, name, sort_order') && sql.includes('is_starter = true')) {
            const existing = starters.get(values[0]);
            return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
          }
          if (sql.includes('INSERT INTO overlay_scenes') && sql.includes('is_starter')) {
            inserts += 1;
            const scene = {
              id: values[0],
              name: 'Now Playing',
              sort_order: 0,
              created_at: new Date(),
              updated_at: new Date(),
              token_created_at: new Date(),
              token_revoked_at: null,
              has_active_access: true,
            };
            starters.set(values[1], scene);
            return { rows: [scene], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      });
    },
  };
  const service = new OverlayScenesService(database);
  const first = await service.ensureStarter('workspace-a', 'user-a');
  const second = await service.ensureStarter('workspace-a', 'user-a');

  assert.equal(first.created, true);
  assert.equal(first.scene.name, 'Now Playing');
  assert.match(first.accessToken, /^[A-Za-z0-9_-]{43}$/);
  const insert = calls.find((call) => call.sql?.includes('INSERT INTO overlay_scenes') && call.sql.includes('is_starter'));
  assert.equal(insert.values[2], sha256(first.accessToken));
  assert.equal(second.created, false);
  assert.equal(second.accessToken, null);
  assert.equal(second.scene.id, first.scene.id);
  assert.equal(inserts, 1);
  assert.equal(calls.filter((call) => call.sql?.includes('pg_advisory_xact_lock')).length, 2);
});

test('starter creation is scoped to the requested workspace', async () => {
  const starters = new Map();
  const database = {
    transaction: async (_context, operation) => operation({
      query: async (sql, values = []) => {
        if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('is_starter = true')) {
          const existing = starters.get(values[0]);
          return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
        }
        if (sql.includes('INSERT INTO overlay_scenes') && sql.includes('is_starter')) {
          const scene = { id: values[0], name: 'Now Playing', sort_order: 0, created_at: new Date(), updated_at: new Date(), token_created_at: new Date(), token_revoked_at: null, has_active_access: true };
          starters.set(values[1], scene);
          return { rows: [scene], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    }),
  };
  const service = new OverlayScenesService(database);
  const workspaceA = await service.ensureStarter('workspace-a', 'user-a');
  const workspaceB = await service.ensureStarter('workspace-b', 'user-b');
  assert.notEqual(workspaceA.scene.id, workspaceB.scene.id);
  assert.equal(starters.size, 2);
});

