import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeWorkerHealthServer,
  createWorkerHealthServer,
  getWorkerReadiness,
  listenWorkerHealthServer,
} from '../dist/worker-health.server.js';

async function withServer(probes, callback) {
  const server = createWorkerHealthServer(probes, { startedAt: Date.now() - 2_000 });
  await listenWorkerHealthServer(server, 0);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await callback('http://127.0.0.1:' + address.port);
  } finally {
    await closeWorkerHealthServer(server);
  }
}

test('worker readiness reports PostgreSQL and Redis independently', async () => {
  const report = await getWorkerReadiness({
    postgres: async () => undefined,
    redis: async () => 'PONG',
  });
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.dependencies, { postgres: 'ready', redis: 'ready' });
  assert.ok(report.uptimeSeconds >= 0);
});

test('worker readiness is unavailable when either dependency probe fails', async () => {
  const report = await getWorkerReadiness({
    postgres: async () => undefined,
    redis: async () => { throw new Error('private redis connection detail'); },
  });
  assert.equal(report.status, 'not_ready');
  assert.deepEqual(report.dependencies, { postgres: 'ready', redis: 'unavailable' });
  assert.equal(JSON.stringify(report).includes('private redis'), false);
});

test('health server exposes liveness without dependency checks and readiness with both checks', async () => {
  let calls = 0;
  await withServer({
    postgres: async () => { calls += 1; },
    redis: async () => { calls += 1; },
  }, async (origin) => {
    const live = await fetch(origin + '/health/live');
    assert.equal(live.status, 200);
    assert.equal((await live.json()).status, 'ok');
    assert.equal(calls, 0);

    const ready = await fetch(origin + '/health/ready');
    assert.equal(ready.status, 200);
    const body = await ready.json();
    assert.equal(body.status, 'ok');
    assert.deepEqual(body.dependencies, { postgres: 'ready', redis: 'ready' });
    assert.equal(calls, 2);
  });
});

test('health server returns 503 without leaking dependency errors', async () => {
  await withServer({
    postgres: async () => { throw new Error('password=do-not-leak'); },
    redis: async () => 'PONG',
  }, async (origin) => {
    const response = await fetch(origin + '/health/ready');
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /postgres/);
    assert.doesNotMatch(body, /do-not-leak|password/);
  });
});

test('health server rejects unknown paths and non-GET methods', async () => {
  await withServer({
    postgres: async () => undefined,
    redis: async () => 'PONG',
  }, async (origin) => {
    assert.equal((await fetch(origin + '/unknown')).status, 404);
    assert.equal((await fetch(origin + '/health/live', { method: 'POST' })).status, 405);
  });
});

test('health server validates its port', () => {
  const server = createWorkerHealthServer({ postgres: async () => undefined, redis: async () => undefined });
  assert.throws(() => listenWorkerHealthServer(server, 65_536), /worker_health_port_invalid/);
});
