-- Phase 1 database security checks.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.workspace_id', '', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM platform_users) <> 0 THEN
    RAISE EXCEPTION 'platform_users must be hidden without user context';
  END IF;
  IF (SELECT count(*) FROM workspaces) <> 0 THEN
    RAISE EXCEPTION 'workspaces must be hidden without workspace context';
  END IF;
END;
$$;
ROLLBACK;
