-- Phase 3 item 29: explicit workspace-scoped provider/player output ownership.
CREATE TABLE provider_output_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_instance_id uuid NOT NULL,
  output_id text NOT NULL CHECK (length(output_id) BETWEEN 1 AND 200),
  player_id text NOT NULL CHECK (length(player_id) BETWEEN 1 AND 200),
  assigned_by uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, provider_instance_id) REFERENCES provider_instances(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX provider_output_assignments_active_output ON provider_output_assignments (workspace_id, output_id) WHERE active = true;
CREATE UNIQUE INDEX provider_output_assignments_active_instance ON provider_output_assignments (workspace_id, provider_instance_id) WHERE active = true;
CREATE INDEX provider_output_assignments_workspace_active ON provider_output_assignments (workspace_id, active);
ALTER TABLE provider_output_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_output_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_output_assignments_member_access ON provider_output_assignments
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = provider_output_assignments.workspace_id
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.status = 'active'))
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND EXISTS (
    SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = provider_output_assignments.workspace_id
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.status = 'active'));
GRANT SELECT, INSERT, UPDATE ON provider_output_assignments TO platform_runtime;
