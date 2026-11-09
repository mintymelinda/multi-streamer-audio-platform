-- Phase 3 item 26: stable workspace-scoped provider instance identity.
-- Credentials remain in the encrypted credential store, never in this table.

CREATE TABLE provider_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (provider_id IN ('youtube', 'spotify', 'lyrion')),
  instance_key text NOT NULL CHECK (instance_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
  contract_version integer NOT NULL CHECK (contract_version > 0),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  connection_health text NOT NULL DEFAULT 'unconfigured'
    CHECK (connection_health IN ('healthy', 'degraded', 'unavailable', 'authorization_expired', 'unconfigured')),
  health_checked_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,80}$'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider_id, instance_key),
  UNIQUE (workspace_id, id)
);

CREATE INDEX provider_instances_workspace_enabled ON provider_instances (workspace_id, provider_id, enabled);
ALTER TABLE provider_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_instances FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_instances_member_access ON provider_instances
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = provider_instances.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
       WHERE m.workspace_id = provider_instances.workspace_id
         AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
         AND m.status = 'active'
    )
  );
GRANT SELECT, INSERT, UPDATE ON provider_instances TO platform_runtime;
