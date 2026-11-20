import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
    throw new Error('PostgreSQL OAuth-state fixture command failed: ' + result.stderr.trim());
  }
  return result.stdout.trim();
}

function stateHash() {
  return createHash('sha256').update(randomUUID() + randomUUID()).digest('hex');
}

test('platform runtime can create and consume both valid Twitch OAuth state shapes under forced RLS', (t) => {
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
  const twitchId = String(Date.now()) + String(Math.floor(Math.random() * 1_000_000));
  const loginHash = stateHash();
  const integrationHash = stateHash();

  try {
    runSql(
      containerId,
      'platform_bootstrap',
      'ci-bootstrap-only',
      `BEGIN;
       INSERT INTO public.platform_users (id, twitch_user_id)
       VALUES ('${actorId}', '${twitchId}');
       INSERT INTO public.workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
       VALUES ('${workspaceId}', 'Twitch OAuth state RLS', '${actorId}', '${twitchId}');
       INSERT INTO public.workspace_memberships (workspace_id, user_id, role)
       VALUES ('${workspaceId}', '${actorId}', 'owner');
       COMMIT;`,
    );

    const loginInsert = runSql(
      containerId,
      'platform_runtime',
      'local-runtime-only',
      `INSERT INTO public.twitch_oauth_states (
         state_hash, return_path, purpose, actor_user_id, workspace_id, expires_at
       ) VALUES (
         '${loginHash}', '/dashboard', 'login', NULL, NULL, now() + interval '10 minutes'
       );
       SELECT purpose || ':' || (actor_user_id IS NULL)::text || ':' || (workspace_id IS NULL)::text
         FROM public.twitch_oauth_states WHERE state_hash = '${loginHash}';`,
    );
    assert.equal(loginInsert, 'login:true:true');

    const loginConsumed = runSql(
      containerId,
      'platform_runtime',
      'local-runtime-only',
      `WITH consumed AS (
         UPDATE public.twitch_oauth_states
            SET consumed_at = now()
          WHERE state_hash = '${loginHash}'
            AND purpose = 'login'
            AND consumed_at IS NULL
            AND expires_at > now()
         RETURNING 1
       )
       SELECT count(*)::text FROM consumed;`,
    );
    assert.equal(loginConsumed, '1');
    const loginReplay = runSql(
      containerId,
      'platform_runtime',
      'local-runtime-only',
      `WITH consumed AS (
         UPDATE public.twitch_oauth_states
            SET consumed_at = now()
          WHERE state_hash = '${loginHash}'
            AND purpose = 'login'
            AND consumed_at IS NULL
            AND expires_at > now()
         RETURNING 1
       )
       SELECT count(*)::text FROM consumed;`,
    );
    assert.equal(loginReplay, '0', 'A login OAuth state must remain single-use.');

    const integrationInsert = runSql(
      containerId,
      'platform_runtime',
      'local-runtime-only',
      `INSERT INTO public.twitch_oauth_states (
         state_hash, return_path, purpose, actor_user_id, workspace_id, expires_at
       ) VALUES (
         '${integrationHash}', '/settings/integrations', 'workspace_integration',
         '${actorId}', '${workspaceId}', now() + interval '10 minutes'
       );
       SELECT purpose || ':' || actor_user_id::text || ':' || workspace_id::text
         FROM public.twitch_oauth_states WHERE state_hash = '${integrationHash}';`,
    );
    assert.equal(integrationInsert, 'workspace_integration:' + actorId + ':' + workspaceId);

    const integrationConsumed = runSql(
      containerId,
      'platform_runtime',
      'local-runtime-only',
      `WITH consumed AS (
         UPDATE public.twitch_oauth_states
            SET consumed_at = now()
          WHERE state_hash = '${integrationHash}'
            AND purpose = 'workspace_integration'
            AND actor_user_id = '${actorId}'
            AND workspace_id = '${workspaceId}'
            AND consumed_at IS NULL
            AND expires_at > now()
         RETURNING 1
       )
       SELECT count(*)::text FROM consumed;`,
    );
    assert.equal(integrationConsumed, '1');
  } finally {
    runSql(
      containerId,
      'platform_bootstrap',
      'ci-bootstrap-only',
      `BEGIN;
       DELETE FROM public.twitch_oauth_states
        WHERE state_hash IN ('${loginHash}', '${integrationHash}');
       DELETE FROM public.workspaces WHERE id = '${workspaceId}';
       DELETE FROM public.platform_users WHERE id = '${actorId}';
       COMMIT;`,
    );
  }
});
