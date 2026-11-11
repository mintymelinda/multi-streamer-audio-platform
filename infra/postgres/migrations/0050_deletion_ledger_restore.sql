-- Phase 7 item 64: privileged, idempotent replay of off-database deletion tombstones.
-- The external S3-compatible ledger is authoritative during disaster recovery.
BEGIN;

-- Recovery runs as platform_migrator after restoring a database snapshot. These
-- narrowly-scoped policies grant the replay functions only the SELECT, DELETE,
-- and UPDATE operations required for workspace, credential, and membership replay.
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

CREATE POLICY deletion_ledger_restore_credentials
  ON public.provider_credentials
  FOR DELETE TO platform_migrator
  USING (true);

CREATE POLICY deletion_ledger_restore_membership_select
  ON public.workspace_memberships
  FOR SELECT TO platform_migrator
  USING (true);

CREATE POLICY deletion_ledger_restore_membership_update
  ON public.workspace_memberships
  FOR UPDATE TO platform_migrator
  USING (true)
  WITH CHECK (true);

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

CREATE FUNCTION apply_credential_tombstone(
  p_credential_id uuid,
  p_workspace_id uuid,
  p_provider_instance_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $credential_replay$
BEGIN
  IF p_credential_id IS NULL OR p_workspace_id IS NULL OR p_provider_instance_id IS NULL THEN
    RAISE EXCEPTION 'credential tombstone identity is incomplete'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.workspace_id', p_workspace_id::text, true);
  DELETE FROM public.provider_credentials
   WHERE id = p_credential_id
     AND workspace_id = p_workspace_id
     AND provider_instance_id = p_provider_instance_id;
END;
$credential_replay$;

CREATE FUNCTION apply_membership_revocation(
  p_workspace_id uuid,
  p_user_id uuid,
  p_revoked_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $membership_replay$
BEGIN
  IF p_workspace_id IS NULL OR p_user_id IS NULL OR p_revoked_at IS NULL THEN
    RAISE EXCEPTION 'membership revocation tombstone identity is incomplete'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.workspace_id', p_workspace_id::text, true);
  UPDATE public.workspace_memberships
     SET status = 'revoked',
         revoked_at = p_revoked_at,
         updated_at = p_revoked_at
   WHERE workspace_id = p_workspace_id
     AND user_id = p_user_id
     AND role <> 'owner'
     AND updated_at <= p_revoked_at;
END;
$membership_replay$;

ALTER FUNCTION apply_membership_revocation(uuid, uuid, timestamptz) OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION apply_membership_revocation(uuid, uuid, timestamptz) FROM PUBLIC, platform_runtime, platform_worker;
GRANT EXECUTE ON FUNCTION apply_membership_revocation(uuid, uuid, timestamptz) TO platform_migrator;

ALTER FUNCTION apply_credential_tombstone(uuid, uuid, uuid) OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION apply_credential_tombstone(uuid, uuid, uuid) FROM PUBLIC, platform_runtime, platform_worker;
GRANT EXECUTE ON FUNCTION apply_credential_tombstone(uuid, uuid, uuid) TO platform_migrator;

ALTER FUNCTION apply_deletion_tombstone(text, uuid) OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION apply_deletion_tombstone(text, uuid) FROM PUBLIC, platform_runtime, platform_worker;
GRANT EXECUTE ON FUNCTION apply_deletion_tombstone(text, uuid) TO platform_migrator;

COMMIT;
