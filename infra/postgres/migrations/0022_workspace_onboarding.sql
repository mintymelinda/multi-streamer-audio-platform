-- Phase 4 item 37: durable, resumable workspace onboarding progress.

CREATE TABLE workspace_onboarding (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  checklist jsonb NOT NULL DEFAULT '{"providers":"pending","rewards":"pending","moderation":"pending","overlay":"pending"}'::jsonb
    CHECK (jsonb_typeof(checklist) = 'object'),
  dismissed_at timestamptz,
  completed_at timestamptz,
  updated_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workspace_onboarding (workspace_id)
SELECT id FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;

ALTER TABLE workspace_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_onboarding FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_onboarding_member_read
  ON workspace_onboarding FOR SELECT
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_onboarding.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  );

CREATE POLICY workspace_onboarding_admin_write
  ON workspace_onboarding FOR ALL
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_onboarding.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_onboarding.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin')
    )
  );

GRANT SELECT, INSERT, UPDATE ON workspace_onboarding TO platform_runtime;
