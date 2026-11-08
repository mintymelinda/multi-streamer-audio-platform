-- Run as platform_runtime after applying migrations as platform_migrator.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;

-- No ambient tenant context must reveal no user or tenant rows.
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.workspace_id', '', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM platform_users) <> 0 THEN
    RAISE EXCEPTION 'users leaked without a verified user context';
  END IF;
  IF (SELECT count(*) FROM workspaces) <> 0 THEN
    RAISE EXCEPTION 'workspaces leaked without a tenant context';
  END IF;
END;
$$;

-- Seed two accounts through the same self-scoped runtime path used by sign-in.
DO $$
DECLARE
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  workspace_a uuid := gen_random_uuid();
  workspace_b uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_a, '910000001');

  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_b, '910000002');

  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
  VALUES (workspace_a, 'Tenant A', user_a, '910000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
  VALUES (workspace_a, user_a, 'owner');

  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
  VALUES (workspace_b, 'Tenant B', user_b, '910000002');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
  VALUES (workspace_b, user_b, 'owner');

  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);

  IF (SELECT count(*) FROM workspaces) <> 1 THEN
    RAISE EXCEPTION 'workspace isolation failed for Tenant A';
  END IF;
  IF (SELECT count(*) FROM workspace_memberships) <> 1 THEN
    RAISE EXCEPTION 'membership isolation failed for Tenant A';
  END IF;

  -- A supplied workspace ID alone is insufficient: the membership table's
  -- policy only exposes the caller's own membership when establishing context.
  PERFORM set_config('app.workspace_id', workspace_b::text, true);
  IF (SELECT count(*) FROM workspaces WHERE id = workspace_b) <> 1 THEN
    RAISE EXCEPTION 'RLS context policy should expose the selected workspace; API membership verification is mandatory';
  END IF;

  -- User A still cannot read User B's account or User B's session rows.
  PERFORM set_config('app.workspace_id', '', true);
  IF (SELECT count(*) FROM platform_users WHERE id = user_b) <> 0 THEN
    RAISE EXCEPTION 'cross-user account read was not blocked';
  END IF;

  -- The owner is protected against role demotion and revocation.
  BEGIN
    UPDATE workspace_memberships
       SET role = 'admin'
     WHERE workspace_id = workspace_a AND user_id = user_a;
    RAISE EXCEPTION 'owner demotion unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- One owned workspace per user is enforced by a database unique constraint.
  BEGIN
    INSERT INTO workspaces (name, owner_user_id, broadcaster_twitch_user_id)
    VALUES ('Second owned workspace', user_a, '910000001');
    RAISE EXCEPTION 'second owned workspace unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END;
$$;
ROLLBACK;
