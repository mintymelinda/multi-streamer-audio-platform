import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import test from 'node:test';

const workerFixture = fileURLToPath(
  new URL('../../apps/worker/test/fixtures/phase8-provider-execution-worker-process.mjs', import.meta.url),
);
const apiFixture = fileURLToPath(
  new URL('../../apps/api/test/fixtures/phase8-provider-execution-api-process.mjs', import.meta.url),
);
const handoffSecret = 'phase8-live-api-handoff-secret-with-more-than-32-bytes';
const workerConcurrency = 4;
const parallelWorkspaces = workerConcurrency + 1;

function findPostgresContainer() {
  const result = spawnSync(
    'docker',
    ['ps', '--filter', 'ancestor=postgres:18.6', '--format', '{{.ID}}'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  return result.stdout.trim().split('\n').find(Boolean) ?? null;
}

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('Docker fixture command failed: ' + result.stderr.trim());
  }
  return result.stdout.trim();
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Provider fixture did not bind to a TCP port.'));
        return;
      }
      resolve('http://127.0.0.1:' + address.port);
    });
  });
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

function createProviderFixtures(expectedPlayCount) {
  const playSeen = deferred();
  const releasePlay = deferred();
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/v1/videos/')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          title: 'Live API process fixture',
          author: 'Phase 8',
          lengthSeconds: 60,
          adaptiveFormats: [{
            type: 'audio/webm; codecs=opus',
            url: 'https://media.example.test/phase8.webm',
            bitrate: 128000,
          }],
        }));
        return;
      }

      if (request.method !== 'POST' || url.pathname !== '/jsonrpc.js') {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const playerId = body?.params?.[0];
      const command = body?.params?.[1];
      if (typeof playerId !== 'string' || !Array.isArray(command)) {
        response.writeHead(400).end();
        return;
      }
      requests.push({ playerId, command });
      if (command[0] === 'play') {
        if (requests.filter((entry) => entry.command[0] === 'play').length === expectedPlayCount) {
          playSeen.resolve([...requests]);
        }
        await releasePlay.promise;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: {} }));
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });

  return {
    requests,
    playSeen: Promise.race([
      playSeen.promise,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('Only ' + requests.filter((entry) => entry.command[0] === 'play').length
          + ' of ' + expectedPlayCount + ' provider play commands reached the live API.')),
        25000,
      )),
    ]),
    async start() {
      return listen(server);
    },
    release() {
      releasePlay.resolve();
    },
    async close() {
      releasePlay.resolve();
      server.closeAllConnections?.();
      if (server.listening) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
    },
  };
}

function startProcess(script, environment, label) {
  const child = spawn(process.execPath, [script], {
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
    stdout = (stdout + chunk).slice(-10000);
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        deliver(JSON.parse(line));
      } catch {
        deliver({ type: 'output-error', message: label + ' emitted invalid JSON' });
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-10000);
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
        label + ' exited before replying (' + code + '/' + signal + '). stdout='
          + stdout + ' stderr=' + stderr,
      ));
    }
  });

  return {
    child,
    waitFor(predicate, timeoutMs = 25000) {
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
            reject(new Error('Timed out waiting for ' + label + '. stdout=' + stdout + ' stderr=' + stderr));
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

test('two BullMQ workers hand off five independent requests through the real signed playback API', async (t) => {
  if (process.env.CI !== 'true' && process.env.GITHUB_ACTIONS !== 'true') {
    t.skip('Runs in CI with disposable Redis and the PostgreSQL service container.');
    return;
  }
  const postgresContainer = findPostgresContainer();
  if (!postgresContainer) {
    t.skip('No PostgreSQL 18.6 CI service container is available.');
    return;
  }

  const redisContainer = 'phase8-live-api-redis-' + process.pid + '-' + randomUUID().slice(0, 8);
  const fixtures = Array.from({ length: parallelWorkspaces }, () => ({
    actorId: randomUUID(),
    workspaceId: randomUUID(),
    sourceProviderId: randomUUID(),
    outputProviderId: randomUUID(),
    requestId: randomUUID(),
    executionStateId: randomUUID(),
    outputId: 'phase8-api-output-' + randomUUID(),
    playerId: 'phase8-api-player-' + randomUUID(),
    twitchId: String(Date.now()) + String(Math.floor(Math.random() * 1_000_000)),
    mediaId: 'dQw4w9WgXcQ',
  }));
  const jobIds = fixtures.map((fixture) => 'phase8-live-api-' + fixture.executionStateId + '-1');
  const handoffSecret = 'phase8-live-api-handoff-secret-with-more-than-32-bytes';
  const provider = createProviderFixtures(parallelWorkspaces);
  const processes = [];
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

    const providerUrl = await provider.start();
    const seedStatements = ['BEGIN;'];
    for (const [index, fixture] of fixtures.entries()) {
      const lyrionUrl = providerUrl + '/jsonrpc.js';
      seedStatements.push(
        "INSERT INTO platform_users (id, twitch_user_id) VALUES ('" + fixture.actorId + "', '" + fixture.twitchId + "');",
        "INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id) VALUES ('" + fixture.workspaceId + "', 'Phase 8 live API workspace " + index + "', '" + fixture.actorId + "', '" + fixture.twitchId + "');",
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ('" + fixture.workspaceId + "', '" + fixture.actorId + "', 'owner', 'active');",
        "INSERT INTO provider_instances (id, workspace_id, provider_id, instance_key, contract_version, capabilities, connection_health, enabled) VALUES ('" + fixture.sourceProviderId + "', '" + fixture.workspaceId + "', 'youtube', 'phase8-source-" + fixture.sourceProviderId + "', 1, '{\"resolve\":true}'::jsonb, 'healthy', true);",
        "INSERT INTO provider_instances (id, workspace_id, provider_id, instance_key, contract_version, capabilities, connection_health, enabled, configuration) VALUES ('" + fixture.outputProviderId + "', '" + fixture.workspaceId + "', 'lyrion', 'phase8-output-" + fixture.outputProviderId + "', 1, '{\"playback\":true,\"supportedSourceProviderIds\":[\"youtube\"]}'::jsonb, 'healthy', true, jsonb_build_object('baseUrl', '" + lyrionUrl + "'));",
        "INSERT INTO provider_output_assignments (workspace_id, provider_instance_id, output_id, player_id, assigned_by, active) VALUES ('" + fixture.workspaceId + "', '" + fixture.outputProviderId + "', '" + fixture.outputId + "', '" + fixture.playerId + "', '" + fixture.actorId + "', true);",
        "INSERT INTO media_requests (id, workspace_id, source, submitted_by_user_id, provider, media_id, media_url, title, status) VALUES ('" + fixture.requestId + "', '" + fixture.workspaceId + "', 'dashboard', '" + fixture.actorId + "', 'youtube', '" + fixture.mediaId + "', 'https://www.youtube.com/watch?v=" + fixture.mediaId + "', 'Phase 8 live API " + index + "', 'queued');",
        "INSERT INTO logical_queue_entries (workspace_id, request_id, priority, sequence) VALUES ('" + fixture.workspaceId + "', '" + fixture.requestId + "', 0, 1);",
        "INSERT INTO provider_execution_states (id, workspace_id, request_id, provider_instance_id, state, dispatch_generation) VALUES ('" + fixture.executionStateId + "', '" + fixture.workspaceId + "', '" + fixture.requestId + "', '" + fixture.outputProviderId + "', 'queued', 1);",
      );
    }
    seedStatements.push('COMMIT;');
    runSql(postgresContainer, seedStatements.join('\n'));
    seeded = true;

    const common = {
      ...process.env,
      NODE_ENV: 'test',
      PROVIDER_EXECUTION_HANDOFF_SECRET: handoffSecret,
      INVIDIOUS_INSTANCE_URL: providerUrl,
      LYRION_ALLOWED_HOSTS: '127.0.0.1',
    };
    const api = startProcess(apiFixture, {
      ...common,
      DATABASE_URL: 'postgresql://platform_runtime:local-runtime-only@127.0.0.1:5432/platform',
    }, 'live playback API');
    processes.push(api);
    const apiReady = await api.waitFor((message) => message.type === 'ready' || message.type === 'boot-error');
    assert.equal(apiReady.type, 'ready', JSON.stringify(apiReady));

    const workerEnvironment = {
      ...common,
      PROVIDER_EXECUTION_DATABASE_URL: 'postgresql://platform_provider_worker:local-provider-worker-only@127.0.0.1:5432/platform',
      REDIS_URL: redisUrl,
      PROVIDER_EXECUTION_HANDOFF_URL: apiReady.handoffUrl,
    };
    delete workerEnvironment.PROVIDER_EXECUTION_DATABASE_URL_FILE;
    delete workerEnvironment.REDIS_URL_FILE;
    delete workerEnvironment.PROVIDER_EXECUTION_HANDOFF_SECRET_FILE;
    const workerA = startProcess(workerFixture, workerEnvironment, 'provider worker A');
    const workerB = startProcess(workerFixture, workerEnvironment, 'provider worker B');
    processes.push(workerA, workerB);
    const workerReady = await Promise.all([
      workerA.waitFor((message) => message.type === 'ready' || message.type === 'boot-error'),
      workerB.waitFor((message) => message.type === 'ready' || message.type === 'boot-error'),
    ]);
    assert.deepEqual(workerReady.map((message) => message.type), ['ready', 'ready']);

    queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue('provider-execution', { connection: queueConnection });
    await queue.waitUntilReady();
    const jobs = await Promise.all(fixtures.map((fixture, index) =>
      queue.add('provider-execution', {
        executionStateId: fixture.executionStateId,
        workspaceId: fixture.workspaceId,
        requestId: fixture.requestId,
        providerInstanceId: fixture.outputProviderId,
        dispatchGeneration: 1,
      }, {
        jobId: jobIds[index],
        attempts: 1,
        removeOnComplete: false,
      }),
    ));
    const duplicate = await queue.add('provider-execution', {
      executionStateId: fixtures[0].executionStateId,
      workspaceId: fixtures[0].workspaceId,
      requestId: fixtures[0].requestId,
      providerInstanceId: fixtures[0].outputProviderId,
      dispatchGeneration: 1,
    }, {
      jobId: jobIds[0],
      attempts: 1,
      removeOnComplete: false,
    });
    assert.equal(duplicate.id, jobs[0].id, 'duplicate dispatch must reuse the same BullMQ job ID');

    await provider.playSeen;
    const playEntries = provider.requests.filter((entry) => entry.command[0] === 'play');
    assert.equal(playEntries.length, parallelWorkspaces);
    assert.deepEqual(
      playEntries.map((entry) => entry.playerId).sort(),
      fixtures.map((fixture) => fixture.playerId).sort(),
    );

    provider.release();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const states = await Promise.all(jobs.map(async (job) => {
        const current = await queue.getJob(job.id);
        return current ? current.getState() : 'missing';
      }));
      if (states.every((state) => state === 'completed') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const job of jobs) {
      const current = await queue.getJob(job.id);
      assert.ok(current, 'completed provider execution job must remain inspectable');
      assert.equal(await current.getState(), 'completed');
    }

    const workspaceIds = fixtures.map((fixture) => "'" + fixture.workspaceId + "'").join(', ');
    const executionIds = fixtures.map((fixture) => "'" + fixture.executionStateId + "'").join(', ');
    const states = runSql(
      postgresContainer,
      "SELECT count(*) FILTER (WHERE r.status = 'playing')::text || ':' || "
        + "count(*) FILTER (WHERE e.state = 'playing')::text || ':' || "
        + "count(*) FILTER (WHERE operation.status = 'completed' AND operation.result->>'outcome' = 'started')::text || ':' || "
        + "count(DISTINCT session.id)::text "
        + "FROM media_requests r "
        + "JOIN provider_execution_states e ON e.workspace_id = r.workspace_id AND e.request_id = r.id "
        + "JOIN playback_operations operation ON operation.workspace_id = r.workspace_id AND operation.request_id = r.id "
        + "JOIN playback_sessions session ON session.workspace_id = r.workspace_id AND session.request_id = r.id "
        + "WHERE r.workspace_id IN (" + workspaceIds + ") AND e.id IN (" + executionIds + ")",
    );
    assert.equal(states, parallelWorkspaces + ':' + parallelWorkspaces + ':' + parallelWorkspaces + ':' + parallelWorkspaces);
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(provider.requests.filter((entry) => entry.command[0] === 'play').length, parallelWorkspaces);
  } finally {
    provider.release();
    await Promise.all(processes.reverse().map((process) => process.close().catch(() => undefined)));
    await queue?.close().catch(() => undefined);
    if (queueConnection) await queueConnection.quit().catch(() => undefined);
    await provider.close().catch(() => undefined);
    if (redisStarted) docker(['rm', '--force', redisContainer]);
    if (seeded) {
      const workspaceIds = fixtures.map((fixture) => "'" + fixture.workspaceId + "'").join(', ');
      const actorIds = fixtures.map((fixture) => "'" + fixture.actorId + "'").join(', ');
      const cleanup = [
        'BEGIN;',
        'DELETE FROM workspaces WHERE id IN (' + workspaceIds + ');',
        'DELETE FROM platform_users WHERE id IN (' + actorIds + ');',
        'COMMIT;',
      ].join('\n');
      runSql(postgresContainer, cleanup);
    }
  }
});
