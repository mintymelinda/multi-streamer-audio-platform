\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
DO $$
DECLARE
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  user_c uuid := gen_random_uuid();
  workspace_a uuid := gen_random_uuid();
  notification_a_id uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_a, '930000001');
  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_b, '930000002');
  PERFORM set_config('app.user_id', user_c::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_c, '930000003');

  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
  VALUES (workspace_a, 'Notification workspace', user_a, '930000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
  VALUES (workspace_a, user_a, 'owner');
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
  VALUES (workspace_a, user_b, 'moderator');
  SET CONSTRAINTS ALL IMMEDIATE;

  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO user_notification_email_settings (user_id, email_address)
  VALUES (user_b, 'moderator@example.test');
  INSERT INTO user_notification_preferences (user_id, category_preferences)
  VALUES (user_b, '{"team": true}'::jsonb);
  UPDATE user_notification_email_settings
     SET verified_at = now(), email_enabled = true,
         category_preferences = '{"team": true}'::jsonb,
         priority_preferences = '{"normal": true}'::jsonb
   WHERE user_id = user_b;

  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  IF (SELECT email_enabled FROM user_notification_email_settings WHERE user_id = user_b) IS NOT TRUE THEN
    RAISE EXCEPTION 'workspace producer could not read active recipient email preference';
  END IF;
  IF (SELECT category_preferences ->> 'team' FROM user_notification_preferences WHERE user_id = user_b) <> 'true' THEN
    RAISE EXCEPTION 'workspace producer could not read active recipient notification preference';
  END IF;

  INSERT INTO user_notifications
    (id, recipient_user_id, workspace_id, category, event_type, title, group_key, group_window)
  VALUES
    (notification_a_id, user_b, workspace_a, 'team', 'team.member_role_changed',
     'Your role changed', 'team:role-change', 5900000);
  INSERT INTO user_notification_deduplication
    (recipient_user_id, workspace_id, dedupe_key, notification_id)
  VALUES (user_b, workspace_a, 'role-change:event-1', notification_a_id);
  INSERT INTO email_outbox
    (user_id, workspace_id, notification_id, recipient_email, subject, text_body, html_body, unique_key)
  VALUES
    (user_b, workspace_a, notification_a_id, 'moderator@example.test', 'Workspace notice',
     'Body', '<p>Body</p>', 'workspace-notice:' || user_b::text);

  INSERT INTO user_notification_deduplication
    (recipient_user_id, workspace_id, dedupe_key, notification_id)
  VALUES (user_b, workspace_a, 'role-change:event-1', notification_a_id)
  ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING;
  IF (SELECT count(*) FROM user_notification_deduplication
       WHERE recipient_user_id = user_b AND dedupe_key = 'role-change:event-1') <> 1 THEN
    RAISE EXCEPTION 'recipient-scoped notification deduplication did not suppress duplicate delivery';
  END IF;

  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO user_notifications
    (recipient_user_id, workspace_id, category, event_type, title, group_key, group_window)
  VALUES (user_b, workspace_a, 'team', 'team.member_role_changed', 'Next window',
     'team:role-change', 5900001);
  IF (SELECT count(DISTINCT group_window) FROM user_notifications
       WHERE recipient_user_id = user_b AND group_key = 'team:role-change') <> 2 THEN
    RAISE EXCEPTION 'notifications from separate grouping windows were collapsed together';
  END IF;

  PERFORM set_config('app.user_id', user_c::text, true);
  IF (SELECT count(*) FROM user_notification_email_settings WHERE user_id = user_b) <> 0 THEN
    RAISE EXCEPTION 'email settings leaked to another account';
  END IF;
  IF (SELECT count(*) FROM email_outbox) <> 0 THEN
    RAISE EXCEPTION 'email outbox content leaked to another account';
  END IF;
  IF (SELECT count(*) FROM email_outbox WHERE notification_id = notification_a_id) <> 0 THEN
    RAISE EXCEPTION 'email delivery status leaked to another account';
  END IF;
  IF (SELECT count(*) FROM user_notifications WHERE id = notification_a_id) <> 0 THEN
    RAISE EXCEPTION 'notification leaked to a non-recipient';
  END IF;
  IF (SELECT count(*) FROM user_notification_deduplication WHERE recipient_user_id = user_b) <> 0 THEN
    RAISE EXCEPTION 'deduplication metadata leaked to another account';
  END IF;

  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  UPDATE workspace_memberships
     SET status = 'revoked', revoked_at = now(), updated_at = now()
   WHERE workspace_id = workspace_a AND user_id = user_b;

  PERFORM set_config('app.user_id', user_b::text, true);
  PERFORM set_config('app.workspace_id', '', true);
  IF (SELECT count(*) FROM user_notifications WHERE id = notification_a_id) <> 1 THEN
    RAISE EXCEPTION 'recipient lost notification history after workspace access revocation';
  END IF;
  IF (SELECT count(*) FROM email_outbox WHERE notification_id = notification_a_id) <> 1 THEN
    RAISE EXCEPTION 'recipient lost email delivery status after workspace access revocation';
  END IF;
  IF (SELECT count(*) FROM user_notification_deduplication WHERE recipient_user_id = user_b) <> 1 THEN
    RAISE EXCEPTION 'recipient lost deduplication metadata after workspace access revocation';
  END IF;
  IF (SELECT count(*) FROM workspaces WHERE id = workspace_a) <> 0 THEN
    RAISE EXCEPTION 'notification access incorrectly preserved workspace access';
  END IF;

  UPDATE user_notifications SET read_at = now() WHERE id = notification_a_id;
  IF NOT EXISTS (SELECT 1 FROM user_notifications WHERE id = notification_a_id AND read_at IS NOT NULL) THEN
    RAISE EXCEPTION 'recipient could not update their notification read state';
  END IF;
END;
$$;
ROLLBACK;
