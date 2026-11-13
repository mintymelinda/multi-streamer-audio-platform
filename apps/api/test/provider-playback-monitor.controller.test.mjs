import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { ProviderPlaybackMonitorController } from '../dist/providers/provider-playback-monitor.controller.js';

const payload = {
  executionStateId: '10000000-0000-4000-8000-000000000001',
  workspaceId: '20000000-0000-4000-8000-000000000002',
  requestId: '30000000-0000-4000-8000-000000000003',
  providerInstanceId: '40000000-0000-4000-8000-000000000004',
  dispatchGeneration: 2,
  actorUserId: '50000000-0000-4000-8000-000000000005',
};

function signedHeaders(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', 'monitor-test-secret')
    .update(`${timestamp}.${JSON.stringify(body)}`)
    .digest('hex');
  return { timestamp, signature };
}

function harness(state) {
  const queries = [];
  const dispatches = [];
  const database = {
    transaction: async (_context, callback) => callback({
      query: async (sql, values) => {
        queries.push({ sql, values });
        if (sql.includes('SELECT assignment.output_id')) {
          return {
            rows: [{ output_id: 'output-a', player_id: 'player-a', provider_playback_id: 'playlist-7' }],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT execution.id')) return { rows: [{ id: payload.executionStateId }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    }),
  };
  const coordinator = {
    withPlaybackState: async (_input, action) => action(state),
  };
  const queueManager = {
    dispatchNext: async (input) => {
      dispatches.push(input);
      return { status: 'empty' };
    },
  };
  return {
    controller: new ProviderPlaybackMonitorController(database, coordinator, queueManager),
    queries,
    dispatches,
  };
}

test('completes only the matching Lyrion playlist session at its end and advances the queue', async () => {
  process.env.PROVIDER_EXECUTION_HANDOFF_SECRET = 'monitor-test-secret';
  const h = harness({
    status: 'stopped',
    providerPlaybackId: 'playlist-7',
    progressMs: 180000,
    durationMs: 180000,
  });
  const headers = signedHeaders(payload);

  const result = await h.controller.monitor(payload, headers.timestamp, headers.signature);

  assert.deepEqual(result, { accepted: true, status: 'completed' });
  assert.equal(h.queries.some(({ sql }) => sql.includes("SET status = 'completed'")), true);
  assert.deepEqual(h.dispatches, [{
    workspaceId: payload.workspaceId,
    actorId: payload.actorUserId,
  }]);
});

test('does not complete playback when the provider playlist session changed', async () => {
  process.env.PROVIDER_EXECUTION_HANDOFF_SECRET = 'monitor-test-secret';
  const h = harness({
    status: 'stopped',
    providerPlaybackId: 'different-playlist',
    progressMs: 180000,
    durationMs: 180000,
  });
  const headers = signedHeaders(payload);

  const result = await h.controller.monitor(payload, headers.timestamp, headers.signature);

  assert.deepEqual(result, { accepted: true, status: 'session_changed' });
  assert.equal(h.queries.some(({ sql }) => sql.includes("SET status = 'completed'")), false);
  assert.equal(h.dispatches.length, 0);
});

test('does not complete a stopped track before its duration threshold', async () => {
  process.env.PROVIDER_EXECUTION_HANDOFF_SECRET = 'monitor-test-secret';
  const h = harness({
    status: 'stopped',
    providerPlaybackId: 'playlist-7',
    progressMs: 60000,
    durationMs: 180000,
  });
  const headers = signedHeaders(payload);

  const result = await h.controller.monitor(payload, headers.timestamp, headers.signature);

  assert.deepEqual(result, { accepted: true, status: 'stopped_before_end' });
  assert.equal(h.queries.some(({ sql }) => sql.includes("SET status = 'completed'")), false);
  assert.equal(h.dispatches.length, 0);
});
