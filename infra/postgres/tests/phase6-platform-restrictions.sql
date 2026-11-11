-- Phase 6 item 57: account suspension and workspace restriction are audited and reversible.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  admin_id uuid := gen_random_uuid();
  workspace_admin_id uuid := gen_random_uuid();
  account_id uuid := gen_random_uuid();
  owner_id uuid := gen_random_uuid();
  workspace_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO platform_users (id, twitch_user_id)
  VALUES
    (admin_id, '980000030'),
    (workspace_admin_id, '980000033'),
    (account_id, '980000031'),
    (owner_id, '980000032');

  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
  VALUES (workspace_id, 'Restriction test workspace', owner_id, '980000032');

  INSERT INTO workspace_memberships (workspace_id, user_id, role)
  VALUES (workspace_id, owner_id, 'owner');

  INSERT INTO user_sessions (user_id, session_token_hash, csrf_token_hash, expires_at)
  VALUES (account_id, repeat('a', 64), repeat('b', 64), now() + interval '1 day');

  INSERT INTO platform_administrators (user_id, twitch_user_id, role, permissions)
  VALUES
    (admin_id, '980000030', 'admin', ARRAY[
      'accounts.read', 'accounts.suspend', 'workspaces.read', 'workspaces.restrict'
    ]),
    (owner_id, '980000032', 'owner', ARRAY[]::text[]),
    (workspace_admin_id, '980000033', 'admin', ARRAY['workspaces.read', 'workspaces.restrict']);

  PERFORM set_config('test.restrictions_admin_id', admin_id::text, true);
  PERFORM set_config('test.restrictions_workspace_admin_id', workspace_admin_id::text, true);
  PERFORM set_config('test.restrictions_account_id', account_id::text, true);
  PERFORM set_config('test.restrictions_owner_id', owner_id::text, true);
  PERFORM set_config('test.restrictions_workspace_id', workspace_id::text, true);
END;
$$;

SET LOCAL ROLE platform_runtime;

DO $$
DECLARE
  admin_id uuid := current_setting('test.restrictions_admin_id')::uuid;
  account_id uuid := current_setting('test.restrictions_account_id')::uuid;
  owner_id uuid := current_setting('test.restrictions_owner_id')::uuid;
  workspace_admin_id uuid := current_setting('test.restrictions_workspace_admin_id')::uuid;
  workspace_id uuid := current_setting('test.restrictions_workspace_id')::uuid;
  account_count integer;
  workspace_count integer;
  revoked_sessions integer;
  affected_rows integer;
BEGIN
  IF has_table_privilege(current_user, 'public.platform_administration_audit', 'SELECT')
     OR has_table_privilege(current_user, 'public.platform_administration_audit', 'INSERT') THEN
    RAISE EXCEPTION 'runtime role can directly access platform administration audit records';
  END IF;

  PERFORM set_config('app.user_id', account_id::text, true);
  BEGIN
    PERFORM * FROM list_platform_accounts(NULL);
    RAISE EXCEPTION 'ordinary account received platform account directory access';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  PERFORM set_config('app.user_id', admin_id::text, true);

  UPDATE platform_users
     SET status = 'suspended', suspended_at = now(), suspension_reason = 'Unapproved direct update'
   WHERE id = account_id;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'account status was changed outside the audited transition function';
  END IF;

  UPDATE workspaces
     SET status = 'suspended', restriction_reason = 'Unapproved direct update'
   WHERE id = workspace_id;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'workspace status was changed outside the audited transition function';
  END IF;

  SELECT count(*) INTO account_count FROM list_platform_accounts('980000031')
   WHERE user_id = account_id AND status = 'active';
  IF account_count <> 1 THEN
    RAISE EXCEPTION 'account directory did not return the matching active account';
  END IF;

  SELECT count(*) INTO workspace_count FROM list_platform_workspaces('Restriction test') directory
   WHERE directory.workspace_id = current_setting('test.restrictions_workspace_id')::uuid
     AND status = 'active';
  IF workspace_count <> 1 THEN
    RAISE EXCEPTION 'workspace directory did not return the matching active workspace';
  END IF;

  -- Workspace-only administrators may inspect workspace records without
  -- receiving the separate global account-directory permission.
  PERFORM set_config('app.user_id', workspace_admin_id::text, true);
  SELECT count(*) INTO account_count FROM platform_users;
  IF account_count <> 1 THEN
    RAISE EXCEPTION 'workspace-only administrator received global account visibility';
  END IF;
  SELECT count(*) INTO workspace_count
    FROM list_platform_workspaces('Restriction test') directory
   WHERE directory.workspace_id = current_setting('test.restrictions_workspace_id')::uuid;
  IF workspace_count <> 1 THEN
    RAISE EXCEPTION 'workspace-only administrator cannot inspect workspace directory';
  END IF;

  PERFORM set_config('app.user_id', admin_id::text, true);
  PERFORM set_platform_account_status(account_id, 'suspended', 'Confirmed platform abuse');
  SELECT count(*) INTO revoked_sessions
    FROM user_sessions
   WHERE user_id = account_id AND revoked_at IS NOT NULL;
  IF revoked_sessions <> 1 THEN
    RAISE EXCEPTION 'account suspension did not revoke all active sessions';
  END IF;

  PERFORM set_platform_account_status(account_id, 'active', 'Appeal accepted');

  BEGIN
    PERFORM set_platform_account_status(owner_id, 'suspended', 'Attempt to suspend platform owner');
    RAISE EXCEPTION 'active platform owner suspension was unexpectedly allowed';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  PERFORM set_platform_workspace_status(workspace_id, 'restricted', 'Policy investigation');
  SELECT count(*) INTO workspace_count
    FROM list_platform_workspaces(workspace_id::text) directory
   WHERE directory.workspace_id = current_setting('test.restrictions_workspace_id')::uuid
     AND status = 'restricted'
     AND restriction_reason = 'Policy investigation';
  IF workspace_count <> 1 THEN
    RAISE EXCEPTION 'workspace restriction state or reason was not persisted';
  END IF;

  PERFORM set_platform_workspace_status(workspace_id, 'suspended', 'Severe ongoing abuse');
  PERFORM set_platform_workspace_status(workspace_id, 'active', 'Investigation closed');

  SELECT count(*) INTO workspace_count
    FROM list_platform_workspaces(workspace_id::text) directory
   WHERE directory.workspace_id = current_setting('test.restrictions_workspace_id')::uuid
     AND status = 'active'
     AND restriction_reason IS NULL;
  IF workspace_count <> 1 THEN
    RAISE EXCEPTION 'workspace restoration did not clear the restriction state';
  END IF;
END;
$$;

RESET ROLE;

DO $$
DECLARE
  account_id uuid := current_setting('test.restrictions_account_id')::uuid;
  workspace_id uuid := current_setting('test.restrictions_workspace_id')::uuid;
  account_events integer;
  workspace_events integer;
BEGIN
  SELECT count(*) INTO account_events
    FROM platform_administration_audit
   WHERE target_user_id = account_id
     AND action IN ('account.suspended', 'account.reinstated');
  IF account_events <> 2 THEN
    RAISE EXCEPTION 'account suspension and reinstatement were not both audited';
  END IF;

  SELECT count(*) INTO workspace_events
    FROM platform_administration_audit
   WHERE details->>'workspace_id' = workspace_id::text
     AND action IN ('workspace.restricted', 'workspace.suspended', 'workspace.restored');
  IF workspace_events <> 3 THEN
    RAISE EXCEPTION 'workspace restriction, suspension, and restoration were not all audited';
  END IF;
END;
$$;

ROLLBACK;
