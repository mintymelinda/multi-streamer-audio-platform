-- Export worker can process jobs while personal data remains RLS-scoped.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  user_a uuid := '95000000-0000-4000-8000-000000000001';
  user_b uuid := '95000000-0000-4000-8000-000000000002';
  export_a uuid := '95000000-0000-4000-8000-000000000003';
BEGIN
  INSERT INTO platform_users (id, twitch_user_id) VALUES
    (user_a, '960000001'), (user_b, '960000002');
  INSERT INTO user_data_exports (id, user_id) VALUES (export_a, user_a);
  PERFORM set_config('test.account_export_user_a', user_a::text, true);
  PERFORM set_config('test.account_export_user_b', user_b::text, true);
  PERFORM set_config('test.account_export_id', export_a::text, true);
END;
$$;

SET LOCAL ROLE platform_worker;
DO $$
DECLARE
  user_a uuid := current_setting('test.account_export_user_a')::uuid;
  user_b uuid := current_setting('test.account_export_user_b')::uuid;
  export_a uuid := current_setting('test.account_export_id')::uuid;
BEGIN
  IF current_user <> 'platform_worker' THEN
    RAISE EXCEPTION 'account export worker role was not activated';
  END IF;
  PERFORM set_config('app.user_id', user_a::text, true);
  UPDATE user_data_exports
     SET status = 'processing', locked_at = now(), started_at = now(), attempt_count = 1
   WHERE id = export_a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'worker cannot claim an account export job';
  END IF;
  UPDATE user_data_exports
     SET status = 'completed', export_data = '{"schemaVersion":1}'::jsonb,
         completed_at = now(), expires_at = now() + interval '7 days', locked_at = NULL
   WHERE id = export_a;
  INSERT INTO user_notifications
    (recipient_user_id, category, priority, event_type, title, body, href)
  VALUES (user_a, 'account', 'normal', 'account.data_export.completed',
    'Your account export is ready', 'Download your export.', '/account/data-exports');
  IF (SELECT count(*) FROM user_notifications WHERE recipient_user_id = user_a
       AND event_type = 'account.data_export.completed') <> 1 THEN
    RAISE EXCEPTION 'worker cannot create recipient export-completion notification';
  END IF;
  IF (SELECT count(*) FROM platform_users WHERE id = user_b) <> 0 THEN
    RAISE EXCEPTION 'worker account-data reads are not scoped to the active user';
  END IF;

  PERFORM set_config('app.user_id', user_b::text, true);
  IF (SELECT count(*) FROM platform_users WHERE id = user_a) <> 0 THEN
    RAISE EXCEPTION 'worker account-data RLS leaked another account';
  END IF;
  IF (SELECT count(*) FROM user_notifications WHERE recipient_user_id = user_a) <> 0 THEN
    RAISE EXCEPTION 'worker notification RLS leaked another account';
  END IF;
END;
$$;
ROLLBACK;
