import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackCoordinatorService } from '../dist/playback/playback-coordinator.service.js';

function createCoordinator(overrides = {}) {
  const calls = [];
  const operations = new Map();
  const leases = new Set();
  const dependencies = {
    acquireLease: async (key) => {
      if (leases.has(key)) return false;
      leases.add(key);
      return true;
    },
    releaseLease: async (key) => leases.delete(key),
    findOperationByIdempotencyKey: async (key) => operations.get(key) ?? null,
    persistOperation: async (operation) => {
      operations.set(operation.idempotencyKey, operation);
      return operation;
    },
    getProviderAdapter: async () => ({
      play: async (input) => {
        calls.push(['play', input]);
        return { outcome: 'started', providerPlaybackId: 'playback-a' };
      },
      getPlaybackState: async () => ({ status: 'playing', providerPlaybackId: 'playback-a' }),
      pause: async () => ({ outcome: 'paused' }),
      skip: async () => ({ outcome: 'skipped' }),
    }),
    appendOutboxEvent: async (event) => calls.push(['outbox', event]),
    ...overrides,
  };
  return { service: new PlaybackCoordinatorService(dependencies), calls, operations, leases };
}

test('serializes conflicting commands for the same workspace and provider/player output', async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let started = 0;
  const { service } = createCoordinator({
    getProviderAdapter: async () => ({
      play: async () => {
        started += 1;
        if (started === 1) await gate;
        return { outcome: 'started', providerPlaybackId: 'playback-a' };
      },
    }),
  });

  const first = service.execute({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    command: 'play',
    requestId: 'request-a',
    idempotencyKey: 'command-1',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.execute({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    command: 'play',
    requestId: 'request-b',
    idempotencyKey: 'command-2',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(started, 2);
});

test('returns the persisted result for a duplicate idempotency key without replaying playback', async () => {
  const prior = {
    idempotencyKey: 'command-1',
    status: 'completed',
    result: { outcome: 'started' },
  };
  let calls = 0;
  const { service } = createCoordinator({
    findOperationByIdempotencyKey: async () => prior,
    getProviderAdapter: async () => ({
      play: async () => {
        calls += 1;
      },
    }),
  });
  const result = await service.execute({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    command: 'play',
    requestId: 'request-a',
    idempotencyKey: 'command-1',
  });
  assert.deepEqual(result, prior);
  assert.equal(calls, 0);
});

test('reconciles an uncertain provider outcome before permitting a retry', async () => {
  let plays = 0;
  const { service } = createCoordinator({
    getProviderAdapter: async () => ({
      play: async () => {
        plays += 1;
        return { outcome: 'unknown' };
      },
      getPlaybackState: async () => ({ status: 'playing', providerPlaybackId: 'playback-a' }),
    }),
  });
  const result = await service.execute({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    command: 'play',
    requestId: 'request-a',
    idempotencyKey: 'command-1',
  });
  assert.equal(plays, 1);
  assert.equal(result.status, 'reconciled');
  assert.equal(result.providerPlaybackId, 'playback-a');
});

test('does not start playback when the database lease is already held', async () => {
  let plays = 0;
  const { service } = createCoordinator({
    acquireLease: async () => false,
    getProviderAdapter: async () => ({
      play: async () => {
        plays += 1;
      },
    }),
  });
  await assert.rejects(
    service.execute({
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      playerId: 'player-a',
      command: 'play',
      requestId: 'request-a',
      idempotencyKey: 'command-1',
    }),
  );
  assert.equal(plays, 0);
});

test('releases the lease after provider failures and records a recoverable failed operation', async () => {
  const { service, leases, operations } = createCoordinator({
    getProviderAdapter: async () => ({
      play: async () => {
        throw new Error('provider unavailable');
      },
    }),
  });
  await assert.rejects(
    service.execute({
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      playerId: 'player-a',
      command: 'play',
      requestId: 'request-a',
      idempotencyKey: 'command-fail',
    }),
  );
  assert.equal(leases.size, 0);
  assert.equal(operations.get('command-fail')?.status, 'failed');
});
