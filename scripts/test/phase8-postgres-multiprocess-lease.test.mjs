import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

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

function startSqlSession(containerId, sql) {
  const child = spawn(
    'docker',
    [
      'exec',
      '-e',
      'PGPASSWORD=local-runtime-only',
      containerId,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'platform_runtime',
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
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stdout = [];
  const stderr = [];
  let readySettled = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      if (!readySettled && Buffer.concat(stdout).toString('utf8').split('\n').includes('lease-held')) {
        readySettled = true;
        readyResolve();
      }
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      };
      if (!readySettled) {
        readySettled = true;
        readyReject(new Error('Lease-holding PostgreSQL session ended before acquiring its lease: ' + result.stderr));
      }
      if (code === 0) resolve(result);
      else reject(new Error('PostgreSQL session failed: ' + result.stderr));
    });
  });
  done.catch(() => undefined);
  return { child, ready, done };
}

test('two independent PostgreSQL sessions cannot acquire the same live playback lease', async (t) => {
  if (process.env.CI !== 'true' && process.env.GITHUB_ACTIONS !== 'true') {
    t.skip('Runs in CI against the PostgreSQL service container; local tests do not require Docker.');
    return;
  }
  const containerId = findPostgresContainer();
  if (!containerId) {
    t.skip('No PostgreSQL 18.6 CI service container is available.');
    return;
  }

  const actorId = randomUUID();
  const workspaceId = randomUUID();
  const providerId = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const leaseTokenA = randomUUID();
  const leaseTokenB = randomUUID();
  const twitchId = String(Date.now()) + String(Math.floor(Math.random() * 1_000_000));
  const playerId = 'phase8-concurrent-player';

  const fixture = `
    BEGIN;
    INSERT INTO public.platform_users (id, twitch_user_id)
    VALUES ('${actorId}', '${twitchId}');
    INSERT INTO public.workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES ('${workspaceId}', 'Phase 8 lease race', '${actorId}', '${twitchId}');
    INSERT INTO public.workspace_memberships (workspace_id, user_id, role)
    VALUES ('${workspaceId}', '${actorId}', 'owner');
    INSERT INTO public.provider_instances (
      id, workspace_id, provider_id, instance_key, contract_version
    ) VALUES (
      '${providerId}', '${workspaceId}', 'youtube', 'phase8-${providerId}', 1
    );
    COMMIT;
  `;
  runSql(containerId, 'platform_bootstrap', 'ci-bootstrap-only', fixture);

  const leaseSql = (ownerId, token) => `
    BEGIN;
    SET LOCAL app.user_id = '${actorId}';
    SET LOCAL app.workspace_id = '${workspaceId}';
    INSERT INTO public.playback_leases AS lease (
      workspace_id, provider_instance_id, player_id, lease_owner_id,
      lease_token, fencing_token, expires_at
    ) VALUES (
      '${workspaceId}', '${providerId}', '${playerId}', '${ownerId}',
      '${token}', 1, now() + interval '1 minute'
    )
    ON CONFLICT (workspace_id, provider_instance_id, player_id)
    DO UPDATE SET
      lease_owner_id = EXCLUDED.lease_owner_id,
      lease_token = EXCLUDED.lease_token,
      fencing_token = lease.fencing_token + 1,
      expires_at = EXCLUDED.expires_at
    WHERE lease.expires_at <= now()
    RETURNING fencing_token;
  `;
  let first;
  let second;
  try {
    first = startSqlSession(
      containerId,
      leaseSql(ownerA, leaseTokenA) + `
        SELECT 'lease-held';
        SELECT pg_sleep(2);
        COMMIT;
      `,
    );
    await first.ready;

    second = startSqlSession(
      containerId,
      leaseSql(ownerB, leaseTokenB) + `
        SELECT 'lease-held';
        COMMIT;
      `,
    );
    const [firstResult, secondResult] = await Promise.all([first.done, second.done]);

    assert.equal(firstResult.code, 0);
    assert.equal(firstResult.stdout.split('\n')[0], '1');
    assert.equal(secondResult.code, 0);
    assert.equal(secondResult.stdout, 'lease-held');

    const stored = runSql(
      containerId,
      'platform_bootstrap',
      'ci-bootstrap-only',
      `SELECT fencing_token::text || ':' || lease_owner_id::text
         FROM public.playback_leases
        WHERE workspace_id = '${workspaceId}'
          AND provider_instance_id = '${providerId}'
          AND player_id = '${playerId}'`,
    );
    assert.equal(stored, '1:' + ownerA);
  } finally {
    first?.child.kill('SIGTERM');
    second?.child.kill('SIGTERM');
    runSql(
      containerId,
      'platform_bootstrap',
      'ci-bootstrap-only',
      `BEGIN;
       DELETE FROM public.workspaces WHERE id = '${workspaceId}';
       DELETE FROM public.platform_users WHERE id = '${actorId}';
       COMMIT;`,
    );
  }
});
