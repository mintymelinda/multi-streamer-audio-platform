-- Phase 4 item 39: recipient-addressed, user-wide notification inbox.
-- Workspace notifications intentionally remain readable by their recipient after
-- workspace membership is revoked; this table never grants workspace access.

CREATE TABLE user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('account', 'platform', 'security', 'team', 'provider', 'playback', 'queue', 'system')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  href text CHECK (href IS NULL OR (left(href, 1) = '/' AND left(href, 2) <> '//')),
  group_key text CHECK (group_key IS NULL OR length(group_key) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CHECK (workspace_id IS NOT NULL OR category IN ('account', 'platform', 'security'))
);

CREATE INDEX user_notifications_recipient_created
  ON user_notifications (recipient_user_id, created_at DESC, id DESC);
CREATE INDEX user_notifications_recipient_unread
  ON user_notifications (recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX user_notifications_recipient_group
  ON user_notifications (recipient_user_id, group_key, created_at DESC)
  WHERE group_key IS NOT NULL;

ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notifications FORCE ROW LEVEL SECURITY;

-- Deliberately keyed only to the authenticated recipient, not current workspace
-- membership, so addressed notifications survive membership revocation.
CREATE POLICY user_notifications_recipient_access
  ON user_notifications FOR SELECT
  USING (recipient_user_id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY user_notifications_recipient_update
  ON user_notifications FOR UPDATE
  USING (recipient_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (recipient_user_id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY user_notifications_recipient_insert
  ON user_notifications FOR INSERT
  WITH CHECK (
    recipient_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR (
      workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
      AND EXISTS (
        SELECT 1 FROM workspace_memberships actor_membership
        WHERE actor_membership.workspace_id = user_notifications.workspace_id
          AND actor_membership.user_id = nullif(current_setting('app.user_id', true), '')::uuid
          AND actor_membership.status = 'active'
      )
      AND EXISTS (
        SELECT 1 FROM workspace_memberships recipient_membership
        WHERE recipient_membership.workspace_id = user_notifications.workspace_id
          AND recipient_membership.user_id = user_notifications.recipient_user_id
          AND recipient_membership.status = 'active'
      )
    )
  );

GRANT SELECT, INSERT, UPDATE ON user_notifications TO platform_runtime;
