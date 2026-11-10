-- Phase 5 item 45: workspace-owned scenes with independently revocable read-only access tokens.
CREATE TABLE overlay_scenes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  access_token_hash text UNIQUE
    CHECK (access_token_hash IS NULL OR access_token_hash ~ '^[a-f0-9]{64}$'),
  token_created_at timestamptz NOT NULL DEFAULT now(),
  token_revoked_at timestamptz,
  created_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((access_token_hash IS NULL) = (token_revoked_at IS NOT NULL))
);

CREATE INDEX overlay_scenes_workspace_order
  ON overlay_scenes (workspace_id, sort_order, created_at, id);

ALTER TABLE overlay_scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE overlay_scenes FORCE ROW LEVEL SECURITY;

CREATE POLICY overlay_scenes_workspace_access
  ON overlay_scenes FOR ALL
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = overlay_scenes.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = overlay_scenes.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  );

GRANT SELECT, INSERT, UPDATE ON overlay_scenes TO platform_runtime;
