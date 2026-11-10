-- Phase 4 item 41: separately verified, opt-in notification email.
CREATE TABLE user_notification_email_settings (
  user_id uuid PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  email_address text CHECK (email_address IS NULL OR length(email_address) BETWEEN 3 AND 320),
  verified_at timestamptz,
  verification_token_hash text,
  verification_expires_at timestamptz,
  verification_requested_at timestamptz,
  email_enabled boolean NOT NULL DEFAULT false,
  category_preferences jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(category_preferences) = 'object'),
  priority_preferences jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(priority_preferences) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((verification_token_hash IS NULL) = (verification_expires_at IS NULL)),
  CHECK (NOT email_enabled OR verified_at IS NOT NULL),
  CHECK (verified_at IS NULL OR email_address IS NOT NULL)
);
ALTER TABLE user_notification_email_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_email_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY user_notification_email_settings_self_access
  ON user_notification_email_settings FOR ALL
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON user_notification_email_settings TO platform_runtime;

CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  recipient_email text NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 320),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 180),
  text_body text NOT NULL CHECK (length(text_body) BETWEEN 1 AND 10000),
  html_body text NOT NULL CHECK (length(html_body) BETWEEN 1 AND 20000),
  unique_key text NOT NULL UNIQUE CHECK (length(unique_key) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX email_outbox_due ON email_outbox (next_attempt_at, created_at) WHERE status IN ('pending', 'sending');
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY email_outbox_user_insert
  ON email_outbox FOR INSERT
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY email_outbox_worker_access
  ON email_outbox FOR ALL TO platform_worker USING (true) WITH CHECK (true);
GRANT INSERT ON email_outbox TO platform_runtime;
GRANT SELECT, UPDATE ON email_outbox TO platform_worker;
