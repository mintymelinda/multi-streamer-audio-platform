\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
DO $$
DECLARE
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  user_c uuid := gen_random_uuid();
  workspace_a uuid := gen_random_uuid();
  notification_id uuid := gen_random_uuid();
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

  -- Membership insertion is authorized by the verified workspace context.
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
  VALUES (workspace_a, user_b, 'moderator');
  SET CONSTRAINTS ALL IMMEDIATE;

  -- Email addresses and outbox content are visible only to their account and the dispatcher.
  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO user_notification_email_settings (user_id, email_address)
  VALUES (user_b, 'moderator@example.test');
  INSERT INTO user_notification_preferences (user_id, category_preferences)
  VALUES (user_b, '{"team": true}'::jsonb);
  UPDATE user_notification_email_settings SET verified_at = now(), email_enabled = true,
    category_preferences = '{"team": true}'::jsonb, priority_preferences = '{"normal": true}'::jsonb
   WHERE user_id = user_b;
  INSERT INTO email_outbox (user_id, recipient_email, subject, text_body, html_body, unique_key)
  VALUES (user_b, 'moderator@example.test', 'Test', 'Test body', '<p>Test</p>', 'isolation-test:' || user_b::text);

  -- Workspace-scoped producers may read only active recipients' delivery preferences and enqueue for them.
  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  IF (SELECT email_enabled FROM user_notification_email_settings WHERE user_id = user_b) IS NOT TRUE THEN
    RAISE EXCEPTION 'workspace notification producer could not read active recipient email preference';
  END IF;
  IF (SELECT category_preferences ->> 'team' FROM user_notification_preferences WHERE user_id = user_b) <> 'true' THEN
    RAISE EXCEPTION 'workspace notification producer could not read active recipient notification preference';
  END IF;
  INSERT INTO email_outbox (user_id, workspace_id, recipient_email, subject, text_body, html_body, unique_key)
  VALUES (user_b, workspace_a, 'moderator@example.test', 'Workspace notice', 'Body', '<p>Body</p>', 'workspace-notice:' || user_b::text);
  -- A workspace member may address a notification to another active member.
  INSERT INTO user_notifications (id, recipient_user_id, workspace_id, category, event_type, title, group_key)
  VALUES (notification_id, user_b, workspace_a, 'team', 'team.member_role_changed', 'Your role changed', 'team:role-change');

  PERFORM set_config('app.user_id', user_c::text, true);
  IF (SELECT count(*) FROM user_notification_email_settings WHERE user_id = user_b) <> 0 THEN
    RAISE EXCEPTION 'email settings leaked to another account';
  END IF;
  IF (SELECT count(*) FROM email_outbox) <> 0 THEN
    RAISE EXCEPTION 'email outbox content leaked to another account';
  END IF;

  -- A different account cannot see the recipient's notification.
  PERFORM set_config('app.user_id', user_c::text, true);
  PERFORM set_config('app.workspace_id', '', true);
  IF (SELECT count(*) FROM user_notifications WHERE id = notification_id) <> 0 THEN
    RAISE EXCEPTION 'notification leaked to a non-recipient';
  END IF;

  -- Revoking workspace membership does not revoke access to an already-addressed notification.
  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  UPDATE workspace_memberships SET status = 'revoked', revoked_at = now(), updated_at = now()
   WHERE workspace_id = workspace_a AND user_id = user_b;

  PERFORM set_config('app.user_id', user_b::text, true);
  PERFORM set_config('app.workspace_id', '', true);
  IF (SELECT count(*) FROM user_notifications WHERE id = notification_id) <> 1 THEN
    RAISE EXCEPTION 'recipient lost notification history after workspace access revocation';
  END IF;
  IF (SELECT count(*) FROM workspaces WHERE id = workspace_a) <> 0 THEN
    RAISE EXCEPTION 'notification access incorrectly preserved workspace access';
  END IF;

  UPDATE user_notifications SET read_at = now() WHERE id = notification_id;
  IF NOT EXISTS (SELECT 1 FROM user_notifications WHERE id = notification_id AND read_at IS NOT NULL) THEN
    RAISE EXCEPTION 'recipient could not update their notification read state';
  END IF;
END;
$$;
ROLLBACK;
