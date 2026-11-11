-- Phase 6 item 55: platform-level administrators and scoped permissions.
BEGIN;

CREATE TYPE platform_administrator_role AS ENUM ('owner', 'admin');

CREATE TABLE platform_administrators (
  user_id uuid PRIMARY KEY REFERENCES platform_users(id) ON DELETE RESTRICT,
  role platform_administrator_role NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  appointed_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  appointed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (permissions <@ ARRAY[
    'accounts.read',
    'accounts.suspend',
    'workspaces.read',
    'workspaces.restrict',
    'settings.read',
    'settings.write',
    'support_access.manage',
    'administrators.read',
    'administrators.manage',
    'rights_reports.manage'
  ]::text[])
);

CREATE INDEX platform_administrators_active_role
  ON platform_administrators (role, user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE platform_administration_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_administration_audit_created
  ON platform_administration_audit (created_at DESC);
CREATE INDEX platform_administration_audit_actor
  ON platform_administration_audit (actor_user_id, created_at DESC);

CREATE FUNCTION protect_final_platform_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  remaining_owners integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD.role = 'owner' AND OLD.revoked_at IS NULL
     AND (TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NEW.revoked_at IS NOT NULL) THEN
    -- Serialize owner removals so concurrent transactions cannot each observe
    -- the other owner and leave the platform with no active owner.
    PERFORM pg_advisory_xact_lock(7219045202);
    SELECT count(*) INTO remaining_owners
      FROM platform_administrators
     WHERE role = 'owner'
       AND revoked_at IS NULL
       AND user_id <> OLD.user_id;

    IF remaining_owners = 0 THEN
      RAISE EXCEPTION 'the final active platform owner cannot be revoked or demoted'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_administrators_protect_final_owner
BEFORE UPDATE OR DELETE ON platform_administrators
FOR EACH ROW EXECUTE FUNCTION protect_final_platform_owner();

CREATE FUNCTION prevent_platform_administration_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform administration audit records are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER platform_administration_audit_immutable
BEFORE UPDATE OR DELETE ON platform_administration_audit
FOR EACH ROW EXECUTE FUNCTION prevent_platform_administration_audit_mutation();

-- SECURITY DEFINER functions are the only runtime write path. They derive the
-- actor from the authenticated transaction context and prevent permission escalation.
CREATE FUNCTION appoint_platform_administrator(
  target_twitch_user_id text,
  assigned_role platform_administrator_role,
  assigned_permissions text[],
  action_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  actor_role platform_administrator_role;
  actor_permissions text[];
  target_role platform_administrator_role;
  target_user_id uuid;
  previous_twitch_lookup text := current_setting('app.twitch_lookup_id', true);
BEGIN
  IF actor_id IS NULL OR length(btrim(action_reason)) NOT BETWEEN 1 AND 1000
     OR target_twitch_user_id !~ '^[0-9]{1,32}$' THEN
    RAISE EXCEPTION 'authenticated platform administrator, valid Twitch ID, and reason are required'
      USING ERRCODE = '42501';
  END IF;

  SELECT role, permissions INTO actor_role, actor_permissions
    FROM public.platform_administrators
   WHERE user_id = actor_id AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform administrator access is required'
      USING ERRCODE = '42501';
  END IF;

  IF actor_role <> 'owner' AND (
    NOT ('administrators.manage' = ANY(actor_permissions))
    OR assigned_role = 'owner'
    OR NOT (assigned_permissions <@ actor_permissions)
  ) THEN
    RAISE EXCEPTION 'administrator cannot grant role or permissions they do not hold'
      USING ERRCODE = '42501';
  END IF;

  -- The platform_users table is FORCE RLS. Use its existing narrow Twitch-ID
  -- lookup policy rather than bypassing tenant/account isolation.
  PERFORM set_config('app.twitch_lookup_id', target_twitch_user_id, true);
  SELECT id INTO target_user_id
    FROM public.platform_users
   WHERE twitch_user_id = target_twitch_user_id AND status = 'active';
  PERFORM set_config('app.twitch_lookup_id', COALESCE(previous_twitch_lookup, ''), true);

  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'target account must sign in and be active before appointment'
      USING ERRCODE = '23503';
  END IF;

  SELECT role INTO target_role
    FROM public.platform_administrators
   WHERE user_id = target_user_id AND revoked_at IS NULL;
  IF actor_role <> 'owner' AND target_role = 'owner' THEN
    RAISE EXCEPTION 'only the platform owner can change an owner assignment'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.platform_administrators (
    user_id, role, permissions, appointed_by_user_id, appointed_at, updated_at, revoked_at
  )
  VALUES (target_user_id, assigned_role, assigned_permissions, actor_id, now(), now(), NULL)
  ON CONFLICT (user_id) DO UPDATE
    SET role = EXCLUDED.role,
        permissions = EXCLUDED.permissions,
        appointed_by_user_id = actor_id,
        updated_at = now(),
        revoked_at = NULL;

  INSERT INTO public.platform_administration_audit (
    actor_user_id, target_user_id, action, reason, details
  )
  VALUES (
    actor_id, target_user_id, 'administrator.appointed', action_reason,
    jsonb_build_object('role', assigned_role, 'permissions', assigned_permissions)
  );
END;
$$;

CREATE FUNCTION revoke_platform_administrator(target_user_id uuid, action_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  actor_role platform_administrator_role;
  target_role platform_administrator_role;
BEGIN
  IF actor_id IS NULL OR length(btrim(action_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'authenticated platform administrator and reason are required'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO actor_role
    FROM public.platform_administrators
   WHERE user_id = actor_id AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform administrator access is required'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO target_role
    FROM public.platform_administrators
   WHERE user_id = target_user_id AND revoked_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active platform administrator not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF actor_role <> 'owner' AND (
    NOT EXISTS (
      SELECT 1 FROM public.platform_administrators
       WHERE user_id = actor_id
         AND revoked_at IS NULL
         AND 'administrators.manage' = ANY(permissions)
    )
    OR target_role = 'owner'
  ) THEN
    RAISE EXCEPTION 'administrator cannot revoke this assignment'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.platform_administrators
     SET revoked_at = now(), updated_at = now()
   WHERE user_id = target_user_id;

  INSERT INTO public.platform_administration_audit (
    actor_user_id, target_user_id, action, reason, details
  )
  VALUES (
    actor_id, target_user_id, 'administrator.revoked', action_reason,
    jsonb_build_object('previous_role', target_role)
  );
END;
$$;

REVOKE ALL ON platform_administrators FROM platform_runtime;
REVOKE ALL ON platform_administration_audit FROM platform_runtime;
GRANT SELECT ON platform_administrators TO platform_runtime;
GRANT SELECT ON platform_administration_audit TO platform_runtime;
REVOKE ALL ON FUNCTION protect_final_platform_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_platform_administration_audit_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION appoint_platform_administrator(text, platform_administrator_role, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_platform_administrator(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION appoint_platform_administrator(text, platform_administrator_role, text[], text) TO platform_runtime;
GRANT EXECUTE ON FUNCTION revoke_platform_administrator(uuid, text) TO platform_runtime;

-- Bootstrap the first owner only after the operator has signed in with Twitch:
-- BEGIN;
-- SELECT set_config('app.twitch_lookup_id', '<verified numeric Twitch ID>', true);
-- INSERT INTO platform_administrators (user_id, role)
-- SELECT id, 'owner' FROM platform_users
--  WHERE twitch_user_id = current_setting('app.twitch_lookup_id', true);
-- COMMIT;
-- Run once with platform_migrator or an equivalent privileged operator role.
-- The owner is not inferred from a username, email address, or environment variable.

COMMIT;
