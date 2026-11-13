import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PlaybackCoordinatorService,
  ProviderCommandRejectedError,
} from '../dist/playback/playback-coordinator.service.js';

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
      getPlaybackState: async () => ({
        status: 'playing',
        providerPlaybackId: 'playback-a',
        requestId: 'request-a',
      }),
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
      getPlaybackState: async () => ({
        status: 'playing',
        providerPlaybackId: 'playback-a',
        requestId: 'request-a',
      }),
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
        throw new ProviderCommandRejectedError('provider unavailable');
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

test('does not replay an operation left uncertain after a process interruption', async () => {
  const prior = {
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    requestId: 'request-a',
    command: 'play',
    idempotencyKey: 'command-interrupted',
    status: 'executing',
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
  };
  let playCalls = 0;
  let persisted;
  const service = new PlaybackCoordinatorService({
    findOperationByIdempotencyKey: async () => prior,
    persistOperation: async (operation) => {
      persisted = operation;
      return operation;
    },
    getProviderAdapter: async () => ({
      play: async () => {
        playCalls += 1;
        return { outcome: 'started' };
      },
      getPlaybackState: async () => ({ status: 'stopped' }),
    }),
    acquireLease: async () => {
      throw new Error('uncertain operations must not acquire a new command lease');
    },
  });
  const result = await service.execute({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    command: 'play',
    requestId: 'request-a',
    idempotencyKey: 'command-interrupted',
  });
  assert.equal(playCalls, 0);
  assert.equal(result.status, 'uncertain');
  assert.equal(persisted.status, 'uncertain');
});

test('does not reconcile playback belonging to a different request', async () => {
  const prior = {
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    requestId: 'request-a',
    command: 'play',
    idempotencyKey: 'command-interrupted',
    status: 'uncertain',
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
  };
  const service = new PlaybackCoordinatorService({
    findOperationByIdempotencyKey: async () => prior,
    persistOperation: async (operation) => operation,
    getProviderAdapter: async () => ({
      getPlaybackState: async () => ({
        status: 'playing',
        providerPlaybackId: 'playback-b',
        requestId: 'request-b',
      }),
    }),
    acquireLease: async () => true,
  });
  const result = await service.execute({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    command: 'play',
    requestId: 'request-a',
    idempotencyKey: 'command-interrupted',
  });
  assert.equal(result.status, 'uncertain');
});

test('redacts provider secrets before persisting command results', async () => {
  const { service, operations } = createCoordinator({
    getProviderAdapter: async () => ({
      play: async () => ({
        outcome: 'started',
        accessToken: 'must-not-be-persisted',
        providerPlaybackId: 'playback-safe',
      }),
    }),
  });
  await service.execute({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    command: 'play',
    requestId: 'request-a',
    idempotencyKey: 'command-redaction',
  });
  assert.equal(operations.get('command-redaction').result.accessToken, '[REDACTED]');
});

test('blocks a new idempotency key while a prior output command remains uncertain', async () => {
  const prior = {
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    outputId: 'output-a',
    requestId: 'request-prior',
    command: 'play',
    idempotencyKey: 'command-prior',
    status: 'executing',
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
  };
  let newPlayCalls = 0;
  const service = new PlaybackCoordinatorService({
    findOperationByIdempotencyKey: async () => null,
    findUnresolvedOperation: async () => prior,
    persistOperation: async (operation) => operation,
    getProviderAdapter: async () => ({
      play: async () => {
        newPlayCalls += 1;
        return { outcome: 'started' };
      },
      getPlaybackState: async () => ({ status: 'stopped', requestId: 'request-prior' }),
    }),
    acquireLease: async () => {
      throw new Error('must not acquire a command lease while the earlier outcome is uncertain');
    },
  });
  await assert.rejects(
    service.execute({
      workspaceId: 'workspace-a',
      providerInstanceId: 'spotify-a',
      playerId: 'player-a',
      outputId: 'output-a',
      command: 'play',
      requestId: 'request-new',
      idempotencyKey: 'command-new',
    }),
    (error) => error.code === 'PLAYBACK_OUTCOME_UNCERTAIN',
  );
  assert.equal(newPlayCalls, 0);
});

test('treats an ambiguous provider exception as uncertain instead of retryable failure', async () => {
  const { service, operations } = createCoordinator({
    getProviderAdapter: async () => ({
      play: async () => {
        throw new Error('connection timed out after sending command');
      },
      getPlaybackState: async () => ({ status: 'stopped', requestId: 'request-a' }),
    }),
  });
  const result = await service.execute({
    workspaceId: 'workspace-a',
    providerInstanceId: 'spotify-a',
    playerId: 'player-a',
    command: 'play',
    requestId: 'request-a',
    idempotencyKey: 'command-timeout',
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(operations.get('command-timeout').status, 'uncertain');
});

test('passes verified workspace and actor context to the output adapter factory', async () => {
  let received;
  const { service } = createCoordinator({
    getProviderAdapter: async (providerInstanceId, context) => {
      received = { providerInstanceId, context };
      return { play: async () => ({ outcome: 'started' }) };
    },
  });
  await service.execute({
    workspaceId: 'workspace-a',
    providerInstanceId: 'lyrion-a',
    playerId: 'player-a',
    outputId: 'output-a',
    requestId: 'request-a',
    command: 'play',
    idempotencyKey: 'command-context',
    actorId: 'actor-a',
  });
  assert.equal(received.providerInstanceId, 'lyrion-a');
  assert.equal(received.context.workspaceId, 'workspace-a');
  assert.equal(received.context.actorId, 'actor-a');
  assert.equal(received.context.outputId, 'output-a');
});


test('observes playback under the DB-backed output lease and releases the lease', async () => {
  const events=[];
  const state={status:'playing',positionMs:12_000,durationMs:180_000};
  const {service}=createCoordinator({
    acquireLease:async(key,context)=>{events.push(['acquire',key,context]);return {acquired:true,fencingToken:17};},
    releaseLease:async(key,context)=>{events.push(['release',key,context]);return true;},
    getProviderAdapter:async(_provider,input)=>({
      getPlaybackState:async(observationInput)=>{events.push(['observe',input,observationInput]);return state;},
    }),
  });
  const result=await service.observePlaybackState({
    workspaceId:'workspace-a',providerInstanceId:'lyrion-a',playerId:'player-a',
    outputId:'output-a',requestId:'request-a',command:'play',
    idempotencyKey:'playback-monitor-session-a',actorId:'owner-a',
  });
  assert.deepEqual(result,state);
  assert.equal(events[0][0],'acquire');
  assert.equal(events[1][0],'observe');
  assert.equal(events[1][2].fencingToken,17);
  assert.equal(events[2][0],'release');
});

test('does not observe a provider while an output lease is held by another command', async () => {
  let observed=false;
  const {service}=createCoordinator({
    acquireLease:async()=>({acquired:false}),
    getProviderAdapter:async()=>({getPlaybackState:async()=>{observed=true;return {status:'playing'};}}),
  });
  const result=await service.observePlaybackState({
    workspaceId:'workspace-a',providerInstanceId:'lyrion-a',playerId:'player-a',
    requestId:'request-a',command:'play',idempotencyKey:'playback-monitor-session-b',actorId:'owner-a',
  });
  assert.equal(result,null);
  assert.equal(observed,false);
});

test('independent coordinator instances cannot start the same output while a database lease is held', async () => {
  const leases = new Map();
  let releaseFirst;
  let signalStarted;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  let playCalls = 0;

  const dependencies = {
    acquireLease: async (key, context) => {
      const current = leases.get(key);
      const now = new Date();
      if (current && current.expiresAt > now) return { acquired: false };
      const fencingToken = (current?.fencingToken ?? 0) + 1;
      leases.set(key, {
        ownerId: context.ownerId,
        fencingToken,
        expiresAt: context.expiresAt,
      });
      return { acquired: true, fencingToken };
    },
    releaseLease: async (key, context) => {
      const current = leases.get(key);
      if (current?.ownerId === context.ownerId) leases.delete(key);
    },
    findOperationByIdempotencyKey: async () => null,
    persistOperation: async (operation) => operation,
    getProviderAdapter: async () => ({
      play: async () => {
        playCalls += 1;
        signalStarted();
        await gate;
        return { outcome: 'started' };
      },
    }),
  };

  const firstCoordinator = new PlaybackCoordinatorService(dependencies);
  const secondCoordinator = new PlaybackCoordinatorService(dependencies);
  const command = {
    workspaceId: 'workspace-a',
    providerInstanceId: 'lyrion-a',
    playerId: 'player-a',
    outputId: 'output-a',
    command: 'play',
  };
  const first = firstCoordinator.execute({
    ...command,
    requestId: 'request-a',
    idempotencyKey: 'request-a-play',
  });

  await started;
  await assert.rejects(
    secondCoordinator.execute({
      ...command,
      requestId: 'request-b',
      idempotencyKey: 'request-b-play',
    }),
    (error) => error.code === 'PLAYBACK_LEASE_HELD',
  );
  assert.equal(playCalls, 1);

  releaseFirst();
  await first;
  assert.equal(leases.size, 0);
});

