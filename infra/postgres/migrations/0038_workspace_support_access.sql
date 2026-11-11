-- Phase 6 item 56: technical diagnostics and temporary, audited support access.
BEGIN;

CREATE TABLE workspace_support_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  support_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  granted_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 3
    AND scopes <@ ARRAY['workspace.read', 'requests.read', 'providers.read']::text[]
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);

CREATE INDEX workspace_support_access_active
  ON workspace_support_access (workspace_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX workspace_support_access_support_user
  ON workspace_support_access (support_user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE workspace_support_access_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid REFERENCES workspace_support_access(id) ON DELETE SET NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 120),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_support_access_audit_workspace
  ON workspace_support_access_audit (workspace_id, created_at DESC);
CREATE INDEX workspace_support_access_audit_actor
  ON workspace_support_access_audit (actor_user_id, created_at DESC);

CREATE FUNCTION prevent_workspace_support_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workspace support access audit records are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER workspace_support_access_audit_immutable
BEFORE UPDATE OR DELETE ON workspace_support_access_audit
FOR EACH ROW EXECUTE FUNCTION prevent_workspace_support_audit_mutation();

CREATE FUNCTION create_workspace_support_access(
  target_workspace_id uuid,
  requested_scopes text[],
  action_reason text,
  duration_minutes integer
)
RETURNS TABLE (id uuid, workspace_id uuid, scopes text[], reason text, created_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  actor_role platform_administrator_role;
  actor_permissions text[];
  created_grant public.workspace_support_access;
BEGIN
  SELECT role, permissions INTO actor_role, actor_permissions
    FROM public.platform_administrators
   WHERE user_id = actor_id AND revoked_at IS NULL;

  IF NOT FOUND OR (
    actor_role <> 'owner'
    AND NOT ('support_access.manage' = ANY(actor_permissions))
  ) THEN
    RAISE EXCEPTION 'support access management permission is required'
      USING ERRCODE = '42501';
  END IF;

  IF action_reason IS NULL OR length(btrim(action_reason)) NOT BETWEEN 1 AND 1000
     OR duration_minutes IS NULL OR duration_minutes NOT BETWEEN 5 AND 240
     OR cardinality(requested_scopes) NOT BETWEEN 1 AND 3
     OR NOT (requested_scopes <@ ARRAY['workspace.read', 'requests.read', 'providers.read']::text[]) THEN
    RAISE EXCEPTION 'a reason, valid read-only scopes, and a 5-240 minute duration are required'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = target_workspace_id) THEN
    RAISE EXCEPTION 'workspace not found'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.workspace_support_access (
    workspace_id, support_user_id, granted_by_user_id, reason, scopes, expires_at
  )
  VALUES (
    target_workspace_id, actor_id, actor_id, btrim(action_reason),
    ARRAY(SELECT DISTINCT scope FROM unnest(requested_scopes) AS scope ORDER BY scope),
    now() + make_interval(mins => duration_minutes)
  )
  RETURNING * INTO created_grant;

  INSERT INTO public.workspace_support_access_audit (
    grant_id, workspace_id, actor_user_id, action, reason, details
  )
  VALUES (
    created_grant.id, target_workspace_id, actor_id, 'support_access.granted',
    btrim(action_reason),
    jsonb_build_object('scopes', created_grant.scopes, 'expires_at', created_grant.expires_at)
  );

  RETURN QUERY SELECT created_grant.id, created_grant.workspace_id, created_grant.scopes,
                      created_grant.reason, created_grant.created_at, created_grant.expires_at;
END;
$$;

CREATE FUNCTION list_workspace_support_access(target_workspace_id uuid)
RETURNS TABLE (
  id uuid, support_twitch_user_id text, reason text, scopes text[],
  created_at timestamptz, expires_at timestamptz, revoked_at timestamptz, active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.workspaces w
     WHERE w.id = target_workspace_id AND w.owner_user_id = actor_id
  ) THEN
    RAISE EXCEPTION 'workspace owner access is required'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT access.id, users.twitch_user_id, access.reason, access.scopes,
           access.created_at, access.expires_at, access.revoked_at,
           (access.revoked_at IS NULL AND access.expires_at > now())
      FROM public.workspace_support_access access
      JOIN public.platform_users users ON users.id = access.support_user_id
     WHERE access.workspace_id = target_workspace_id
     ORDER BY access.created_at DESC;
END;
$$;

CREATE FUNCTION revoke_workspace_support_access(grant_id uuid, action_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  grant_row public.workspace_support_access;
BEGIN
  IF action_reason IS NULL OR length(btrim(action_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'a revocation reason is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO grant_row FROM public.workspace_support_access
   WHERE id = grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support access grant not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.workspaces
     WHERE id = grant_row.workspace_id AND owner_user_id = actor_id
  ) THEN
    RAISE EXCEPTION 'workspace owner access is required to revoke this grant'
      USING ERRCODE = '42501';
  END IF;

  IF grant_row.revoked_at IS NULL THEN
    UPDATE public.workspace_support_access
       SET revoked_at = now(), revoked_by_user_id = actor_id
     WHERE id = grant_id;

    INSERT INTO public.workspace_support_access_audit (
      grant_id, workspace_id, actor_user_id, action, reason
    )
    VALUES (grant_id, grant_row.workspace_id, actor_id, 'support_access.revoked', btrim(action_reason));
  END IF;
END;
$$;

CREATE FUNCTION read_support_workspace_content(grant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  grant_row public.workspace_support_access;
  result jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO grant_row FROM public.workspace_support_access
   WHERE id = grant_id
     AND support_user_id = actor_id
     AND revoked_at IS NULL
     AND expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active support access grant is required'
      USING ERRCODE = '42501';
  END IF;

  IF 'workspace.read' = ANY(grant_row.scopes) THEN
    result := result || jsonb_build_object(
      'workspace',
      (SELECT jsonb_build_object('id', w.id, 'name', w.name, 'status', w.status, 'createdAt', w.created_at)
         FROM public.workspaces w WHERE w.id = grant_row.workspace_id)
    );
  END IF;

  IF 'requests.read' = ANY(grant_row.scopes) THEN
    result := result || jsonb_build_object(
      'recentRequests',
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', request.id, 'title', request.title, 'artist', request.artist,
          'provider', request.provider, 'status', request.status,
          'submittedAt', request.submitted_at
        ) ORDER BY request.submitted_at DESC)
        FROM (
          SELECT id, title, artist, provider, status, submitted_at
            FROM public.media_requests
           WHERE workspace_id = grant_row.workspace_id
           ORDER BY submitted_at DESC LIMIT 50
        ) request
      ), '[]'::jsonb)
    );
  END IF;

  IF 'providers.read' = ANY(grant_row.scopes) THEN
    result := result || jsonb_build_object(
      'providers',
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'provider', provider_id, 'instance', instance_key,
          'health', connection_health, 'enabled', enabled, 'checkedAt', health_checked_at
        ) ORDER BY provider_id, instance_key)
        FROM public.provider_instances
        WHERE workspace_id = grant_row.workspace_id
      ), '[]'::jsonb)
    );
  END IF;

  INSERT INTO public.workspace_support_access_audit (
    grant_id, workspace_id, actor_user_id, action, reason, details
  )
  VALUES (
    grant_row.id, grant_row.workspace_id, actor_id, 'support_access.content_read',
    grant_row.reason, jsonb_build_object('scopes', grant_row.scopes)
  );

  RETURN result;
END;
$$;

CREATE FUNCTION get_workspace_technical_diagnostics(target_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  actor_role platform_administrator_role;
  actor_permissions text[];
BEGIN
  SELECT role, permissions INTO actor_role, actor_permissions
    FROM public.platform_administrators
   WHERE user_id = actor_id AND revoked_at IS NULL;

  IF NOT FOUND OR (
    actor_role <> 'owner'
    AND NOT ('workspaces.read' = ANY(actor_permissions))
  ) THEN
    RAISE EXCEPTION 'workspace diagnostic permission is required'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = target_workspace_id) THEN
    RAISE EXCEPTION 'workspace not found'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'workspaceId', target_workspace_id,
    'status', (SELECT status FROM public.workspaces WHERE id = target_workspace_id),
    'createdAt', (SELECT created_at FROM public.workspaces WHERE id = target_workspace_id),
    'providerHealth', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'provider', provider_id, 'health', connection_health, 'enabled', enabled,
        'checkedAt', health_checked_at, 'lastErrorCode', last_error_code
      ) ORDER BY provider_id)
      FROM public.provider_instances WHERE workspace_id = target_workspace_id
    ), '[]'::jsonb),
    'requestCounts', COALESCE((
      SELECT jsonb_object_agg(status, total)
      FROM (
        SELECT status, count(*)::integer AS total
          FROM public.media_requests WHERE workspace_id = target_workspace_id
         GROUP BY status
      ) counts
    ), '{}'::jsonb),
    'activeSupportGrantCount', (
      SELECT count(*)::integer FROM public.workspace_support_access
       WHERE workspace_id = target_workspace_id AND revoked_at IS NULL AND expires_at > now()
    )
  );
END;
$$;

REVOKE ALL ON workspace_support_access FROM platform_runtime;
REVOKE ALL ON workspace_support_access_audit FROM platform_runtime;
REVOKE ALL ON FUNCTION create_workspace_support_access(uuid, text[], text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_workspace_support_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_workspace_support_access(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_support_workspace_content(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_workspace_technical_diagnostics(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION create_workspace_support_access(uuid, text[], text, integer) TO platform_runtime;
GRANT EXECUTE ON FUNCTION list_workspace_support_access(uuid) TO platform_runtime;
GRANT EXECUTE ON FUNCTION revoke_workspace_support_access(uuid, text) TO platform_runtime;
GRANT EXECUTE ON FUNCTION read_support_workspace_content(uuid) TO platform_runtime;
GRANT EXECUTE ON FUNCTION get_workspace_technical_diagnostics(uuid) TO platform_runtime;

COMMIT;
