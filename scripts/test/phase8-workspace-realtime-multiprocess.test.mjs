import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const processFixture = fileURLToPath(
  new URL('../../apps/api/test/fixtures/phase8-workspace-realtime-process.mjs', import.meta.url),
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
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        deliver(JSON.parse(line));
      } catch {
        deliver({ type: 'output-error', message: 'API realtime process emitted invalid JSON' });
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
        'API realtime child exited before replying (' + code + '/' + signal + '). stdout='
          + stdout + ' stderr=' + stderr,
      ));
    }
  });

  return {
    child,
    send(message) {
      if (!child.stdin.writable) throw new Error('API realtime process stdin is not writable.');
      child.stdin.write(JSON.stringify(message) + '\n');
    },
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
            reject(new Error('Timed out waiting for API realtime process. stdout=' + stdout + ' stderr=' + stderr));
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

test('workspace realtime fan-out stays tenant-isolated across API processes and resumes after resubscription', async (t) => {
  if (process.env.CI !== 'true' && process.env.GITHUB_ACTIONS !== 'true') {
    t.skip('Runs in CI against the PostgreSQL service container; local tests do not require Docker.');
    return;
  }

  const postgresContainer = findPostgresContainer();
  if (!postgresContainer) {
    t.skip('No PostgreSQL 18.6 CI service container is available.');
    return;
  }

  const actorA = randomUUID();
  const actorB = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const twitchA = String(Date.now()) + String(Math.floor(Math.random() * 1_000_000));
  const twitchB = String(Date.now() + 1) + String(Math.floor(Math.random() * 1_000_000));
  const sessionA = 'phase8-session-' + randomUUID();
  const sessionB = 'phase8-session-' + randomUUID();
  const children = [];
  let seeded = false;

  try {
    const seed = [
      'BEGIN;',
      "INSERT INTO platform_users (id, twitch_user_id) VALUES ('" + actorA + "', '" + twitchA + "');",
      "INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id) VALUES ('" + workspaceA + "', 'Phase 8 realtime workspace A', '" + actorA + "', '" + twitchA + "');",
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ('" + workspaceA + "', '" + actorA + "', 'owner', 'active');",
      "INSERT INTO platform_users (id, twitch_user_id) VALUES ('" + actorB + "', '" + twitchB + "');",
      "INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id) VALUES ('" + workspaceB + "', 'Phase 8 realtime workspace B', '" + actorB + "', '" + twitchB + "');",
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ('" + workspaceB + "', '" + actorB + "', 'owner', 'active');",
      'COMMIT;',
    ].join('\n');
    runSql(postgresContainer, seed);
    seeded = true;

    const environmentA = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://platform_runtime:local-runtime-only@127.0.0.1:5432/platform',
      PHASE8_REALTIME_USER_ID: actorA,
      PHASE8_REALTIME_WORKSPACE_ID: workspaceA,
      PHASE8_REALTIME_SESSION_TOKEN: sessionA,
    };
    const environmentB = {
      ...environmentA,
      PHASE8_REALTIME_USER_ID: actorB,
      PHASE8_REALTIME_WORKSPACE_ID: workspaceB,
      PHASE8_REALTIME_SESSION_TOKEN: sessionB,
    };
    delete environmentA.DATABASE_URL_FILE;
    delete environmentB.DATABASE_URL_FILE;

    const first = startApiProcess({ ...environmentA, PHASE8_REALTIME_NODE_ID: 'api-a' });
    const second = startApiProcess({ ...environmentA, PHASE8_REALTIME_NODE_ID: 'api-b' });
    const foreign = startApiProcess({ ...environmentB, PHASE8_REALTIME_NODE_ID: 'api-c' });
    children.push(first, second, foreign);
    const ready = await Promise.all([
      first.waitFor((message) => message.type === 'ready' || message.type === 'boot-error'),
      second.waitFor((message) => message.type === 'ready' || message.type === 'boot-error'),
      foreign.waitFor((message) => message.type === 'ready' || message.type === 'boot-error'),
    ]);
    assert.deepEqual(ready.map((message) => message.type), ['ready', 'ready', 'ready']);
    assert.deepEqual(ready.map((message) => message.nodeId).sort(), ['api-a', 'api-b', 'api-c']);

    const eventA = {
      id: randomUUID(),
      workspaceId: workspaceA,
      type: 'request.status.changed',
      payload: { requestId: randomUUID(), from: 'queued', to: 'completed' },
    };
    const publish = (event) => {
      const payload = JSON.stringify(event).replaceAll("'", "''");
      runSql(postgresContainer, "SELECT pg_notify('platform_outbox_event', '" + payload + "');");
    };
    const receive = (processHandle, event) =>
      processHandle.waitFor((message) => message.type === 'event' && message.payload?.id === event.id);
    const rejectEvent = (processHandle, event) =>
      assert.rejects(
        processHandle.waitFor((message) => message.type === 'event' && message.payload?.id === event.id, 500),
        /Timed out waiting for API realtime process/,
      );

    publish(eventA);
    const [firstEvent, secondEvent] = await Promise.all([receive(first, eventA), receive(second, eventA)]);
    for (const message of [firstEvent, secondEvent]) {
      assert.equal(message.event, 'workspace:event');
      assert.deepEqual(message.payload, {
        id: eventA.id,
        type: eventA.type,
        payload: eventA.payload,
        refreshRequired: false,
      });
    }
    assert.deepEqual([firstEvent.nodeId, secondEvent.nodeId].sort(), ['api-a', 'api-b']);
    await Promise.all([rejectEvent(first, eventA), rejectEvent(second, eventA), rejectEvent(foreign, eventA)]);

    const eventB = {
      id: randomUUID(),
      workspaceId: workspaceB,
      type: 'request.status.changed',
      payload: { requestId: randomUUID(), from: 'queued', to: 'completed' },
    };
    publish(eventB);
    const foreignEvent = await receive(foreign, eventB);
    assert.equal(foreignEvent.event, 'workspace:event');
    assert.deepEqual(foreignEvent.payload, {
      id: eventB.id,
      type: eventB.type,
      payload: eventB.payload,
      refreshRequired: false,
    });
    await Promise.all([rejectEvent(first, eventB), rejectEvent(second, eventB)]);

    first.send({ type: 'disconnect' });
    const disconnected = await first.waitFor((message) => message.type === 'disconnected');
    assert.equal(disconnected.nodeId, 'api-a');
    const eventWhileDisconnected = {
      id: randomUUID(),
      workspaceId: workspaceA,
      type: 'request.status.changed',
      payload: { requestId: randomUUID(), from: 'queued', to: 'failed' },
    };
    publish(eventWhileDisconnected);
    await receive(second, eventWhileDisconnected);
    await Promise.all([
      rejectEvent(first, eventWhileDisconnected),
      rejectEvent(foreign, eventWhileDisconnected),
    ]);

    first.send({ type: 'reconnect' });
    const reconnected = await first.waitFor((message) => message.type === 'reconnected');
    assert.equal(reconnected.nodeId, 'api-a');
    assert.equal(reconnected.cursor.workspaceId, workspaceA);
    assert.equal(typeof reconnected.cursor.eventId, 'string');
    assert.ok(Number.isSafeInteger(reconnected.cursor.sequence));
    const eventAfterReconnect = {
      id: randomUUID(),
      workspaceId: workspaceA,
      type: 'request.status.changed',
      payload: { requestId: randomUUID(), from: 'failed', to: 'queued' },
    };
    publish(eventAfterReconnect);
    const [resumedFirstEvent, resumedSecondEvent] = await Promise.all([
      receive(first, eventAfterReconnect),
      receive(second, eventAfterReconnect),
    ]);
    assert.equal(resumedFirstEvent.payload.id, eventAfterReconnect.id);
    assert.equal(resumedSecondEvent.payload.id, eventAfterReconnect.id);
    await Promise.all([
      rejectEvent(first, eventAfterReconnect),
      rejectEvent(second, eventAfterReconnect),
      rejectEvent(foreign, eventAfterReconnect),
    ]);
  } finally {
    await Promise.all(children.map((child) => child.close().catch(() => undefined)));
    if (seeded) {
      const cleanup = [
        'BEGIN;',
        "DELETE FROM workspaces WHERE id IN ('" + workspaceA + "', '" + workspaceB + "');",
        "DELETE FROM platform_users WHERE id IN ('" + actorA + "', '" + actorB + "');",
        'COMMIT;',
      ].join('\n');
      runSql(postgresContainer, cleanup);
    }
  }
});
