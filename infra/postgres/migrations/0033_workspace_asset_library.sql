-- Phase 5 workspace asset library: shared, private assets with stable identities.
CREATE TABLE workspace_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  folder_path text NOT NULL DEFAULT '' CHECK (length(folder_path) <= 512),
  object_key text,
  pending_object_key text,
  content_type text,
  pending_content_type text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size BETWEEN 1 AND 10485760),
  width integer CHECK (width IS NULL OR width BETWEEN 1 AND 8192),
  height integer CHECK (height IS NULL OR height BETWEEN 1 AND 8192),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  created_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'ready') = (object_key IS NOT NULL AND content_type IS NOT NULL AND byte_size IS NOT NULL)),
  CHECK ((pending_object_key IS NULL) = (pending_content_type IS NULL))
);

CREATE INDEX workspace_assets_folder_order
  ON workspace_assets (workspace_id, folder_path, name, id);
CREATE INDEX workspace_assets_pending
  ON workspace_assets (updated_at)
  WHERE pending_object_key IS NOT NULL;

ALTER TABLE workspace_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_assets FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_assets_workspace_access
  ON workspace_assets FOR ALL
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = workspace_assets.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = workspace_assets.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_assets TO platform_runtime;

-- The public overlay runtime can resolve only assets referenced by a scene
-- whose bearer token is valid; object keys remain server-side.
CREATE POLICY workspace_assets_migrator_read
  ON workspace_assets FOR SELECT TO platform_migrator
  USING (true);

CREATE FUNCTION get_overlay_scene_assets(p_scene_id uuid, p_token_hash text)
RETURNS TABLE (asset_id uuid, object_key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.id, a.object_key
    FROM public.overlay_scenes s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(s.published_state->'elements') = 'array'
           THEN s.published_state->'elements' ELSE '[]'::jsonb END
    ) element
    JOIN public.workspace_assets a
      ON a.id = CASE
        WHEN element->>'assetId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (element->>'assetId')::uuid ELSE NULL END
     AND a.workspace_id = s.workspace_id
     AND a.status = 'ready'
   WHERE s.id = p_scene_id
     AND s.access_token_hash = p_token_hash
     AND s.token_revoked_at IS NULL
$$;

REVOKE ALL ON FUNCTION get_overlay_scene_assets(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_overlay_scene_assets(uuid, text) TO platform_runtime;
