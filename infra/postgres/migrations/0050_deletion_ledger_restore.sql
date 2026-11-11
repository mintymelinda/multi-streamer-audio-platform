-- Phase 7 item 64: privileged, idempotent replay of off-database deletion tombstones.
-- The external S3-compatible ledger is authoritative during disaster recovery.
BEGIN;

-- Recovery runs as platform_migrator after restoring a database snapshot. These
-- narrowly-scoped policies allow the replay function to remove the two root
-- entity types; child records are removed by their existing FK cascades.
CREATE POLICY deletion_ledger_restore_workspace_select
  ON public.workspaces
  FOR SELECT TO platform_migrator
  USING (true);

CREATE POLICY deletion_ledger_restore_migrator
  ON public.workspaces
  FOR DELETE TO platform_migrator
  USING (true);

CREATE POLICY deletion_ledger_restore_admin_assignment
  ON public.platform_administrators
  FOR DELETE TO platform_migrator
  USING (true);

CREATE FUNCTION apply_deletion_tombstone(p_entity_type text, p_entity_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $deletion_replay$
DECLARE
  owner_id uuid;
BEGIN
  IF p_entity_id IS NULL OR p_entity_type NOT IN ('workspace', 'account') THEN
    RAISE EXCEPTION 'unsupported deletion tombstone'
      USING ERRCODE = '22023';
  END IF;

  IF p_entity_type = 'workspace' THEN
    SELECT owner_user_id INTO owner_id
      FROM public.workspaces
     WHERE id = p_entity_id
     FOR UPDATE;

    IF owner_id IS NULL THEN
      RETURN;
    END IF;

    PERFORM set_config('app.user_id', owner_id::text, true);
    PERFORM set_config('app.workspace_id', p_entity_id::text, true);
    DELETE FROM public.workspaces WHERE id = p_entity_id;
    RETURN;
  END IF;

  -- Workspace tombstones are replayed before account tombstones. Remove any
  -- platform-admin assignment restored from a snapshot before invoking the
  -- same account-deletion function used by the live authenticated endpoint.
  PERFORM set_config('app.user_id', p_entity_id::text, true);
  PERFORM 1 FROM public.platform_users WHERE id = p_entity_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM set_config('app.user_id', p_entity_id::text, true);
  DELETE FROM public.platform_administrators WHERE user_id = p_entity_id;
  PERFORM public.delete_current_platform_account();
END;
$deletion_replay$;

ALTER FUNCTION apply_deletion_tombstone(text, uuid) OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION apply_deletion_tombstone(text, uuid) FROM PUBLIC, platform_runtime, platform_worker;
GRANT EXECUTE ON FUNCTION apply_deletion_tombstone(text, uuid) TO platform_migrator;

COMMIT;
