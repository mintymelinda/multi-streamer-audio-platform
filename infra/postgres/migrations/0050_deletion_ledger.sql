-- Phase 7 item 64: durable deletion/revocation journal and restore replay.
-- The journal is exported as a signed artifact and stored independently of database backups.
BEGIN;

-- A revoked support grant is already inactive. Deleting the account that
-- revoked it should remove that inactive grant row while the separate
-- append-only support audit and deletion ledger retain the history.
ALTER TABLE workspace_support_access
  DROP CONSTRAINT workspace_support_access_revoked_by_user_id_fkey,
  ADD CONSTRAINT workspace_support_access_revoked_by_user_id_fkey
    FOREIGN KEY (revoked_by_user_id) REFERENCES platform_users(id) ON DELETE CASCADE;

CREATE TABLE platform_deletion_ledger (
  entry_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  event_id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN (
    'workspace.deleted',
    'user.deleted',
    'credential.revoked',
    'membership.granted',
    'membership.revoked',
    'invitation.revoked',
    'platform_admin.revoked',
    'platform_admin.granted',
    'workspace.access.granted',
    'workspace.access.revoked',
    'user.access.granted',
    'user.access.revoked',
    'support_access.granted',
    'support_access.revoked',
    'session.revoked'
  )),
  subject_id uuid NOT NULL,
  affected_workspace_id uuid,
  user_id uuid,
  identity_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
); 

CREATE TABLE platform_deletion_ledger_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  replay_token uuid NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO platform_deletion_ledger_control DEFAULT VALUES;
ALTER TABLE platform_deletion_ledger_control OWNER TO platform_migrator;
REVOKE ALL ON TABLE platform_deletion_ledger_control FROM PUBLIC, platform_runtime, platform_worker;

CREATE FUNCTION platform_deletion_ledger_replay_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.platform_deletion_ledger_control
     WHERE singleton
       AND current_setting('app.deletion_ledger_replay', true) = replay_token::text
  );
$$;
ALTER FUNCTION platform_deletion_ledger_replay_active() OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION platform_deletion_ledger_replay_active() FROM PUBLIC, platform_runtime, platform_worker;

ALTER TABLE platform_deletion_ledger OWNER TO platform_migrator;
REVOKE ALL ON platform_deletion_ledger FROM PUBLIC, platform_runtime, platform_worker;
REVOKE ALL ON SEQUENCE platform_deletion_ledger_entry_id_seq FROM PUBLIC, platform_runtime, platform_worker;
GRANT SELECT, INSERT ON platform_deletion_ledger TO platform_migrator;
GRANT USAGE, SELECT ON SEQUENCE platform_deletion_ledger_entry_id_seq TO platform_migrator;

CREATE FUNCTION prevent_platform_deletion_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform deletion ledger entries are append-only'
    USING ERRCODE = '23514';
END;
$$;
ALTER FUNCTION prevent_platform_deletion_ledger_mutation() OWNER TO platform_migrator;
CREATE TRIGGER platform_deletion_ledger_append_only
  BEFORE UPDATE OR DELETE ON platform_deletion_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_platform_deletion_ledger_mutation();

CREATE FUNCTION record_platform_deletion_ledger_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  event_type_value text;
  subject_id_value uuid;
  workspace_id_value uuid;
  user_id_value uuid;
  identity_key_value text;
  metadata_value jsonb := '{}'::jsonb;
BEGIN
  IF public.platform_deletion_ledger_replay_active() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'workspaces' THEN
    IF TG_OP = 'DELETE' THEN
      event_type_value := 'workspace.deleted';
      subject_id_value := OLD.id;
      workspace_id_value := OLD.id;
      user_id_value := OLD.owner_user_id;
      identity_key_value := OLD.broadcaster_twitch_user_id;
      metadata_value := jsonb_build_object(
        'broadcasterTwitchUserId', OLD.broadcaster_twitch_user_id
      );
    ELSIF TG_OP = 'UPDATE' AND (
      OLD.status IS DISTINCT FROM NEW.status
      OR OLD.restriction_reason IS DISTINCT FROM NEW.restriction_reason
    ) THEN
      event_type_value := CASE WHEN NEW.status = 'active'
        THEN 'workspace.access.granted' ELSE 'workspace.access.revoked' END;
      subject_id_value := NEW.id;
      workspace_id_value := NEW.id;
      user_id_value := NEW.owner_user_id;
      identity_key_value := NEW.broadcaster_twitch_user_id;
      metadata_value := jsonb_build_object(
        'status', NEW.status,
        'restrictionReason', NEW.restriction_reason
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'platform_users' THEN
    IF TG_OP = 'DELETE' THEN
      event_type_value := 'user.deleted';
      subject_id_value := OLD.id;
      user_id_value := OLD.id;
      identity_key_value := OLD.twitch_user_id;
    ELSIF TG_OP = 'UPDATE' AND (
      OLD.status IS DISTINCT FROM NEW.status
      OR OLD.suspension_reason IS DISTINCT FROM NEW.suspension_reason
    ) THEN
      event_type_value := CASE WHEN NEW.status = 'active'
        THEN 'user.access.granted' ELSE 'user.access.revoked' END;
      subject_id_value := NEW.id;
      user_id_value := NEW.id;
      identity_key_value := NEW.twitch_user_id;
      metadata_value := jsonb_build_object(
        'status', NEW.status,
        'suspendedAt', NEW.suspended_at,
        'suspensionReason', NEW.suspension_reason
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'provider_credentials' THEN
    IF TG_OP = 'DELETE'
       OR (TG_OP = 'UPDATE' AND (
         OLD.id IS DISTINCT FROM NEW.id
         OR (OLD.status = 'connected' AND NEW.status <> 'connected')
       )) THEN
      event_type_value := 'credential.revoked';
      subject_id_value := OLD.id;
      workspace_id_value := OLD.workspace_id;
      metadata_value := jsonb_build_object(
        'credentialTable', 'provider_credentials',
        'providerInstanceId', OLD.provider_instance_id,
        'previousStatus', OLD.status
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'workspace_integrations' THEN
    IF (TG_OP = 'DELETE' AND OLD.credential_ciphertext IS NOT NULL)
       OR (TG_OP = 'UPDATE' AND OLD.credential_ciphertext IS NOT NULL AND (
         NEW.credential_ciphertext IS NULL
         OR NEW.credential_ciphertext IS DISTINCT FROM OLD.credential_ciphertext
         OR (OLD.status = 'connected' AND NEW.status <> 'connected')
       )) THEN
      event_type_value := 'credential.revoked';
      subject_id_value := OLD.id;
      workspace_id_value := OLD.workspace_id;
      metadata_value := jsonb_build_object(
        'credentialTable', 'workspace_integrations',
        'credentialFingerprint', md5(encode(OLD.credential_ciphertext, 'hex')),
        'provider', OLD.provider
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'user_sessions' THEN
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE'
       AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
      event_type_value := 'session.revoked';
      subject_id_value := OLD.id;
      user_id_value := OLD.user_id;
      metadata_value := jsonb_build_object('expiresAt', OLD.expires_at);
    END IF;
  ELSIF TG_TABLE_NAME = 'workspace_memberships' THEN
    IF TG_OP = 'INSERT' THEN
      event_type_value := 'membership.granted';
      subject_id_value := NEW.user_id;
      workspace_id_value := NEW.workspace_id;
      user_id_value := NEW.user_id;
      metadata_value := jsonb_build_object(
        'membershipId', NEW.id, 'role', NEW.role, 'createdAt', NEW.created_at
      );
    ELSIF TG_OP = 'DELETE' THEN
      event_type_value := 'membership.revoked';
      subject_id_value := OLD.user_id;
      workspace_id_value := OLD.workspace_id;
      user_id_value := OLD.user_id;
      metadata_value := jsonb_build_object(
        'membershipId', OLD.id, 'role', OLD.role, 'createdAt', OLD.created_at
      );
    ELSIF TG_OP = 'UPDATE' AND (
      OLD.status IS DISTINCT FROM NEW.status OR OLD.role IS DISTINCT FROM NEW.role
    ) THEN
      event_type_value := CASE WHEN NEW.status = 'active'
        THEN 'membership.granted' ELSE 'membership.revoked' END;
      subject_id_value := NEW.user_id;
      workspace_id_value := NEW.workspace_id;
      user_id_value := NEW.user_id;
      metadata_value := jsonb_build_object(
        'membershipId', NEW.id, 'role', NEW.role, 'createdAt', NEW.created_at
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'workspace_invitations' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'pending'
       AND NEW.status IN ('cancelled', 'declined', 'expired') THEN
      event_type_value := 'invitation.revoked';
      subject_id_value := OLD.id;
      workspace_id_value := OLD.workspace_id;
      identity_key_value := OLD.invited_twitch_user_id;
      metadata_value := jsonb_build_object('status', NEW.status, 'respondedAt', NEW.responded_at);
    END IF;
  ELSIF TG_TABLE_NAME = 'workspace_support_access' THEN
    IF TG_OP = 'INSERT' THEN
      event_type_value := 'support_access.granted';
      subject_id_value := NEW.id;
      workspace_id_value := NEW.workspace_id;
      user_id_value := NEW.support_user_id;
      identity_key_value := NEW.support_twitch_user_id;
      metadata_value := jsonb_build_object(
        'supportTwitchUserId', NEW.support_twitch_user_id,
        'grantedByUserId', NEW.granted_by_user_id,
        'reason', NEW.reason,
        'scopes', NEW.scopes,
        'createdAt', NEW.created_at,
        'expiresAt', NEW.expires_at
      );
    ELSIF TG_OP = 'DELETE' THEN
      event_type_value := 'support_access.revoked';
      subject_id_value := OLD.id;
      workspace_id_value := OLD.workspace_id;
      user_id_value := OLD.support_user_id;
      identity_key_value := OLD.support_twitch_user_id;
      metadata_value := jsonb_build_object(
        'supportTwitchUserId', OLD.support_twitch_user_id,
        'grantedByUserId', OLD.granted_by_user_id,
        'revokedByUserId', OLD.revoked_by_user_id,
        'reason', OLD.reason,
        'scopes', OLD.scopes,
        'createdAt', OLD.created_at,
        'expiresAt', OLD.expires_at,
        'revokedAt', COALESCE(OLD.revoked_at, clock_timestamp())
      );
    ELSIF TG_OP = 'UPDATE' AND (
      OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
      OR OLD.scopes IS DISTINCT FROM NEW.scopes
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
      OR OLD.reason IS DISTINCT FROM NEW.reason
    ) THEN
      event_type_value := CASE WHEN NEW.revoked_at IS NULL
        THEN 'support_access.granted' ELSE 'support_access.revoked' END;
      subject_id_value := NEW.id;
      workspace_id_value := NEW.workspace_id;
      user_id_value := NEW.support_user_id;
      identity_key_value := NEW.support_twitch_user_id;
      metadata_value := jsonb_build_object(
        'supportTwitchUserId', NEW.support_twitch_user_id,
        'grantedByUserId', NEW.granted_by_user_id,
        'revokedByUserId', NEW.revoked_by_user_id,
        'reason', NEW.reason,
        'scopes', NEW.scopes,
        'createdAt', NEW.created_at,
        'expiresAt', NEW.expires_at,
        'revokedAt', NEW.revoked_at
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'platform_administrators' THEN
    IF TG_OP = 'INSERT' THEN
      event_type_value := 'platform_admin.granted';
      subject_id_value := NEW.user_id;
      user_id_value := NEW.user_id;
      identity_key_value := NEW.twitch_user_id;
      metadata_value := jsonb_build_object(
        'role', NEW.role, 'permissions', NEW.permissions, 'appointedAt', NEW.appointed_at
      );
    ELSIF TG_OP = 'UPDATE' AND NEW.revoked_at IS NULL AND (
      OLD.revoked_at IS NOT NULL
      OR OLD.role IS DISTINCT FROM NEW.role
      OR OLD.permissions IS DISTINCT FROM NEW.permissions
    ) THEN
      event_type_value := 'platform_admin.granted';
      subject_id_value := NEW.user_id;
      user_id_value := NEW.user_id;
      identity_key_value := NEW.twitch_user_id;
      metadata_value := jsonb_build_object(
        'role', NEW.role, 'permissions', NEW.permissions, 'appointedAt', NEW.appointed_at
      );
    ELSIF TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
      event_type_value := 'platform_admin.revoked';
      subject_id_value := OLD.user_id;
      user_id_value := OLD.user_id;
      identity_key_value := OLD.twitch_user_id;
      metadata_value := jsonb_build_object('revokedAt', NEW.revoked_at);
    END IF;
  END IF;

  IF event_type_value IS NOT NULL THEN
    INSERT INTO public.platform_deletion_ledger (
      event_type, subject_id, affected_workspace_id, user_id, identity_key, metadata
    ) VALUES (
      event_type_value, subject_id_value, workspace_id_value, user_id_value,
      identity_key_value, metadata_value
    );
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION record_platform_deletion_ledger_event() OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION record_platform_deletion_ledger_event() FROM PUBLIC;

CREATE TRIGGER workspaces_deletion_ledger
  BEFORE DELETE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION record_platform_deletion_ledger_event();
CREATE TRIGGER platform_users_deletion_ledger
  BEFORE DELETE ON platform_users
  FOR EACH ROW EXECUTE FUNCTION record_platform_deletion_ledger_event();
CREATE TRIGGER platform_users_access_ledger
  AFTER UPDATE OF status, suspension_reason ON platform_users
  FOR EACH ROW EXECUTE FUNCTION record_platform_deletion_ledger_event();
CREATE TRIGGER user_sessions_deletion_ledger
  AFTER DELETE OR UPDATE OF revoked_at ON user_sessions
  FOR EACH ROW EXECUTE FUNCTION record_platform_deletion_ledger_event();
CREATE TRIGGER workspaces_access_ledger
  AFTER UPDATE OF status, restriction_reason ON workspaces
  FOR EACH ROW EXECUTE FUNCTION record_platform_deletion_ledger_event();
CREATE TRIGGER provider_credentials_deletion_ledger
  AFTER DELETE OR UPDATE ON provider_credentials
  FOR EACH ROW EXECUTE FUNCTION record_platform_deletion_ledger_event();
CREATE TRIGGER workspace_integrations_deletion_ledger
  AFTER DELETE OR UPDATE ON workspace_integrations
  FOR EACH ROW EXECUTE FUNCTION record_platform_deletion_ledger_event();
CREATE TRIGGER workspace_support_access_deletion_ledger
  AFTER INSERT OR UPDATE OR DELETE ON workspace_support_access
  FOR EACH ROW EXECUTE FUNCTION record_platform_deletion_ledger_event();
CREATE TRIGGER workspace_memberships_deletion_ledger
  AFTER INSERT OR UPDATE OR DELETE ON workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION record_platform_deletion_ledger_event();
CREATE TRIGGER workspace_invitations_deletion_ledger
  AFTER UPDATE ON workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION record_platform_deletion_ledger_event();
CREATE TRIGGER platform_administrators_deletion_ledger
  AFTER INSERT OR UPDATE ON platform_administrators
  FOR EACH ROW EXECUTE FUNCTION record_platform_deletion_ledger_event();

CREATE FUNCTION prevent_platform_deletion_ledger_resurrection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.platform_deletion_ledger_replay_active() THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'platform_users' THEN
    IF EXISTS (
      SELECT 1 FROM public.platform_deletion_ledger
       WHERE event_type = 'user.deleted' AND identity_key = NEW.twitch_user_id
    ) THEN
      RAISE EXCEPTION 'this Twitch identity has a permanent deletion tombstone'
        USING ERRCODE = '23505';
    END IF;
  ELSIF TG_TABLE_NAME = 'workspaces' THEN
    IF EXISTS (
      SELECT 1 FROM public.platform_deletion_ledger
       WHERE event_type = 'workspace.deleted' AND subject_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'this workspace has a permanent deletion tombstone'
        USING ERRCODE = '23505';
    END IF;
  ELSIF TG_TABLE_NAME = 'provider_credentials' THEN
    IF EXISTS (
      SELECT 1 FROM public.platform_deletion_ledger
       WHERE event_type = 'credential.revoked' AND subject_id = NEW.id
         AND COALESCE(metadata->>'credentialTable', 'provider_credentials') = 'provider_credentials'
    ) THEN
      RAISE EXCEPTION 'this provider credential has a revocation tombstone'
        USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION prevent_platform_deletion_ledger_resurrection() OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION prevent_platform_deletion_ledger_resurrection() FROM PUBLIC;

CREATE TRIGGER platform_users_deletion_tombstone
  BEFORE INSERT ON platform_users
  FOR EACH ROW EXECUTE FUNCTION prevent_platform_deletion_ledger_resurrection();
CREATE TRIGGER workspaces_deletion_tombstone
  BEFORE INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION prevent_platform_deletion_ledger_resurrection();
CREATE TRIGGER provider_credentials_deletion_tombstone
  BEFORE INSERT ON provider_credentials
  FOR EACH ROW EXECUTE FUNCTION prevent_platform_deletion_ledger_resurrection();

-- The replay role gets narrowly-scoped policies that are usable only inside
-- the SECURITY DEFINER replay function while its transaction-local guard is set.
CREATE POLICY deletion_ledger_replay_context ON platform_users
  TO platform_migrator USING (public.platform_deletion_ledger_replay_active())
  WITH CHECK (public.platform_deletion_ledger_replay_active());
CREATE POLICY deletion_ledger_replay_context ON user_sessions
  TO platform_migrator USING (public.platform_deletion_ledger_replay_active())
  WITH CHECK (public.platform_deletion_ledger_replay_active());
CREATE POLICY deletion_ledger_replay_context ON workspaces
  TO platform_migrator USING (public.platform_deletion_ledger_replay_active())
  WITH CHECK (public.platform_deletion_ledger_replay_active());
CREATE POLICY deletion_ledger_replay_context ON workspace_memberships
  TO platform_migrator USING (public.platform_deletion_ledger_replay_active())
  WITH CHECK (public.platform_deletion_ledger_replay_active());
CREATE POLICY deletion_ledger_replay_context ON provider_credentials
  TO platform_migrator USING (public.platform_deletion_ledger_replay_active())
  WITH CHECK (public.platform_deletion_ledger_replay_active());
CREATE POLICY deletion_ledger_replay_context ON workspace_integrations
  TO platform_migrator USING (public.platform_deletion_ledger_replay_active())
  WITH CHECK (public.platform_deletion_ledger_replay_active());
CREATE POLICY deletion_ledger_replay_context ON workspace_support_access
  TO platform_migrator USING (public.platform_deletion_ledger_replay_active())
  WITH CHECK (public.platform_deletion_ledger_replay_active());
CREATE POLICY deletion_ledger_replay_context ON workspace_invitations
  TO platform_migrator USING (public.platform_deletion_ledger_replay_active())
  WITH CHECK (public.platform_deletion_ledger_replay_active());


-- The baseline spans global identity/workspace tables as well as forced-RLS
-- workspace tables. Use the same transaction-local policy gate as recovery replay.
DO $$
DECLARE replay_token_value text;
BEGIN
  SELECT replay_token::text INTO replay_token_value
    FROM platform_deletion_ledger_control WHERE singleton;
  PERFORM set_config('app.deletion_ledger_replay', replay_token_value, true);
END $$;

-- Seed the journal with the current access/revocation state. This gives a
-- restore from a pre-0050 snapshot a stable baseline before later events replay.
INSERT INTO platform_deletion_ledger (
  event_type, subject_id, affected_workspace_id, user_id, identity_key, metadata, occurred_at
)
SELECT CASE WHEN status = 'active' THEN 'workspace.access.granted' ELSE 'workspace.access.revoked' END,
       id, id, owner_user_id, broadcaster_twitch_user_id,
       jsonb_build_object('status', status, 'restrictionReason', restriction_reason),
       updated_at
  FROM workspaces;

INSERT INTO platform_deletion_ledger (
  event_type, subject_id, user_id, identity_key, metadata, occurred_at
)
SELECT CASE WHEN status = 'active' THEN 'user.access.granted' ELSE 'user.access.revoked' END,
       id, id, twitch_user_id,
       jsonb_build_object('status', status, 'suspendedAt', suspended_at, 'suspensionReason', suspension_reason),
       updated_at
  FROM platform_users;

INSERT INTO platform_deletion_ledger (
  event_type, subject_id, user_id, metadata, occurred_at
)
SELECT 'session.revoked', id, user_id,
       jsonb_build_object('expiresAt', expires_at),
       revoked_at
  FROM user_sessions
 WHERE revoked_at IS NOT NULL;

INSERT INTO platform_deletion_ledger (
  event_type, subject_id, affected_workspace_id, user_id, metadata, occurred_at
)
SELECT CASE WHEN status = 'active' THEN 'membership.granted' ELSE 'membership.revoked' END,
       user_id, workspace_id, user_id,
       jsonb_build_object('membershipId', id, 'role', role, 'createdAt', created_at),
       CASE WHEN status = 'revoked' THEN COALESCE(revoked_at, updated_at) ELSE updated_at END
  FROM workspace_memberships;

INSERT INTO platform_deletion_ledger (
  event_type, subject_id, affected_workspace_id, identity_key, metadata, occurred_at
)
SELECT 'invitation.revoked', id, workspace_id, invited_twitch_user_id,
       jsonb_build_object('status', status, 'respondedAt', responded_at),
       COALESCE(responded_at, created_at)
  FROM workspace_invitations
 WHERE status IN ('cancelled', 'declined', 'expired');

INSERT INTO platform_deletion_ledger (
  event_type, subject_id, user_id, identity_key, metadata, occurred_at
)
SELECT CASE WHEN revoked_at IS NULL THEN 'platform_admin.granted' ELSE 'platform_admin.revoked' END,
       user_id, user_id, twitch_user_id,
       CASE WHEN revoked_at IS NULL
         THEN jsonb_build_object('role', role, 'permissions', permissions, 'appointedAt', appointed_at)
         ELSE jsonb_build_object('revokedAt', revoked_at)
       END,
       CASE WHEN revoked_at IS NULL THEN updated_at ELSE revoked_at END
  FROM platform_administrators;

INSERT INTO platform_deletion_ledger (
  event_type, subject_id, affected_workspace_id, metadata, occurred_at
)
SELECT 'credential.revoked', id, workspace_id,
       jsonb_build_object('providerInstanceId', provider_instance_id, 'previousStatus', status),
       COALESCE(disconnected_at, updated_at, created_at)
  FROM provider_credentials
 WHERE status <> 'connected';

INSERT INTO platform_deletion_ledger (
  event_type, subject_id, affected_workspace_id, metadata, occurred_at
)
SELECT 'credential.revoked', id, workspace_id,
       jsonb_build_object(
         'credentialTable', 'workspace_integrations',
         'credentialFingerprint', md5(encode(credential_ciphertext, 'hex')),
         'provider', provider
       ),
       COALESCE(disconnected_at, updated_at, created_at)
  FROM workspace_integrations
 WHERE credential_ciphertext IS NOT NULL
   AND status <> 'connected';

INSERT INTO platform_deletion_ledger (
  event_type, subject_id, affected_workspace_id, user_id, identity_key, metadata, occurred_at
)
SELECT CASE WHEN revoked_at IS NULL THEN 'support_access.granted' ELSE 'support_access.revoked' END,
       id, workspace_id, support_user_id, support_twitch_user_id,
       jsonb_build_object(
         'supportTwitchUserId', support_twitch_user_id,
         'grantedByUserId', granted_by_user_id,
         'revokedByUserId', revoked_by_user_id,
         'reason', reason,
         'scopes', scopes,
         'createdAt', created_at,
         'expiresAt', expires_at,
         'revokedAt', revoked_at
       ),
       COALESCE(revoked_at, created_at)
  FROM workspace_support_access;

SELECT set_config('app.deletion_ledger_replay', '', true);

CREATE FUNCTION export_platform_deletion_ledger()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'format', 'multi-streamer-audio-platform.deletion-ledger',
    'schemaVersion', 1,
    'exportedAt', clock_timestamp(),
    'entries', COALESCE(
      jsonb_agg(jsonb_build_object(
        'entryId', entry_id,
        'eventId', event_id,
        'eventType', event_type,
        'subjectId', subject_id,
        'workspaceId', affected_workspace_id,
        'userId', user_id,
        'identityKey', identity_key,
        'metadata', metadata,
        'occurredAt', occurred_at
      ) ORDER BY entry_id),
      '[]'::jsonb
    )
  )
  FROM public.platform_deletion_ledger
$$;
ALTER FUNCTION export_platform_deletion_ledger() OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION export_platform_deletion_ledger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_platform_deletion_ledger() TO platform_migrator;

CREATE FUNCTION replay_platform_deletion_ledger(p_document jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  replayed_count integer := 0;
  event_row record;
  previous_replay_setting text := current_setting('app.deletion_ledger_replay', true);
  replay_token_value text;
BEGIN
  IF p_document IS NULL
     OR p_document->>'format' <> 'multi-streamer-audio-platform.deletion-ledger'
     OR p_document->>'schemaVersion' <> '1' THEN
    RAISE EXCEPTION 'unsupported or invalid deletion ledger document'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_document->'entries') <> 'array' THEN
    RAISE EXCEPTION 'deletion ledger entries must be an array'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_document->'entries') > 1000000 THEN
    RAISE EXCEPTION 'deletion ledger exceeds the replay safety limit'
      USING ERRCODE = '22023';
  END IF;

  SELECT replay_token::text INTO replay_token_value
    FROM public.platform_deletion_ledger_control WHERE singleton;
  PERFORM set_config('app.deletion_ledger_replay', replay_token_value, true);

  INSERT INTO public.platform_deletion_ledger (
    event_id, event_type, subject_id, affected_workspace_id, user_id,
    identity_key, metadata, occurred_at
  )
  SELECT "eventId", "eventType", "subjectId", "workspaceId", "userId",
         "identityKey", COALESCE(metadata, '{}'::jsonb), "occurredAt"
    FROM jsonb_to_recordset(p_document->'entries') AS entries(
      "entryId" bigint,
      "eventId" uuid,
      "eventType" text,
      "subjectId" uuid,
      "workspaceId" uuid,
      "userId" uuid,
      "identityKey" text,
      metadata jsonb,
      "occurredAt" timestamptz
    )
  ON CONFLICT (event_id) DO NOTHING;

  -- Workspace tombstones are applied first because they cascade through every
  -- workspace-owned credential, membership, invitation, asset, and setting.
  FOR event_row IN
    SELECT DISTINCT subject_id
      FROM public.platform_deletion_ledger
     WHERE event_type = 'workspace.deleted'
     ORDER BY subject_id
  LOOP
    DELETE FROM public.workspaces WHERE id = event_row.subject_id;
  END LOOP;

  FOR event_row IN
    SELECT DISTINCT ON (subject_id) subject_id, metadata, occurred_at
      FROM public.platform_deletion_ledger
     WHERE event_type IN ('workspace.access.granted', 'workspace.access.revoked')
     ORDER BY subject_id, occurred_at DESC, entry_id DESC
  LOOP
    UPDATE public.workspaces
       SET status = (event_row.metadata->>'status')::workspace_status,
           restriction_reason = event_row.metadata->>'restrictionReason',
           updated_at = event_row.occurred_at
     WHERE id = event_row.subject_id;
  END LOOP;

  FOR event_row IN
    SELECT DISTINCT ON (subject_id) subject_id, metadata, occurred_at
      FROM public.platform_deletion_ledger
     WHERE event_type IN ('user.access.granted', 'user.access.revoked')
     ORDER BY subject_id, occurred_at DESC, entry_id DESC
  LOOP
    UPDATE public.platform_users
       SET status = (event_row.metadata->>'status')::account_status,
           suspended_at = (event_row.metadata->>'suspendedAt')::timestamptz,
           suspension_reason = event_row.metadata->>'suspensionReason',
           updated_at = event_row.occurred_at
     WHERE id = event_row.subject_id;
    IF event_row.metadata->>'status' = 'suspended' THEN
      UPDATE public.user_sessions
         SET revoked_at = event_row.occurred_at
       WHERE user_id = event_row.subject_id
         AND revoked_at IS NULL;
    END IF;
  END LOOP;

  FOR event_row IN
    SELECT DISTINCT ON (subject_id) subject_id, occurred_at
      FROM public.platform_deletion_ledger
     WHERE event_type = 'session.revoked'
     ORDER BY subject_id, occurred_at DESC, entry_id DESC
  LOOP
    UPDATE public.user_sessions
       SET revoked_at = event_row.occurred_at
     WHERE id = event_row.subject_id
       AND revoked_at IS NULL;
  END LOOP;

  FOR event_row IN
    SELECT subject_id, metadata, occurred_at
      FROM public.platform_deletion_ledger
     WHERE event_type = 'credential.revoked'
     ORDER BY occurred_at, entry_id
  LOOP
    IF event_row.metadata->>'credentialTable' = 'workspace_integrations' THEN
      UPDATE public.workspace_integrations
         SET credential_ciphertext = NULL,
             credential_nonce = NULL,
             credential_auth_tag = NULL,
             wrapped_dek = NULL,
             dek_nonce = NULL,
             dek_auth_tag = NULL,
             kek_version = NULL,
             credential_format_version = NULL,
             status = 'disconnected',
             external_account_id = NULL,
             granted_scopes = '{}',
             token_expires_at = NULL,
             disconnected_at = event_row.occurred_at,
             updated_at = event_row.occurred_at
       WHERE id = event_row.subject_id
         AND credential_ciphertext IS NOT NULL
         AND md5(encode(credential_ciphertext, 'hex')) =
             event_row.metadata->>'credentialFingerprint';
    ELSE
      DELETE FROM public.provider_credentials WHERE id = event_row.subject_id;
    END IF;
  END LOOP;

  FOR event_row IN
    SELECT DISTINCT ON (affected_workspace_id, subject_id)
           event_type, subject_id, affected_workspace_id AS workspace_id, occurred_at, metadata
      FROM public.platform_deletion_ledger
     WHERE event_type IN ('membership.granted', 'membership.revoked')
       AND affected_workspace_id IS NOT NULL
     ORDER BY affected_workspace_id, subject_id, occurred_at DESC, entry_id DESC
  LOOP
    IF EXISTS (SELECT 1 FROM public.workspaces WHERE id = event_row.workspace_id)
       AND EXISTS (SELECT 1 FROM public.platform_users WHERE id = event_row.subject_id)
       AND NOT EXISTS (
         SELECT 1 FROM public.platform_deletion_ledger
          WHERE event_type = 'user.deleted'
            AND (subject_id = event_row.subject_id OR identity_key = (
              SELECT twitch_user_id FROM public.platform_users WHERE id = event_row.subject_id
            ))
       ) THEN
      IF event_row.event_type = 'membership.revoked' THEN
        UPDATE public.workspace_memberships
           SET status = 'revoked',
               revoked_at = event_row.occurred_at,
               updated_at = event_row.occurred_at
         WHERE workspace_id = event_row.workspace_id
           AND user_id = event_row.subject_id
           AND role <> 'owner';
      ELSE
        INSERT INTO public.workspace_memberships (
          id, workspace_id, user_id, role, status, created_at, updated_at, revoked_at
        ) VALUES (
          (event_row.metadata->>'membershipId')::uuid,
          event_row.workspace_id,
          event_row.subject_id,
          (event_row.metadata->>'role')::workspace_role,
          'active',
          COALESCE((event_row.metadata->>'createdAt')::timestamptz, event_row.occurred_at),
          event_row.occurred_at,
          NULL
        )
        ON CONFLICT (workspace_id, user_id) DO UPDATE
          SET role = EXCLUDED.role,
              status = 'active',
              revoked_at = NULL,
              updated_at = EXCLUDED.updated_at
        WHERE workspace_memberships.role <> 'owner'
           OR workspace_memberships.user_id = EXCLUDED.user_id;
      END IF;
    END IF;
  END LOOP;

  FOR event_row IN
    SELECT DISTINCT ON (subject_id)
           subject_id, affected_workspace_id, user_id, identity_key, event_type, metadata, occurred_at
      FROM public.platform_deletion_ledger
     WHERE event_type IN ('support_access.granted', 'support_access.revoked')
     ORDER BY subject_id, occurred_at DESC, entry_id DESC
  LOOP
    IF event_row.event_type = 'support_access.revoked' THEN
      DELETE FROM public.workspace_support_access WHERE id = event_row.subject_id;
    ELSIF EXISTS (
      SELECT 1 FROM public.workspaces WHERE id = event_row.affected_workspace_id
    ) AND EXISTS (
      SELECT 1 FROM public.platform_users WHERE id = event_row.user_id
    ) AND NOT EXISTS (
      SELECT 1 FROM public.platform_deletion_ledger
       WHERE event_type = 'user.deleted'
         AND (subject_id = event_row.user_id OR identity_key = event_row.identity_key)
    ) THEN
      INSERT INTO public.workspace_support_access (
        id, workspace_id, support_user_id, support_twitch_user_id,
        granted_by_user_id, reason, scopes, created_at, expires_at
      )
      SELECT event_row.subject_id,
             event_row.affected_workspace_id,
             event_row.user_id,
             event_row.identity_key,
             CASE WHEN EXISTS (
               SELECT 1 FROM public.platform_users
                WHERE id = (event_row.metadata->>'grantedByUserId')::uuid
             ) THEN (event_row.metadata->>'grantedByUserId')::uuid ELSE NULL END,
             event_row.metadata->>'reason',
             ARRAY(SELECT jsonb_array_elements_text(event_row.metadata->'scopes')),
             (event_row.metadata->>'createdAt')::timestamptz,
             (event_row.metadata->>'expiresAt')::timestamptz
      ON CONFLICT (id) DO UPDATE
        SET granted_by_user_id = EXCLUDED.granted_by_user_id,
            reason = EXCLUDED.reason,
            scopes = EXCLUDED.scopes,
            expires_at = EXCLUDED.expires_at,
            revoked_at = NULL,
            revoked_by_user_id = NULL;
    END IF;
  END LOOP;

  FOR event_row IN
    SELECT DISTINCT ON (subject_id) subject_id, affected_workspace_id AS workspace_id, metadata, occurred_at
      FROM public.platform_deletion_ledger
     WHERE event_type = 'invitation.revoked'
     ORDER BY subject_id, occurred_at DESC, entry_id DESC
  LOOP
    UPDATE public.workspace_invitations
       SET status = (event_row.metadata->>'status')::invitation_status,
           responded_at = COALESCE((event_row.metadata->>'respondedAt')::timestamptz, event_row.occurred_at)
     WHERE id = event_row.subject_id
       AND status = 'pending';
  END LOOP;

  FOR event_row IN
    SELECT DISTINCT ON (subject_id)
           subject_id, event_type, occurred_at, metadata
      FROM public.platform_deletion_ledger
     WHERE event_type IN ('platform_admin.granted', 'platform_admin.revoked')
     ORDER BY subject_id, occurred_at DESC, entry_id DESC
  LOOP
    IF event_row.event_type = 'platform_admin.revoked' THEN
      UPDATE public.platform_administrators
         SET revoked_at = event_row.occurred_at,
             updated_at = event_row.occurred_at
       WHERE user_id = event_row.subject_id
         AND revoked_at IS NULL;
    ELSE
      INSERT INTO public.platform_administrators (
        user_id, twitch_user_id, role, permissions, appointed_at, updated_at, revoked_at
      )
      SELECT u.id, u.twitch_user_id,
             (event_row.metadata->>'role')::platform_administrator_role,
             ARRAY(SELECT jsonb_array_elements_text(event_row.metadata->'permissions')),
             COALESCE((event_row.metadata->>'appointedAt')::timestamptz, event_row.occurred_at),
             event_row.occurred_at,
             NULL
        FROM public.platform_users u
       WHERE u.id = event_row.subject_id
      ON CONFLICT (user_id) DO UPDATE
        SET role = EXCLUDED.role,
            permissions = EXCLUDED.permissions,
            revoked_at = NULL,
            updated_at = EXCLUDED.updated_at;
    END IF;
  END LOOP;

  -- Account deletion follows workspace deletion and access revocation so that
  -- RESTRICT foreign keys cannot retain a deleted identity from an old backup.
  FOR event_row IN
    SELECT DISTINCT ON (subject_id) subject_id, identity_key, occurred_at
      FROM public.platform_deletion_ledger
     WHERE event_type = 'user.deleted'
     ORDER BY subject_id, occurred_at DESC, entry_id DESC
  LOOP
    DELETE FROM public.workspace_memberships
     WHERE user_id = event_row.subject_id;
    IF event_row.identity_key IS NOT NULL THEN
      DELETE FROM public.workspace_invitations
       WHERE invited_twitch_user_id = event_row.identity_key;
    END IF;
    -- A completed user-deletion tombstone proves the assignment had already
    -- been revoked before the account was removed, even if the backup predates
    -- the separate administrator-revocation event.
    UPDATE public.platform_administrators
       SET revoked_at = COALESCE(revoked_at, event_row.occurred_at),
           updated_at = event_row.occurred_at
     WHERE user_id = event_row.subject_id
       AND revoked_at IS NULL;
    DELETE FROM public.platform_administrators
     WHERE user_id = event_row.subject_id;
    DELETE FROM public.platform_users
     WHERE id = event_row.subject_id
        OR (event_row.identity_key IS NOT NULL AND twitch_user_id = event_row.identity_key);
  END LOOP;

  SELECT count(*) INTO replayed_count
    FROM public.platform_deletion_ledger;
  PERFORM set_config(
    'app.deletion_ledger_replay',
    COALESCE(previous_replay_setting, ''),
    true
  );
  RETURN replayed_count;
END;
$$;
ALTER FUNCTION replay_platform_deletion_ledger(jsonb) OWNER TO platform_migrator;
REVOKE ALL ON FUNCTION replay_platform_deletion_ledger(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replay_platform_deletion_ledger(jsonb) TO platform_migrator;

CREATE OR REPLACE FUNCTION audit_platform_account_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_audit$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  action_reason text := nullif(btrim(current_setting('app.platform_status_reason', true)), '');
BEGIN
  IF public.platform_deletion_ledger_replay_active() THEN
    RETURN NEW;
  END IF;

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


CREATE OR REPLACE FUNCTION audit_platform_workspace_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_audit$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  action_reason text := nullif(btrim(current_setting('app.platform_status_reason', true)), '');
BEGIN
  IF public.platform_deletion_ledger_replay_active() THEN
    RETURN NEW;
  END IF;

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


COMMIT;
