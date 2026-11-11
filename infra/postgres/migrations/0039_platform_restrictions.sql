-- Phase 6 item 57: audited account suspension and workspace restriction controls.
BEGIN;

-- All runtime operations go through narrow SECURITY DEFINER functions. This
-- helper returns the authenticated platform actor only when the requested
-- permission is currently held by an active account and assignment.
CREATE FUNCTION require_platform_permission(required_permission text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_access$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  actor_role platform_administrator_role;
  actor_permissions text[];
  account_state account_status;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'authenticated platform administrator is required'
      USING ERRCODE = '42501';
  END IF;

  SELECT users.status, administrators.role, administrators.permissions
    INTO account_state, actor_role, actor_permissions
    FROM public.platform_administrators administrators
    JOIN public.platform_users users ON users.id = administrators.user_id
   WHERE administrators.user_id = actor_id
     AND administrators.revoked_at IS NULL;

  IF NOT FOUND OR account_state <> 'active' OR (
    actor_role <> 'owner'
    AND NOT (required_permission = ANY(actor_permissions))
  ) THEN
    RAISE EXCEPTION 'platform permission % is required', required_permission
      USING ERRCODE = '42501';
  END IF;

  RETURN actor_id;
END;
$platform_access$;

-- These RLS predicates expose global rows only through the matching platform
-- read permission. The helper consults the administrator table only, avoiding
-- recursive reads of platform_users or workspaces from their own policies.
CREATE FUNCTION platform_has_permission(required_permission text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_access$
  SELECT EXISTS (
    SELECT 1
      FROM public.platform_administrators administrators
     WHERE administrators.user_id = nullif(current_setting('app.user_id', true), '')::uuid
       AND administrators.revoked_at IS NULL
       AND (
         administrators.role = 'owner'
         OR required_permission = ANY(administrators.permissions)
       )
  )
$platform_access$;

CREATE POLICY platform_users_admin_read ON platform_users
  FOR SELECT TO platform_runtime, platform_migrator USING (platform_has_permission('accounts.read'));

CREATE POLICY workspaces_platform_admin_read ON workspaces
  FOR SELECT TO platform_runtime, platform_migrator USING (platform_has_permission('workspaces.read'));

CREATE POLICY platform_users_admin_status_update ON platform_users
  FOR UPDATE TO platform_runtime, platform_migrator
  USING (
    platform_has_permission('accounts.suspend')
    AND nullif(btrim(current_setting('app.platform_status_reason', true)), '') IS NOT NULL
  )
  WITH CHECK (
    platform_has_permission('accounts.suspend')
    AND nullif(btrim(current_setting('app.platform_status_reason', true)), '') IS NOT NULL
  );

CREATE POLICY workspaces_platform_admin_status_update ON workspaces
  FOR UPDATE TO platform_runtime, platform_migrator
  USING (
    platform_has_permission('workspaces.restrict')
    AND nullif(btrim(current_setting('app.platform_status_reason', true)), '') IS NOT NULL
  )
  WITH CHECK (
    platform_has_permission('workspaces.restrict')
    AND nullif(btrim(current_setting('app.platform_status_reason', true)), '') IS NOT NULL
  );

CREATE FUNCTION list_platform_accounts(search_term text DEFAULT NULL)
RETURNS TABLE (
  user_id uuid,
  twitch_user_id text,
  status account_status,
  created_at timestamptz,
  suspended_at timestamptz,
  suspension_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_access$
DECLARE
  actor_id uuid := public.require_platform_permission('accounts.read');
  normalized_search text := nullif(btrim(search_term), '');
BEGIN
  RETURN QUERY
    SELECT users.id, users.twitch_user_id, users.status, users.created_at,
           users.suspended_at, users.suspension_reason
      FROM public.platform_users users
     WHERE normalized_search IS NULL
        OR users.twitch_user_id = normalized_search
        OR users.id::text = normalized_search
     ORDER BY users.created_at DESC
     LIMIT 100;
END;
$platform_access$;

CREATE FUNCTION list_platform_workspaces(search_term text DEFAULT NULL)
RETURNS TABLE (
  workspace_id uuid,
  name text,
  broadcaster_twitch_user_id text,
  status workspace_status,
  restriction_reason text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_access$
DECLARE
  actor_id uuid := public.require_platform_permission('workspaces.read');
  normalized_search text := nullif(btrim(search_term), '');
BEGIN
  RETURN QUERY
    SELECT workspace.id, workspace.name, workspace.broadcaster_twitch_user_id,
           workspace.status, workspace.restriction_reason,
           workspace.created_at, workspace.updated_at
      FROM public.workspaces workspace
     WHERE normalized_search IS NULL
        OR workspace.name ILIKE '%' || normalized_search || '%'
        OR workspace.broadcaster_twitch_user_id = normalized_search
        OR workspace.id::text = normalized_search
     ORDER BY workspace.created_at DESC
     LIMIT 100;
END;
$platform_access$;

CREATE FUNCTION set_platform_account_status(
  target_user_id uuid,
  desired_status account_status,
  action_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_access$
DECLARE
  actor_id uuid := public.require_platform_permission('accounts.suspend');
  previous_status account_status;
  previous_reason text := current_setting('app.platform_status_reason', true);
BEGIN
  IF target_user_id IS NULL OR desired_status IS NULL OR action_reason IS NULL
     OR length(btrim(action_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'target account, status, and reason are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.require_platform_permission('accounts.read');
  PERFORM set_config('app.platform_status_reason', btrim(action_reason), true);

  SELECT users.status
    INTO previous_status
    FROM public.platform_users users
   WHERE users.id = target_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'target account was not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF previous_status = desired_status THEN
    RAISE EXCEPTION 'account already has status %', desired_status
      USING ERRCODE = '23514';
  END IF;

  IF desired_status = 'suspended' AND EXISTS (
    SELECT 1 FROM public.platform_administrators administrators
     WHERE administrators.user_id = target_user_id
       AND administrators.role = 'owner'
       AND administrators.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'an active platform owner cannot be suspended'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.platform_users
     SET status = desired_status,
         suspended_at = CASE WHEN desired_status = 'suspended' THEN now() ELSE NULL END,
         suspension_reason = CASE WHEN desired_status = 'suspended' THEN btrim(action_reason) ELSE NULL END,
         updated_at = now()
   WHERE id = target_user_id;

  IF desired_status = 'suspended' THEN
    UPDATE public.user_sessions
       SET revoked_at = now()
     WHERE user_id = target_user_id
       AND revoked_at IS NULL;
  END IF;

  PERFORM set_config('app.platform_status_reason', COALESCE(previous_reason, ''), true);
END;
$platform_access$;

CREATE FUNCTION set_platform_workspace_status(
  target_workspace_id uuid,
  desired_status workspace_status,
  action_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_access$
DECLARE
  actor_id uuid := public.require_platform_permission('workspaces.restrict');
  previous_status workspace_status;
  previous_reason text := current_setting('app.platform_status_reason', true);
BEGIN
  IF target_workspace_id IS NULL OR desired_status IS NULL OR action_reason IS NULL
     OR length(btrim(action_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'target workspace, status, and reason are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.require_platform_permission('workspaces.read');
  PERFORM set_config('app.platform_status_reason', btrim(action_reason), true);

  SELECT workspace.status
    INTO previous_status
    FROM public.workspaces workspace
   WHERE workspace.id = target_workspace_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'target workspace was not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF previous_status = desired_status THEN
    RAISE EXCEPTION 'workspace already has status %', desired_status
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.workspaces
     SET status = desired_status,
         restriction_reason = CASE WHEN desired_status = 'active' THEN NULL ELSE btrim(action_reason) END,
         updated_at = now()
   WHERE id = target_workspace_id;

  PERFORM set_config('app.platform_status_reason', COALESCE(previous_reason, ''), true);
END;
$platform_access$;


CREATE FUNCTION audit_platform_account_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_audit$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  action_reason text := nullif(btrim(current_setting('app.platform_status_reason', true)), '');
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF actor_id IS NULL OR action_reason IS NULL OR length(action_reason) > 1000 THEN
      RAISE EXCEPTION 'account status changes require an authenticated actor and reason'
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.platform_administration_audit (
      actor_user_id, target_user_id, action, reason, details
    )
    VALUES (
      actor_id, NEW.id,
      CASE WHEN NEW.status = 'suspended' THEN 'account.suspended' ELSE 'account.reinstated' END,
      action_reason,
      jsonb_build_object(
        'twitch_user_id', NEW.twitch_user_id,
        'previous_status', OLD.status,
        'new_status', NEW.status
      )
    );
  ELSIF NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
     OR NEW.suspension_reason IS DISTINCT FROM OLD.suspension_reason THEN
    RAISE EXCEPTION 'account suspension details must change with account status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$platform_audit$;

CREATE TRIGGER platform_users_status_audit
BEFORE UPDATE OF status, suspended_at, suspension_reason ON platform_users
FOR EACH ROW EXECUTE FUNCTION audit_platform_account_status_change();

CREATE FUNCTION audit_platform_workspace_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_audit$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  action_reason text := nullif(btrim(current_setting('app.platform_status_reason', true)), '');
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF actor_id IS NULL OR action_reason IS NULL OR length(action_reason) > 1000 THEN
      RAISE EXCEPTION 'workspace status changes require an authenticated actor and reason'
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.platform_administration_audit (
      actor_user_id, target_user_id, action, reason, details
    )
    VALUES (
      actor_id, NEW.owner_user_id,
      CASE NEW.status
        WHEN 'restricted' THEN 'workspace.restricted'
        WHEN 'suspended' THEN 'workspace.suspended'
        ELSE 'workspace.restored'
      END,
      action_reason,
      jsonb_build_object(
        'workspace_id', NEW.id,
        'workspace_name', NEW.name,
        'previous_status', OLD.status,
        'new_status', NEW.status
      )
    );
  ELSIF NEW.restriction_reason IS DISTINCT FROM OLD.restriction_reason THEN
    RAISE EXCEPTION 'workspace restriction reason must change with workspace status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$platform_audit$;

CREATE TRIGGER workspaces_status_audit
BEFORE UPDATE OF status, restriction_reason ON workspaces
FOR EACH ROW EXECUTE FUNCTION audit_platform_workspace_status_change();

REVOKE ALL ON FUNCTION require_platform_permission(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_has_permission(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_platform_accounts(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_platform_workspaces(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_platform_account_status(uuid, account_status, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_platform_workspace_status(uuid, workspace_status, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_platform_account_status_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_platform_workspace_status_change() FROM PUBLIC;

GRANT USAGE ON TYPE account_status TO platform_runtime;
GRANT EXECUTE ON FUNCTION platform_has_permission(text) TO platform_runtime;
GRANT USAGE ON TYPE workspace_status TO platform_runtime;
GRANT EXECUTE ON FUNCTION list_platform_accounts(text) TO platform_runtime;
GRANT EXECUTE ON FUNCTION list_platform_workspaces(text) TO platform_runtime;
GRANT EXECUTE ON FUNCTION set_platform_account_status(uuid, account_status, text) TO platform_runtime;
GRANT EXECUTE ON FUNCTION set_platform_workspace_status(uuid, workspace_status, text) TO platform_runtime;

COMMIT;
