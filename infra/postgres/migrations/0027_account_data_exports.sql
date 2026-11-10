-- Phase 4 item 43: personal account exports with authenticated, expiring downloads.
CREATE TABLE user_data_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'expired')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  downloaded_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code IN ('generation_failed')),
  export_data jsonb,
  CHECK ((status = 'completed') = (export_data IS NOT NULL)),
  CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK ((status = 'processing') = (locked_at IS NOT NULL))
);

CREATE INDEX user_data_exports_due
  ON user_data_exports (next_attempt_at, requested_at)
  WHERE status IN ('queued', 'processing');
CREATE INDEX user_data_exports_user_history
  ON user_data_exports (user_id, requested_at DESC);

CREATE UNIQUE INDEX user_data_exports_one_active_per_user
  ON user_data_exports (user_id)
  WHERE status IN ('queued', 'processing');

ALTER TABLE user_data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_data_exports FORCE ROW LEVEL SECURITY;

CREATE POLICY user_data_exports_recipient_read
  ON user_data_exports FOR SELECT
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY user_data_exports_recipient_insert
  ON user_data_exports FOR INSERT
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY user_data_exports_recipient_download_update
  ON user_data_exports FOR UPDATE
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY user_data_exports_worker_access
  ON user_data_exports FOR ALL TO platform_worker
  USING (true) WITH CHECK (true);

GRANT USAGE ON SCHEMA public TO platform_worker;
GRANT SELECT, INSERT, UPDATE ON user_data_exports TO platform_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_data_exports TO platform_worker;

-- The export worker reads only self-scoped account data and inserts one
-- recipient-addressed completion notification. It never needs workspace data.
GRANT SELECT ON platform_users, workspace_memberships, workspace_invitations,
  user_notification_preferences, user_notification_email_settings
  TO platform_worker;
GRANT SELECT, INSERT ON user_notifications TO platform_worker;

CREATE POLICY user_notifications_account_export_worker_insert
  ON user_notifications FOR INSERT TO platform_worker
  WITH CHECK (
    recipient_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND workspace_id IS NULL
    AND category = 'account'
    AND event_type = 'account.data_export.completed'
  );
