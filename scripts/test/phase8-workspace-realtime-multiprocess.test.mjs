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
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
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

test('two API processes broadcast one PostgreSQL outbox notification to their local workspace sockets', async (t) => {
  if (process.env.CI !== 'true' && process.env.GITHUB_ACTIONS !== 'true') {
    t.skip('Runs in CI against the PostgreSQL service container; local tests do not require Docker.');
    return;
  }

  const postgresContainer = findPostgresContainer();
  if (!postgresContainer) {
    t.skip('No PostgreSQL 18.6 CI service container is available.');
    return;
  }

  const actorId = randomUUID();
  const workspaceId = randomUUID();
  const eventId = randomUUID();
  const requestId = randomUUID();
  const twitchId = String(Date.now()) + String(Math.floor(Math.random() * 1_000_000));
  const sessionToken = 'phase8-session-' + randomUUID();
  const children = [];
  let seeded = false;

  try {
    const seed = [
      'BEGIN;',
      "INSERT INTO platform_users (id, twitch_user_id) VALUES ('" + actorId + "', '" + twitchId + "');",
      "INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id) VALUES ('" + workspaceId + "', 'Phase 8 realtime fanout', '" + actorId + "', '" + twitchId + "');",
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ('" + workspaceId + "', '" + actorId + "', 'owner', 'active');",
      'COMMIT;',
    ].join('\n');
    runSql(postgresContainer, seed);
    seeded = true;

    const commonEnvironment = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://platform_runtime:local-runtime-only@127.0.0.1:5432/platform',
      PHASE8_REALTIME_USER_ID: actorId,
      PHASE8_REALTIME_WORKSPACE_ID: workspaceId,
      PHASE8_REALTIME_SESSION_TOKEN: sessionToken,
    };
    delete commonEnvironment.DATABASE_URL_FILE;
    const first = startApiProcess({
      ...commonEnvironment,
      PHASE8_REALTIME_NODE_ID: 'api-a',
    });
    const second = startApiProcess({
      ...commonEnvironment,
      PHASE8_REALTIME_NODE_ID: 'api-b',
    });
    children.push(first, second);
    const ready = await Promise.all([
      first.waitFor((message) => message.type === 'ready' || message.type === 'boot-error'),
      second.waitFor((message) => message.type === 'ready' || message.type === 'boot-error'),
    ]);
    assert.deepEqual(ready.map((message) => message.type), ['ready', 'ready']);
    assert.deepEqual(ready.map((message) => message.nodeId).sort(), ['api-a', 'api-b']);

    const event = {
      id: eventId,
      workspaceId,
      type: 'request.status.changed',
      payload: {
        requestId,
        from: 'queued',
        to: 'completed',
      },
    };
    const payload = JSON.stringify(event).replaceAll("'", "''");
    runSql(
      postgresContainer,
      "SELECT pg_notify('platform_outbox_event', '" + payload + "');",
    );

    const [firstEvent, secondEvent] = await Promise.all([
      first.waitFor((message) => message.type === 'event' && message.payload?.id === eventId),
      second.waitFor((message) => message.type === 'event' && message.payload?.id === eventId),
    ]);
    for (const message of [firstEvent, secondEvent]) {
      assert.equal(message.event, 'workspace:event');
      assert.deepEqual(message.payload, {
        id: eventId,
        type: 'request.status.changed',
        payload: event.payload,
        refreshRequired: false,
      });
    }
    assert.deepEqual(
      [firstEvent.nodeId, secondEvent.nodeId].sort(),
      ['api-a', 'api-b'],
      'each independent API process must emit the outbox event to its local socket room',
    );
  } finally {
    await Promise.all(children.map((child) => child.close().catch(() => undefined)));
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
