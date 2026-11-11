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
  ]::text[]),
  CHECK (role <> 'owner' OR revoked_at IS NULL)
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

GRANT SELECT, INSERT, UPDATE ON platform_administrators TO platform_runtime;
GRANT SELECT, INSERT ON platform_administration_audit TO platform_runtime;
REVOKE DELETE ON platform_administrators FROM platform_runtime;
REVOKE UPDATE, DELETE ON platform_administration_audit FROM platform_runtime;
REVOKE ALL ON FUNCTION protect_final_platform_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_platform_administration_audit_mutation() FROM PUBLIC;

-- Bootstrap the first owner only after the operator has signed in with Twitch:
-- INSERT INTO platform_administrators (user_id, role)
-- SELECT id, 'owner' FROM platform_users WHERE twitch_user_id = '<verified numeric Twitch ID>';
-- Run this once with platform_migrator or an equivalent privileged operator role.
-- The owner is not inferred from a username, email address, or environment variable.

COMMIT;
