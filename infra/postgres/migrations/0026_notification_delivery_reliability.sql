-- Phase 4 item 42: notification deduplication, bounded grouping windows, and delivery status.
ALTER TABLE user_notifications
  ADD COLUMN group_window bigint,
  ADD COLUMN dedupe_key text;

UPDATE user_notifications
   SET group_window = CASE WHEN group_key IS NULL THEN NULL
     ELSE floor(extract(epoch FROM created_at) / 300)::bigint END;

ALTER TABLE user_notifications
  ALTER COLUMN group_window SET DEFAULT floor(extract(epoch FROM now()) / 300)::bigint;

ALTER TABLE user_notifications
  ADD CONSTRAINT user_notifications_dedupe_key_length
  CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 200);

CREATE UNIQUE INDEX user_notifications_recipient_dedupe
  ON user_notifications (recipient_user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX user_notifications_recipient_group_window
  ON user_notifications (recipient_user_id, group_key, group_window DESC)
  WHERE group_key IS NOT NULL;

ALTER TABLE email_outbox
  ADD COLUMN notification_id uuid REFERENCES user_notifications(id) ON DELETE CASCADE;

CREATE INDEX email_outbox_notification_status
  ON email_outbox (user_id, notification_id, created_at DESC)
  WHERE notification_id IS NOT NULL;

CREATE POLICY email_outbox_recipient_read
  ON email_outbox FOR SELECT
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT ON email_outbox TO platform_runtime;
