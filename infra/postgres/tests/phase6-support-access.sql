-- Phase 6 item 56: support access is temporary, read-only, scoped, visible, and revocable.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  owner_id uuid := gen_random_uuid();
  support_id uuid := gen_random_uuid();
  workspace_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO platform_users (id, twitch_user_id)
  VALUES (owner_id, '980000020'), (support_id, '980000021');

  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
  VALUES (workspace_id, 'Support access test', owner_id, '980000020');

  INSERT INTO workspace_memberships (workspace_id, user_id, role)
  VALUES (workspace_id, owner_id, 'owner');

  INSERT INTO platform_administrators (user_id, twitch_user_id, role, permissions)
  VALUES (support_id, '980000021', 'admin', ARRAY['support_access.manage', 'workspaces.read']);

  INSERT INTO media_requests (workspace_id, source, title, status)
  VALUES (workspace_id, 'dashboard', 'Private test track', 'queued');

  INSERT INTO provider_instances (
    workspace_id, provider_id, instance_key, contract_version, connection_health
  )
  VALUES (workspace_id, 'youtube', 'support-test', 1, 'healthy');

  PERFORM set_config('test.support_owner_id', owner_id::text, true);
  PERFORM set_config('test.support_user_id', support_id::text, true);
  PERFORM set_config('test.support_workspace_id', workspace_id::text, true);
END;
$$;

SET LOCAL ROLE platform_runtime;

DO $$
DECLARE
  owner_id uuid := current_setting('test.support_owner_id')::uuid;
  support_id uuid := current_setting('test.support_user_id')::uuid;
  workspace_id uuid := current_setting('test.support_workspace_id')::uuid;
  grant_id uuid;
  diagnostics jsonb;
  content jsonb;
  visible_grants integer;
  visible_audit integer;
BEGIN
  IF has_table_privilege(current_user, 'public.workspace_support_access', 'SELECT')
     OR has_table_privilege(current_user, 'public.workspace_support_access', 'INSERT')
     OR has_table_privilege(current_user, 'public.workspace_support_access_audit', 'SELECT')
     OR has_table_privilege(current_user, 'public.workspace_support_access_audit', 'INSERT') THEN
    RAISE EXCEPTION 'runtime role can directly access support access records';
  END IF;

  PERFORM set_config('app.user_id', support_id::text, true);
  diagnostics := get_workspace_technical_diagnostics(workspace_id);
  IF diagnostics->>'status' <> 'active'
     OR diagnostics->'requestCounts'->>'queued' <> '1'
     OR diagnostics->'providerHealth'->0->>'health' <> 'healthy'
     OR diagnostics ? 'recentRequests' THEN
    RAISE EXCEPTION 'technical diagnostics returned incorrect or content-bearing data: %', diagnostics;
  END IF;

  SELECT created.id INTO grant_id
    FROM create_workspace_support_access(
      workspace_id, ARRAY['requests.read'], 'Investigate a reported request issue', 30
    ) created;

  content := read_support_workspace_content(grant_id);
  IF content->'recentRequests'->0->>'title' <> 'Private test track'
     OR content ? 'workspace'
     OR content ? 'providers' THEN
    RAISE EXCEPTION 'support content read did not honor the granted scope: %', content;
  END IF;

  PERFORM set_config('app.user_id', owner_id::text, true);
  PERFORM set_config('app.workspace_id', workspace_id::text, true);
  SELECT count(*) INTO visible_grants
    FROM list_workspace_support_access(workspace_id)
   WHERE id = grant_id AND active;
  IF visible_grants <> 1 THEN
    RAISE EXCEPTION 'workspace owner cannot see the active support grant';
  END IF;

  SELECT count(*) INTO visible_audit
    FROM list_workspace_support_access_audit(workspace_id)
   WHERE action IN ('workspace.diagnostics.read', 'support_access.granted', 'support_access.content_read');
  IF visible_audit <> 3 THEN
    RAISE EXCEPTION 'workspace owner cannot see the support access audit trail';
  END IF;

  PERFORM revoke_workspace_support_access(workspace_id, grant_id, 'Workspace owner ended support access');

  PERFORM set_config('app.user_id', support_id::text, true);
  BEGIN
    PERFORM read_support_workspace_content(grant_id);
    RAISE EXCEPTION 'revoked support grant still allowed content access';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

RESET ROLE;

DO $$
DECLARE
  target_workspace_id uuid := current_setting('test.support_workspace_id')::uuid;
  audit_count integer;
BEGIN
  SELECT count(*) INTO audit_count
    FROM workspace_support_access_audit audit
   WHERE audit.workspace_id = target_workspace_id
     AND action IN ('workspace.diagnostics.read', 'support_access.granted', 'support_access.content_read', 'support_access.audit_viewed', 'support_access.revoked');
  IF audit_count <> 5 THEN
    RAISE EXCEPTION 'diagnostics, grant, content read, audit review, and revocation were not all audited';
  END IF;
END;
$$;

ROLLBACK;
