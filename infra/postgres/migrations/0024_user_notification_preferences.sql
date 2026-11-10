-- Phase 4 item 40: per-user notification controls and retention.
CREATE TABLE user_notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  category_preferences jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(category_preferences) = 'object'),
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days IN (30, 90, 180, 365)),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY user_notification_preferences_self_access
  ON user_notification_preferences FOR ALL
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON user_notification_preferences TO platform_runtime;
