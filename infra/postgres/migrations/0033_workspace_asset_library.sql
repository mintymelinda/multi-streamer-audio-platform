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
