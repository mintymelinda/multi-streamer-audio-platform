import assert from 'node:assert/strict';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import test from 'node:test';

const processFixture = fileURLToPath(
  new URL('./fixtures/phase8-provider-execution-worker-process.mjs', import.meta.url),
);
const handoffSecret = 'phase8-two-worker-handoff-secret-at-least-32-bytes';

function findPostgresContainer() {
  const result = spawnSync(
    'docker',
    ['ps', '--filter', 'ancestor=postgres:18.6', '--format', '{{.ID}}'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  return result.stdout.trim().split('\n').find(Boolean) ?? null;
}

function runSql(containerId, sql) {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-e',
      'PGPASSWORD=ci-bootstrap-only',
      containerId,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'platform_bootstrap',
      '-d',
      'platform',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-A',
      '-t',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error('PostgreSQL fixture command failed: ' + result.stderr.trim());
  }
  return result.stdout.trim();
}

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('Docker fixture command failed: ' + result.stderr.trim());
  }
  return result.stdout.trim();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Handoff fixture did not bind to a TCP port.'));
        return;
      }
      resolve('http://127.0.0.1:' + address.port);
    });
  });
}

function verifyHandoffSignature(timestamp, signature, body) {
  if (
    typeof timestamp !== 'string' ||
    !/^\d{10}$/.test(timestamp) ||
    typeof signature !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(signature)
  ) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', handoffSecret)
    .update(timestamp + '.' + JSON.stringify(body))
    .digest();
  const supplied = Buffer.from(signature, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function createHandoffFixture() {
  const received = deferred();
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw);
      const validSignature = verifyHandoffSignature(
        request.headers['x-provider-execution-timestamp'],
        request.headers['x-provider-execution-signature'],
        body,
      );
      requests.push({ body, validSignature, path: request.url });
      received.resolve({ body, validSignature, path: request.url });
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        accepted: true,
        operationId: 'phase8-operation-' + body.executionStateId,
        status: 'accepted',
      }));
    } catch {
      response.writeHead(400).end();
    }
  });

  return {
    requests,
    received: received.promise,
    async start() {
      return listen(server);
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function startWorkerProcess(environment) {
  const child = spawn(process.execPath, [processFixture], {
    cwd: process.cwd(),
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stdout = '';
  let stderr = '';
  const messages = [];
  const waiters = [];

  function deliver(message) {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout = (stdout + chunk).slice(-6000);
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        deliver(JSON.parse(line));
      } catch {
        deliver({ type: 'output-error', message: 'worker-emitted-invalid-json' });
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-6000);
  });
  child.stdin.on('error', () => undefined);
  child.on('error', (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  child.on('exit', (code, signal) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(
        'Worker child exited before replying (' + code + '/' + signal + '). stdout='
          + stdout + ' stderr=' + stderr,
      ));
    }
  });

  return {
    child,
    waitFor(predicate, timeoutMs = 20000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const current = waiters.indexOf(waiter);
            if (current >= 0) waiters.splice(current, 1);
            reject(new Error('Timed out waiting for provider worker: stdout=' + stdout + ' stderr=' + stderr));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (child.stdin.writable) child.stdin.write(JSON.stringify({ type: 'close' }) + '\n');
      const closed = new Promise((resolve) => child.once('exit', resolve));
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
      await closed;
      clearTimeout(timer);
    },
  };
}

async function waitForRedis(redisUrl) {
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => attempt > 30 ? null : 100,
  });
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        if (await redis.ping() === 'PONG') return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error('Disposable Redis fixture did not become ready.');
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

test('two independent BullMQ provider workers share one Redis queue and hand off a validated job once', async (t) => {
  if (process.env.CI !== 'true' && process.env.GITHUB_ACTIONS !== 'true') {
    t.skip('Runs in CI with disposable Redis and the PostgreSQL service container.');
    return;
  }

  const postgresContainer = findPostgresContainer();
  if (!postgresContainer) {
    t.skip('No PostgreSQL 18.6 CI service container is available.');
    return;
  }

  const redisContainer = 'phase8-provider-workers-' + process.pid + '-' + randomUUID().slice(0, 8);
  const actorId = randomUUID();
  const workspaceId = randomUUID();
  const sourceProviderId = randomUUID();
  const outputProviderId = randomUUID();
  const requestId = randomUUID();
  const executionStateId = randomUUID();
  const outputId = 'phase8-output-' + randomUUID();
  const playerId = 'phase8-player-' + randomUUID();
  const twitchId = String(Date.now()) + String(Math.floor(Math.random() * 1_000_000));
  const jobId = 'phase8-provider-' + executionStateId + '-1';
  const handoff = createHandoffFixture();
  const children = [];
  let seeded = false;
  let redisStarted = false;
  let queue;
  let queueConnection;

  try {
    docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      redisContainer,
      '-p',
      '127.0.0.1::6379',
      'redis:8.10.3',
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
    ]);
    redisStarted = true;
    const mappedPort = docker(['port', redisContainer, '6379/tcp'])
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('127.0.0.1:'))
      ?.split(':')
      .at(-1);
    assert.ok(mappedPort, 'Redis container must expose a loopback host port');
    const redisUrl = 'redis://127.0.0.1:' + mappedPort;
    await waitForRedis(redisUrl);

    const handoffUrl = await handoff.start();
    const seed = [
      'BEGIN;',
      "INSERT INTO platform_users (id, twitch_user_id) VALUES ('" + actorId + "', '" + twitchId + "');",
      "INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id) VALUES ('" + workspaceId + "', 'Phase 8 worker queue', '" + actorId + "', '" + twitchId + "');",
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ('" + workspaceId + "', '" + actorId + "', 'owner', 'active');",
      "INSERT INTO provider_instances (id, workspace_id, provider_id, instance_key, contract_version, capabilities, connection_health, enabled) VALUES ('" + sourceProviderId + "', '" + workspaceId + "', 'youtube', 'phase8-source-" + sourceProviderId + "', 1, '{\"resolve\":true}'::jsonb, 'healthy', true);",
      "INSERT INTO provider_instances (id, workspace_id, provider_id, instance_key, contract_version, capabilities, connection_health, enabled) VALUES ('" + outputProviderId + "', '" + workspaceId + "', 'lyrion', 'phase8-output-" + outputProviderId + "', 1, '{\"playback\":true,\"supportedSourceProviderIds\":[\"youtube\"]}'::jsonb, 'healthy', true);",
      "INSERT INTO provider_output_assignments (workspace_id, provider_instance_id, output_id, player_id, assigned_by, active) VALUES ('" + workspaceId + "', '" + outputProviderId + "', '" + outputId + "', '" + playerId + "', '" + actorId + "', true);",
      "INSERT INTO media_requests (id, workspace_id, source, submitted_by_user_id, provider, media_id, title, status) VALUES ('" + requestId + "', '" + workspaceId + "', 'dashboard', '" + actorId + "', 'youtube', 'phase8-media', 'Phase 8 worker handoff', 'queued');",
      "INSERT INTO logical_queue_entries (workspace_id, request_id, priority, sequence) VALUES ('" + workspaceId + "', '" + requestId + "', 0, 1);",
      "INSERT INTO provider_execution_states (id, workspace_id, request_id, provider_instance_id, state, dispatch_generation) VALUES ('" + executionStateId + "', '" + workspaceId + "', '" + requestId + "', '" + outputProviderId + "', 'queued', 1);",
      'COMMIT;',
    ].join('\n');
    runSql(postgresContainer, seed);
    seeded = true;

    const environment = {
      ...process.env,
      NODE_ENV: 'test',
      PROVIDER_EXECUTION_DATABASE_URL: 'postgresql://platform_provider_worker:local-provider-worker-only@127.0.0.1:5432/platform',
      REDIS_URL: redisUrl,
      PROVIDER_EXECUTION_HANDOFF_URL: handoffUrl + '/internal/provider-executions/handoff',
      PROVIDER_EXECUTION_HANDOFF_SECRET: handoffSecret,
    };
    delete environment.PROVIDER_EXECUTION_DATABASE_URL_FILE;
    delete environment.REDIS_URL_FILE;
    delete environment.PROVIDER_EXECUTION_HANDOFF_SECRET_FILE;

    const first = startWorkerProcess(environment);
    const second = startWorkerProcess(environment);
    children.push(first, second);
    const ready = await Promise.all([
      first.waitFor((message) => message.type === 'ready' || message.type === 'boot-error'),
      second.waitFor((message) => message.type === 'ready' || message.type === 'boot-error'),
    ]);
    assert.equal(ready[0].type, 'ready', JSON.stringify(ready[0]));
    assert.equal(ready[1].type, 'ready', JSON.stringify(ready[1]));

    queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue('provider-execution', { connection: queueConnection });
    await queue.waitUntilReady();
    const jobData = {
      executionStateId,
      workspaceId,
      requestId,
      providerInstanceId: outputProviderId,
      dispatchGeneration: 1,
    };
    const firstJob = await queue.add('provider-execution', jobData, {
      jobId,
      attempts: 1,
      removeOnComplete: false,
    });
    const duplicateJob = await queue.add('provider-execution', jobData, {
      jobId,
      attempts: 1,
      removeOnComplete: false,
    });
    assert.equal(duplicateJob.id, firstJob.id, 'duplicate dispatcher delivery must reuse the same BullMQ job ID');

    const delivered = await handoff.received;
    assert.equal(delivered.validSignature, true, 'the worker handoff must use the expected HMAC signature');
    assert.equal(delivered.path, '/internal/provider-executions/handoff');
    assert.deepEqual(delivered.body, {
      executionStateId,
      workspaceId,
      requestId,
      providerInstanceId: outputProviderId,
      dispatchGeneration: 1,
      actorUserId: actorId,
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(handoff.requests.length, 1, 'two workers must not duplicate a single BullMQ job');
    const completedJob = await queue.getJob(jobId);
    assert.ok(completedJob, 'completed BullMQ job should remain available for inspection');
    assert.equal(await completedJob.getState(), 'completed');
  } finally {
    await Promise.all(children.map((child) => child.close().catch(() => undefined)));
    await queue?.close().catch(() => undefined);
    if (queueConnection) await queueConnection.quit().catch(() => undefined);
    await handoff.close().catch(() => undefined);
    if (redisStarted) docker(['rm', '--force', redisContainer]);
    if (seeded) {
      const cleanup = [
        'BEGIN;',
        "DELETE FROM workspaces WHERE id = '" + workspaceId + "';",
        "DELETE FROM platform_users WHERE id = '" + actorId + "';",
        'COMMIT;',
      ].join('\n');
      runSql(postgresContainer, cleanup);
    }
  }
});
