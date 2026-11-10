-- Phase 3 item 34: workspace rights attestations, report intake, content blocks,
-- provider-path restrictions, and an auditable rights-review record.

CREATE TABLE workspace_rights_attestations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_version text NOT NULL CHECK (length(btrim(policy_version)) BETWEEN 1 AND 40),
  accepted_by_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, policy_version)
);

CREATE TABLE rights_holder_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  claimant_name text NOT NULL CHECK (length(btrim(claimant_name)) BETWEEN 1 AND 200),
  claimant_contact text NOT NULL CHECK (length(btrim(claimant_contact)) BETWEEN 1 AND 320),
  provider_id text NOT NULL CHECK (length(btrim(provider_id)) BETWEEN 1 AND 80),
  media_id text NOT NULL CHECK (length(btrim(media_id)) BETWEEN 1 AND 300),
  content_url text,
  allegation text NOT NULL CHECK (length(btrim(allegation)) BETWEEN 1 AND 5000),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'investigating', 'decision_pending', 'escalated', 'closed')),
  assigned_reviewer_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  decision text CHECK (decision IN ('takedown', 'no_action', 'insufficient_evidence')),
  decision_reason text,
  decided_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision IS NULL) = (decided_at IS NULL))
);

CREATE INDEX rights_holder_reports_workspace_status
  ON rights_holder_reports (workspace_id, status, created_at DESC);

CREATE TABLE rights_report_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  report_id uuid NOT NULL,
  actor_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, report_id)
    REFERENCES rights_holder_reports(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX rights_report_events_report
  ON rights_report_events (workspace_id, report_id, created_at);

CREATE TABLE rights_content_blocks (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_id text NOT NULL CHECK (length(btrim(content_id)) BETWEEN 1 AND 300),
  blocked_by_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  preserve_evidence boolean NOT NULL DEFAULT true,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, content_id)
);

CREATE TABLE workspace_provider_path_restrictions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (length(btrim(provider_id)) BETWEEN 1 AND 80),
  disabled_by_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  disabled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider_id)
);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_rights_attestations', 'rights_holder_reports', 'rights_report_events',
    'rights_content_blocks', 'workspace_provider_path_restrictions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

CREATE POLICY rights_attestations_member_access ON workspace_rights_attestations
  FOR ALL USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_rights_attestations.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active')
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_rights_attestations.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  );

CREATE POLICY rights_reports_intake_insert ON rights_holder_reports
  FOR INSERT WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  );

CREATE POLICY rights_reports_admin_read ON rights_holder_reports
  FOR SELECT USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = rights_holder_reports.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  );

CREATE POLICY rights_reports_admin_update ON rights_holder_reports
  FOR UPDATE USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = rights_holder_reports.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = rights_holder_reports.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  );

CREATE POLICY rights_report_events_admin_access ON rights_report_events
  FOR ALL USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = rights_report_events.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = rights_report_events.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  );

CREATE POLICY rights_report_events_intake_insert ON rights_report_events
  FOR INSERT WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND to_status = 'received' AND actor_user_id IS NULL
  );

CREATE POLICY rights_content_blocks_member_read ON rights_content_blocks
  FOR SELECT USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = rights_content_blocks.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active')
  );

CREATE POLICY rights_content_blocks_admin_write ON rights_content_blocks
  FOR ALL USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = rights_content_blocks.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = rights_content_blocks.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  );

CREATE POLICY provider_path_restrictions_member_read ON workspace_provider_path_restrictions
  FOR SELECT USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_provider_path_restrictions.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active')
  );

CREATE POLICY provider_path_restrictions_admin_write ON workspace_provider_path_restrictions
  FOR ALL USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_provider_path_restrictions.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships m
      WHERE m.workspace_id = workspace_provider_path_restrictions.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active' AND m.role IN ('owner', 'admin'))
  );

-- Report intake is the only anonymous event permitted through the outbox.
CREATE POLICY rights_report_outbox_intake_insert ON outbox_events
  FOR INSERT WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND event_type = 'rights.report.received'
  );

GRANT SELECT, INSERT, UPDATE ON workspace_rights_attestations TO platform_runtime;
GRANT SELECT, INSERT, UPDATE ON rights_holder_reports TO platform_runtime;
GRANT SELECT, INSERT ON rights_report_events TO platform_runtime;
GRANT SELECT, INSERT, UPDATE ON rights_content_blocks TO platform_runtime;
GRANT SELECT, INSERT, UPDATE ON workspace_provider_path_restrictions TO platform_runtime;
