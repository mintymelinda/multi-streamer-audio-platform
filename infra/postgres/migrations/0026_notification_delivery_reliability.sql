-- Phase 4 item 42: notification deduplication, bounded grouping windows, and delivery status.
ALTER TABLE user_notifications
  ADD COLUMN group_window bigint;

UPDATE user_notifications
   SET group_window = CASE WHEN group_key IS NULL THEN NULL
     ELSE floor(extract(epoch FROM created_at) / 300)::bigint END;

ALTER TABLE user_notifications
  ALTER COLUMN group_window SET DEFAULT floor(extract(epoch FROM now()) / 300)::bigint;

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

-- Keep idempotency metadata separate from notification content so workspace
-- producers can claim keys without gaining access to recipient inbox contents.
CREATE TABLE user_notification_deduplication (
  recipient_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  notification_id uuid NOT NULL REFERENCES user_notifications(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_user_id, dedupe_key)
);

ALTER TABLE user_notification_deduplication ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_deduplication FORCE ROW LEVEL SECURITY;

CREATE POLICY user_notification_deduplication_recipient_or_workspace_read
  ON user_notification_deduplication FOR SELECT
  USING (
    recipient_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR (
      workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM workspace_memberships actor_membership
         WHERE actor_membership.workspace_id = user_notification_deduplication.workspace_id
           AND actor_membership.user_id = nullif(current_setting('app.user_id', true), '')::uuid
           AND actor_membership.status = 'active'
      )
      AND EXISTS (
        SELECT 1 FROM workspace_memberships recipient_membership
         WHERE recipient_membership.workspace_id = user_notification_deduplication.workspace_id
           AND recipient_membership.user_id = user_notification_deduplication.recipient_user_id
           AND recipient_membership.status = 'active'
      )
    )
  );

CREATE POLICY user_notification_deduplication_recipient_or_workspace_insert
  ON user_notification_deduplication FOR INSERT
  WITH CHECK (
    recipient_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR (
      workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM workspace_memberships actor_membership
         WHERE actor_membership.workspace_id = user_notification_deduplication.workspace_id
           AND actor_membership.user_id = nullif(current_setting('app.user_id', true), '')::uuid
           AND actor_membership.status = 'active'
      )
      AND EXISTS (
        SELECT 1 FROM workspace_memberships recipient_membership
         WHERE recipient_membership.workspace_id = user_notification_deduplication.workspace_id
           AND recipient_membership.user_id = user_notification_deduplication.recipient_user_id
           AND recipient_membership.status = 'active'
      )
    )
  );

GRANT SELECT, INSERT ON user_notification_deduplication TO platform_runtime;
