-- Phase 1: identity, workspaces, membership, invitations, sessions, and tenant RLS.
-- Apply only with platform_migrator. The API runtime must use platform_runtime.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'moderator', 'viewer');
CREATE TYPE membership_status AS ENUM ('active', 'revoked');
CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'declined', 'cancelled', 'expired');
CREATE TYPE workspace_status AS ENUM ('active', 'restricted', 'suspended');
CREATE TYPE account_status AS ENUM ('active', 'suspended');

CREATE TABLE platform_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_user_id text NOT NULL UNIQUE CHECK (twitch_user_id ~ '^[0-9]{1,32}$'),
  status account_status NOT NULL DEFAULT 'active',
  suspended_at timestamptz,
  suspension_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'suspended') = (suspended_at IS NOT NULL)),
  CHECK ((status = 'suspended') = (suspension_reason IS NOT NULL))
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  owner_user_id uuid NOT NULL UNIQUE REFERENCES platform_users(id) ON DELETE RESTRICT,
  broadcaster_twitch_user_id text NOT NULL UNIQUE CHECK (broadcaster_twitch_user_id ~ '^[0-9]{1,32}$'),
  status workspace_status NOT NULL DEFAULT 'active',
  restriction_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'active') = (restriction_reason IS NULL))
);

CREATE TABLE workspace_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  role workspace_role NOT NULL,
  status membership_status NOT NULL DEFAULT 'active',
  invited_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (workspace_id, user_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX workspace_memberships_one_owner
  ON workspace_memberships (workspace_id)
  WHERE role = 'owner' AND status = 'active';

CREATE INDEX workspace_memberships_user_status
  ON workspace_memberships (user_id, status, workspace_id);

CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invited_twitch_user_id text NOT NULL CHECK (invited_twitch_user_id ~ '^[0-9]{1,32}$'),
  assigned_role workspace_role NOT NULL CHECK (assigned_role <> 'owner'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  status invitation_status NOT NULL DEFAULT 'pending',
  invited_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK ((status IN ('accepted', 'declined', 'cancelled', 'expired')) = (responded_at IS NOT NULL))
);

CREATE UNIQUE INDEX workspace_invitations_one_pending_target
  ON workspace_invitations (workspace_id, invited_twitch_user_id)
  WHERE status = 'pending';

CREATE INDEX workspace_invitations_target_status
  ON workspace_invitations (invited_twitch_user_id, status, expires_at);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  session_token_hash text NOT NULL UNIQUE CHECK (session_token_hash ~ '^[a-f0-9]{64}$'),
  csrf_token_hash text NOT NULL CHECK (csrf_token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX user_sessions_user_active
  ON user_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

-- Short-lived OAuth state is pre-authentication data and is not workspace data.
-- Store only a hash of state and a validated local return path.
CREATE TABLE twitch_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  return_path text NOT NULL DEFAULT '/' CHECK (left(return_path, 1) = '/' AND left(return_path, 2) <> '//'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX twitch_oauth_states_expiry ON twitch_oauth_states (expires_at);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
  target_type text,
  target_id text,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_workspace_created
  ON audit_events (workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX audit_events_actor_created
  ON audit_events (actor_user_id, created_at DESC);

-- A workspace must always have exactly one active owner membership matching
-- both owner_user_id and broadcaster_twitch_user_id. Deferred checks allow
-- workspace + owner membership to be created atomically in one transaction.
CREATE FUNCTION enforce_workspace_owner_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_workspace_id uuid;
  owner_id uuid;
  broadcaster_id text;
  owner_twitch_id text;
  owner_count integer;
BEGIN
  IF TG_TABLE_NAME = 'workspaces' THEN
    checked_workspace_id := COALESCE(NEW.id, OLD.id);
  ELSE
    checked_workspace_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
  END IF;

  SELECT w.owner_user_id, w.broadcaster_twitch_user_id, u.twitch_user_id
    INTO owner_id, broadcaster_id, owner_twitch_id
    FROM workspaces w
    JOIN platform_users u ON u.id = w.owner_user_id
   WHERE w.id = checked_workspace_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO owner_count
    FROM workspace_memberships m
   WHERE m.workspace_id = checked_workspace_id
     AND m.user_id = owner_id
     AND m.role = 'owner'
     AND m.status = 'active';

  IF owner_count <> 1 OR broadcaster_id <> owner_twitch_id THEN
    RAISE EXCEPTION 'workspace owner membership and broadcaster identity must match the workspace owner'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER workspaces_owner_consistency
AFTER INSERT OR UPDATE ON workspaces
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_owner_consistency();

CREATE CONSTRAINT TRIGGER memberships_owner_consistency
AFTER INSERT OR UPDATE OR DELETE ON workspace_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_owner_consistency();

-- Owner identity is permanent in this release. Owner transfer is not exposed.
CREATE FUNCTION protect_workspace_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $
BEGIN
  IF OLD.role = 'owner' AND OLD.status = 'active' THEN
    -- Workspace deletion is allowed to cascade its membership rows.
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
      RETURN OLD;
    END IF;
    IF TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NEW.status <> 'active'
       OR NEW.user_id <> OLD.user_id OR NEW.workspace_id <> OLD.workspace_id THEN
      RAISE EXCEPTION 'workspace owner membership cannot be removed or reassigned'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$;

CREATE TRIGGER protect_workspace_owner_membership_trigger
BEFORE UPDATE OR DELETE ON workspace_memberships
FOR EACH ROW EXECUTE FUNCTION protect_workspace_owner_membership();

-- Audit records are append-only. Workspace deletion cascades as required by
-- the approved workspace-deletion policy; ordinary runtime mutation is denied.
-- Twitch numeric identity is immutable after account creation.
CREATE FUNCTION prevent_twitch_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $
BEGIN
  IF NEW.twitch_user_id <> OLD.twitch_user_id THEN
    RAISE EXCEPTION 'Twitch numeric identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$;

CREATE TRIGGER platform_users_twitch_identity_immutable
BEFORE UPDATE OF twitch_user_id ON platform_users
FOR EACH ROW EXECUTE FUNCTION prevent_twitch_identity_change();

-- Updated timestamps are maintained by the application; the database remains
-- the authority for created_at and all security-sensitive state transitions.

ALTER TABLE platform_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_users FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_users_self_access ON platform_users
  USING (id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_context_access ON workspaces
  USING (
    id = nullif(current_setting('app.workspace_id', true), '')::uuid
    OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

ALTER TABLE workspace_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_memberships_user_or_context ON workspace_memberships
  USING (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  );

ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_invitations_context_access ON workspace_invitations
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    OR invited_twitch_user_id = (
      SELECT u.twitch_user_id FROM platform_users u
       WHERE u.id = nullif(current_setting('app.user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    OR invited_twitch_user_id = (
      SELECT u.twitch_user_id FROM platform_users u
       WHERE u.id = nullif(current_setting('app.user_id', true), '')::uuid
    )
  );

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_self_access ON user_sessions
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_context_access ON audit_events
  USING (
    (workspace_id IS NOT NULL AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
    OR (workspace_id IS NULL AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  )
  WITH CHECK (
    (workspace_id IS NOT NULL AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
    OR (workspace_id IS NULL AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  );

-- Runtime has only the minimum DML needed by the API. It does not own tables,
-- cannot alter schema, and has no BYPASSRLS or superuser privilege.
GRANT SELECT, INSERT, UPDATE ON platform_users TO platform_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces TO platform_runtime;
GRANT SELECT, INSERT, UPDATE ON workspace_memberships TO platform_runtime;
GRANT SELECT, INSERT, UPDATE ON workspace_invitations TO platform_runtime;
GRANT SELECT, INSERT, UPDATE ON user_sessions TO platform_runtime;
GRANT SELECT, INSERT ON twitch_oauth_states TO platform_runtime;
GRANT UPDATE, DELETE ON twitch_oauth_states TO platform_runtime;
GRANT SELECT, INSERT ON audit_events TO platform_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE platform_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE platform_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO platform_runtime;

-- Keep auth state and sessions bounded even if an application cleanup job is delayed.
CREATE FUNCTION cleanup_expired_oauth_state()
RETURNS integer
LANGUAGE plpgsql
AS $
DECLARE
  removed_count integer;
BEGIN
  DELETE FROM twitch_oauth_states WHERE expires_at < now() OR consumed_at < now() - interval '1 day';
  GET DIAGNOSTICS removed_count = ROW_COUNT;
  RETURN removed_count;
END;
$;

GRANT EXECUTE ON FUNCTION cleanup_expired_oauth_state() TO platform_runtime;
