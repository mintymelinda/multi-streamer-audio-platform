import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackCoordinatorService } from '../dist/playback/playback-coordinator.service.js';

test('enforces workspace playback policy before issuing provider commands', async () => {
  let commandCount = 0;
  const service = new PlaybackCoordinatorService({
    getWorkspacePlaybackPolicy: async () => ({
      enabled: false,
      reason: 'Playback disabled by owner',
    }),
    getProviderAdapter: async () => ({
      play: async () => {
        commandCount += 1;
      },
    }),
    acquireLease: async () => true,
  });
  await assert.rejects(
    service.execute({
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      playerId: 'player-a',
      command: 'play',
      requestId: 'request-a',
      idempotencyKey: 'command-a',
    }),
    (error) => error.code === 'WORKSPACE_PLAYBACK_DISABLED',
  );
  assert.equal(commandCount, 0);
});

test('lease keys isolate workspaces and serialize only the same provider/player output', async () => {
  const acquired = [];
  const service = new PlaybackCoordinatorService({
    acquireLease: async (key) => {
      acquired.push(key);
      return true;
    },
    releaseLease: async () => undefined,
    findOperationByIdempotencyKey: async () => null,
    persistOperation: async (operation) => operation,
    getProviderAdapter: async () => ({ play: async () => ({ outcome: 'started' }) }),
  });
  await service.execute({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    command: 'play',
    requestId: 'request-a',
    idempotencyKey: 'a-1',
  });
  await service.execute({
    workspaceId: 'workspace-b',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    command: 'play',
    requestId: 'request-b',
    idempotencyKey: 'b-1',
  });
  assert.equal(acquired.length, 2);
  assert.notEqual(acquired[0], acquired[1]);
});

test('expired database leases may be reclaimed but a live lease may not be stolen', async () => {
  const now = new Date('2026-11-08T12:00:00.000Z');
  const service = new PlaybackCoordinatorService({
    now: () => now,
    acquireLease: async ({ expiresAt, ownerId }) => ({
      acquired: expiresAt <= now,
      ownerId: expiresAt <= now ? 'worker-new' : ownerId,
    }),
  });
  const expired = await service.acquirePlaybackLease({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    ownerId: 'worker-old',
    expiresAt: new Date('2026-11-08T11:59:00.000Z'),
  });
  const live = await service.acquirePlaybackLease({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    ownerId: 'worker-live',
    expiresAt: new Date('2026-11-08T12:01:00.000Z'),
  });
  assert.equal(expired.acquired, true);
  assert.equal(live.acquired, false);
});

test('persists command intent and terminal result for operational recovery', async () => {
  const persisted = [];
  const service = new PlaybackCoordinatorService({
    acquireLease: async () => true,
    releaseLease: async () => undefined,
    findOperationByIdempotencyKey: async () => null,
    persistOperation: async (operation) => {
      persisted.push(operation);
      return operation;
    },
    getProviderAdapter: async () => ({
      play: async () => ({ outcome: 'started', providerPlaybackId: 'playback-a' }),
    }),
  });
  await service.execute({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    command: 'play',
    requestId: 'request-a',
    idempotencyKey: 'command-persist',
  });
  assert.ok(persisted.length >= 2);
  assert.ok(persisted.some((operation) => operation.status === 'completed'));
});
