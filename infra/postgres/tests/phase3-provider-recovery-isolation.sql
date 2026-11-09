-- Phase 3 item 32: recovery policy and audit data remain tenant isolated.
BEGIN;
SET LOCAL ROLE platform_runtime;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.workspace_id', '', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM workspace_provider_recovery_policies) <> 0 THEN
    RAISE EXCEPTION 'recovery policy visible without tenant context';
  END IF;
  IF (SELECT count(*) FROM provider_recovery_actions) <> 0 THEN
    RAISE EXCEPTION 'recovery action visible without tenant context';
  END IF;
END $$;
ROLLBACK;
