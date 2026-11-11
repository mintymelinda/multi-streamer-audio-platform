\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE owner_name text; is_definer boolean; worker_execute boolean;
BEGIN
  IF (SELECT column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='workspace_request_settings'
        AND column_name='history_retention_days') <> '14' THEN
    RAISE EXCEPTION 'history retention default must be 14 days';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='workspace_request_settings'::regclass
      AND conname='workspace_request_settings_history_retention_days_check') THEN
    RAISE EXCEPTION 'history retention choices are not constrained';
  END IF;
  SELECT pg_get_userbyid(proowner),prosecdef,
         has_function_privilege('platform_worker',oid,'EXECUTE')
    INTO owner_name,is_definer,worker_execute
    FROM pg_proc WHERE oid='run_platform_retention()'::regprocedure;
  IF owner_name<>'platform_migrator' OR NOT is_definer OR NOT worker_execute THEN
    RAISE EXCEPTION 'retention function ownership/security boundary is invalid';
  END IF;
  IF has_function_privilege('platform_runtime','run_platform_retention()','EXECUTE') THEN
    RAISE EXCEPTION 'runtime role must not invoke cross-tenant retention';
  END IF;
  IF has_table_privilege('platform_worker','media_requests','DELETE')
    OR has_table_privilege('platform_worker','user_notifications','DELETE')
    OR has_table_privilege('platform_worker','playback_operations','DELETE') THEN
    RAISE EXCEPTION 'worker has direct cross-tenant delete privileges';
  END IF;
END $$;
SET LOCAL ROLE platform_worker;
DO $$
DECLARE result jsonb;
BEGIN
  SELECT run_platform_retention() INTO result;
  IF jsonb_typeof(result)<>'object' OR NOT (result ? 'requests')
    OR NOT (result ? 'notifications') OR NOT (result ? 'playbackOperations') THEN
    RAISE EXCEPTION 'retention function returned an incomplete result';
  END IF;
END $$;
RESET ROLE;
ROLLBACK;
