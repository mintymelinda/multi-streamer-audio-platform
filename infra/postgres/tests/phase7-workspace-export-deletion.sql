\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE export_owner text; export_definer boolean; runtime_execute boolean;
BEGIN
  SELECT pg_get_userbyid(proowner),prosecdef,
    has_function_privilege('platform_runtime',oid,'EXECUTE')
    INTO export_owner,export_definer,runtime_execute
    FROM pg_proc WHERE oid='export_workspace_data(uuid)'::regprocedure;
  IF export_owner<>'platform_migrator' OR NOT export_definer OR NOT runtime_execute THEN
    RAISE EXCEPTION 'workspace export must be a restricted migrator-owned SECURITY DEFINER function';
  END IF;
  IF has_function_privilege('platform_worker','export_workspace_data(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'worker must not receive workspace export access';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='overlay_scenes'
      AND policyname='workspace_lifecycle_migrator_export' AND roles @> ARRAY['platform_migrator']::name[]) THEN
    RAISE EXCEPTION 'migrator export row policy is missing';
  END IF;
  IF has_table_privilege('platform_runtime','provider_credentials','SELECT') IS NOT TRUE THEN
    RAISE EXCEPTION 'workspace export runtime policy unexpectedly changed provider credential table privileges';
  END IF;
END $$;
ROLLBACK;
