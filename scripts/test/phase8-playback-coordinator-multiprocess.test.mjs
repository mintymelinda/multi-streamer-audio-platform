import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const processFixture = fileURLToPath(
  new URL('../../apps/api/test/fixtures/phase8-playback-coordinator-process.mjs', import.meta.url),
);

function findPostgresContainer() {
  const result = spawnSync(
    'docker',
    ['ps', '--filter', 'ancestor=postgres:18.6', '--format', '{{.ID}}'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  return result.stdout.trim().split('\n').find(Boolean) ?? null;
}

function runSql(containerId, user, password, sql) {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-e',
      'PGPASSWORD=' + password,
      containerId,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      user,
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

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function withTimeout(promise, label, timeoutMs = 15000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture server did not bind to a TCP port.'));
        return;
      }
      resolve('http://127.0.0.1:' + address.port);
    });
  });
}

function jsonResponse(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function createProviderFixtures() {
  const commands = [];
  const playSeen = deferred();
  const statusSeen = deferred();
  const releasePlay = deferred();
  const releaseStatus = deferred();

  const invidious = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/v1/videos/')) {
      response.writeHead(404).end();
      return;
    }
    jsonResponse(response, {
      title: 'Two-process playback fixture',
      author: 'Phase 8 test',
      lengthSeconds: 60,
      adaptiveFormats: [{
        type: 'audio/webm; codecs=opus',
        url: 'https://media.example.test/fixture.webm',
        bitrate: 128000,
      }],
    });
  });

  const lyrion = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const command = payload?.params?.[1];
      if (!Array.isArray(command) || typeof command[0] !== 'string') {
        response.writeHead(400).end();
        return;
      }
      commands.push(command);

      if (command[0] === 'play') {
        playSeen.resolve();
        await releasePlay.promise;
        jsonResponse(response, { result: {} });
        return;
      }
      if (command[0] === 'status') {
        statusSeen.resolve();
        await releaseStatus.promise;
        // Deliberately report active playback without identifying the logical request.
        jsonResponse(response, { result: { mode: 'play', playlist_cur_index: '0' } });
        return;
      }
      jsonResponse(response, { result: {} });
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });

  return {
    commands,
    playSeen: playSeen.promise,
    statusSeen: statusSeen.promise,
    releasePlay: releasePlay.resolve,
    releaseStatus: releaseStatus.resolve,
    async start() {
      const [invidiousUrl, lyrionUrl] = await Promise.all([
        listen(invidious),
        listen(lyrion),
      ]);
      return {
        invidiousUrl,
        lyrionBaseUrl: lyrionUrl + '/jsonrpc.js',
      };
    },
    async close() {
      invidious.closeAllConnections?.();
      lyrion.closeAllConnections?.();
      await Promise.all([
        new Promise((resolve) => invidious.close(() => resolve())),
        new Promise((resolve) => lyrion.close(() => resolve())),
      ]);
    },
  };
}

function startApiProcess(environment) {
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
        deliver({ type: 'output-error', message: 'child-emitted-invalid-json' });
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
        'API coordinator child exited before replying (' + code + '/' + signal + '). stdout=' + stdout + ' stderr=' + stderr,
      ));
    }
  });

  return {
    child,
    waitFor(predicate, timeoutMs = 15000) {
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
            reject(new Error('Timed out waiting for API coordinator child: ' + stderr));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    send(message) {
      child.stdin.write(JSON.stringify(message) + '\n');
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

function connectWorkspaceSocket(port, workspaceId) {
  const socket = new WebSocket(
    'ws://127.0.0.1:' + port + '/socket.io/?EIO=4&transport=websocket',
  );
  const received = [];
  const waiters = [];
  const packets = [];
  let namespaceRequested = false;

  function deliver(name, payload) {
    const index = waiters.findIndex(
      (waiter) => waiter.name === name && waiter.predicate(payload),
    );
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
    } else {
      received.push({ name, payload });
    }
  }

  socket.addEventListener('error', () => {
    deliver('phase8:transport-error', 'WebSocket transport error');
  });
  socket.addEventListener('close', (event) => {
    deliver('phase8:transport-close', { code: event.code, reason: event.reason });
  });
  socket.addEventListener('message', (event) => {
    const packet = String(event.data);
    packets.push(packet);
    if (packet.startsWith('0')) {
      if (!namespaceRequested) {
        namespaceRequested = true;
        socket.send('40/workspace,');
      }
      return;
    }
    if (packet === '2') {
      socket.send('3');
      return;
    }
    if (packet.startsWith('40/workspace,')) {
      socket.send('42/workspace,' + JSON.stringify([
        'workspace:subscribe',
        { workspaceId },
      ]));
      return;
    }
    if (packet.startsWith('42/workspace,')) {
      try {
        const [name, payload] = JSON.parse(packet.slice('42/workspace,'.length));
        if (typeof name === 'string') deliver(name, payload);
      } catch {
        deliver('phase8:protocol-error', packet);
      }
      return;
    }
    if (packet.startsWith('44/workspace,')) {
      deliver('phase8:connect-error', packet);
    }
  });

  return {
    waitForEvent(name, predicate = () => true, timeoutMs = 15000) {
      const index = received.findIndex(
        (event) => event.name === name && predicate(event.payload),
      );
      if (index >= 0) return Promise.resolve(received.splice(index, 1)[0].payload);
      return new Promise((resolve, reject) => {
        const waiter = {
          name,
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const current = waiters.indexOf(waiter);
            if (current >= 0) waiters.splice(current, 1);
            reject(new Error(
              'Timed out waiting for Socket.IO event ' + name + '; readyState='
                + socket.readyState + '; packets=' + packets.slice(-8).join('|'),
            ));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = new Promise((resolve) => {
        socket.addEventListener('close', resolve, { once: true });
      });
      socket.close();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    },
  };
}

test('two API processes coordinate one playback start and deliver Redis and outbox events once', async (t) => {
  if (process.env.CI !== 'true' && process.env.GITHUB_ACTIONS !== 'true') {
    t.skip('Runs in CI against the PostgreSQL service container; local tests do not require Docker.');
    return;
  }
  const containerId = findPostgresContainer();
  if (!containerId) {
    t.skip('No PostgreSQL 18.6 CI service container is available.');
    return;
  }

  assert.ok(process.env.REDIS_URL, 'CI must provide the Redis service URL.');
  const actorId = randomUUID();
  const workspaceId = randomUUID();
  const providerId = randomUUID();
  const requestId = randomUUID();
  const playerId = 'phase8-player-' + randomUUID();
  const outputId = 'phase8-output-' + randomUUID();
  const idempotencyKey = 'phase8-play-' + randomUUID();
  const sessionToken = 'phase8-session-' + randomUUID();
  const twitchId = String(Date.now()) + String(Math.floor(Math.random() * 1_000_000));
  const fixtures = createProviderFixtures();
  const processes = [];
  const sockets = [];
  let seeded = false;

  try {
    const endpoints = await fixtures.start();
    const baseUrl = endpoints.lyrionBaseUrl.replaceAll("'", "''");
    const seedSql = [
      'BEGIN;',
      "INSERT INTO platform_users (id, twitch_user_id) VALUES ('" + actorId + "', '" + twitchId + "');",
      "INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id) VALUES ('" + workspaceId + "', 'Phase 8 playback race', '" + actorId + "', '" + twitchId + "');",
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ('" + workspaceId + "', '" + actorId + "', 'owner');",
      "INSERT INTO provider_instances (id, workspace_id, provider_id, instance_key, contract_version, capabilities, connection_health, enabled, configuration) VALUES ('" + providerId + "', '" + workspaceId + "', 'lyrion', 'phase8-" + providerId + "', 1, '{\"playback\":true}'::jsonb, 'healthy', true, jsonb_build_object('baseUrl', '" + baseUrl + "'));",
      "INSERT INTO provider_output_assignments (workspace_id, provider_instance_id, output_id, player_id, assigned_by, active) VALUES ('" + workspaceId + "', '" + providerId + "', '" + outputId + "', '" + playerId + "', '" + actorId + "', true);",
      'COMMIT;',
    ].join('\n');
    runSql(containerId, 'platform_bootstrap', 'ci-bootstrap-only', seedSql);
    seeded = true;

    const environment = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://platform_runtime:local-runtime-only@127.0.0.1:5432/platform',
      INVIDIOUS_INSTANCE_URL: endpoints.invidiousUrl,
      LYRION_ALLOWED_HOSTS: '127.0.0.1',
      REDIS_URL: process.env.REDIS_URL,
      PHASE8_REALTIME_USER_ID: actorId,
      PHASE8_REALTIME_WORKSPACE_ID: workspaceId,
      PHASE8_REALTIME_SESSION_TOKEN: sessionToken,
    };
    const processA = startApiProcess(environment);
    const processB = startApiProcess(environment);
    processes.push(processA, processB);
    const [readyA, readyB] = await Promise.all([
      processA.waitFor((message) => message.type === 'ready' || message.type === 'boot-error'),
      processB.waitFor((message) => message.type === 'ready' || message.type === 'boot-error'),
    ]);
    assert.equal(readyA.type, 'ready', readyA.message);
    assert.equal(readyB.type, 'ready', readyB.message);
    assert.ok(Number.isInteger(readyA.port) && readyA.port > 0);
    assert.ok(Number.isInteger(readyB.port) && readyB.port > 0);

    const socketA = connectWorkspaceSocket(readyA.port, workspaceId);
    const socketB = connectWorkspaceSocket(readyB.port, workspaceId);
    sockets.push(socketA, socketB);
    const [subscriptionA, subscriptionB] = await Promise.all([
      socketA.waitForEvent('phase8:ready'),
      socketB.waitForEvent('phase8:ready'),
    ]);
    assert.equal(subscriptionA.workspaceId, workspaceId);
    assert.equal(subscriptionB.workspaceId, workspaceId);

    const input = {
      workspaceId,
      providerInstanceId: providerId,
      playerId,
      outputId,
      requestId,
      command: 'play',
      idempotencyKey,
      actorId,
      payload: {
        sourceProviderId: 'youtube',
        mediaId: 'dQw4w9WgXcQ',
      },
    };
    processA.send({ type: 'execute', commandId: 'first', input });
    await withTimeout(fixtures.playSeen, 'the first provider play command');

    processB.send({ type: 'execute', commandId: 'duplicate', input });
    await withTimeout(fixtures.statusSeen, 'the duplicate provider status reconciliation');

    fixtures.releasePlay();
    const first = await processA.waitFor(
      (message) => message.type === 'result' && message.commandId === 'first',
    );
    assert.equal(first.result.status, 'completed');

    const completedSql = "SELECT status || ':' || COALESCE(result->>'outcome', '') || ':' || fencing_token::text FROM playback_operations WHERE workspace_id = '" + workspaceId + "' AND idempotency_key = '" + idempotencyKey + "'";
    const completed = runSql(
      containerId,
      'platform_bootstrap',
      'ci-bootstrap-only',
      completedSql,
    );
    assert.match(completed, /^completed:started:\d+$/);

    fixtures.releaseStatus();
    const duplicate = await processB.waitFor(
      (message) => message.type === 'result' && message.commandId === 'duplicate',
    );
    assert.equal(duplicate.result.status, 'completed');
    assert.equal(duplicate.result.result?.outcome, 'started');

    const finalState = runSql(
      containerId,
      'platform_bootstrap',
      'ci-bootstrap-only',
      completedSql,
    );
    assert.match(finalState, /^completed:started:\d+$/);
    assert.equal(fixtures.commands.filter((command) => command[0] === 'play').length, 1);
    assert.equal(fixtures.commands.filter((command) => command[0] === 'status').length, 1);

    const redisProbeId = randomUUID();
    processA.send({ type: 'broadcast', eventId: redisProbeId });
    await processA.waitFor(
      (message) => message.type === 'broadcasted' && message.eventId === redisProbeId,
    );
    const [redisProbeA, redisProbeB] = await Promise.all([
      socketA.waitForEvent('phase8:redis-probe', (payload) => payload?.id === redisProbeId),
      socketB.waitForEvent('phase8:redis-probe', (payload) => payload?.id === redisProbeId),
    ]);
    assert.equal(redisProbeA.id, redisProbeId);
    assert.equal(redisProbeB.id, redisProbeId);
    await Promise.all([
      assert.rejects(
        socketA.waitForEvent('phase8:redis-probe', (payload) => payload?.id === redisProbeId, 250),
        /Timed out waiting for Socket.IO event/,
      ),
      assert.rejects(
        socketB.waitForEvent('phase8:redis-probe', (payload) => payload?.id === redisProbeId, 250),
        /Timed out waiting for Socket.IO event/,
      ),
    ]);

    const outboxEventId = randomUUID();
    const outboxPayload = JSON.stringify({
      id: outboxEventId,
      workspaceId,
      type: 'request.status.changed',
      payload: { requestId, from: 'playing', to: 'completed' },
    }).replaceAll("'", "''");
    runSql(
      containerId,
      'platform_bootstrap',
      'ci-bootstrap-only',
      "SELECT pg_notify('platform_outbox_event', '" + outboxPayload + "')",
    );
    const [outboxA, outboxB] = await Promise.all([
      socketA.waitForEvent('workspace:event', (payload) => payload?.id === outboxEventId),
      socketB.waitForEvent('workspace:event', (payload) => payload?.id === outboxEventId),
    ]);
    for (const event of [outboxA, outboxB]) {
      assert.equal(event.type, 'request.status.changed');
      assert.deepEqual(event.payload, { requestId, from: 'playing', to: 'completed' });
      assert.equal(event.refreshRequired, false);
    }
    await Promise.all([
      assert.rejects(
        socketA.waitForEvent('workspace:event', (payload) => payload?.id === outboxEventId, 250),
        /Timed out waiting for Socket.IO event/,
      ),
      assert.rejects(
        socketB.waitForEvent('workspace:event', (payload) => payload?.id === outboxEventId, 250),
        /Timed out waiting for Socket.IO event/,
      ),
    ]);
  } finally {
    fixtures.releasePlay();
    fixtures.releaseStatus();
    await Promise.all(sockets.map((socket) => socket.close().catch(() => undefined)));
    await Promise.all(processes.map((process) => process.close().catch(() => undefined)));
    await fixtures.close();
    if (seeded) {
      const cleanup = [
        'BEGIN;',
        "DELETE FROM workspaces WHERE id = '" + workspaceId + "';",
        "DELETE FROM platform_users WHERE id = '" + actorId + "';",
        'COMMIT;',
      ].join('\n');
      runSql(containerId, 'platform_bootstrap', 'ci-bootstrap-only', cleanup);
    }
  }
});
