\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
DO $$
DECLARE
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  export_a uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_a, '940000001');
  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_b, '940000002');

  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO user_data_exports (id, user_id) VALUES (export_a, user_a);
  IF (SELECT count(*) FROM user_data_exports WHERE id = export_a) <> 1 THEN
    RAISE EXCEPTION 'account owner cannot read their export status';
  END IF;

  PERFORM set_config('app.user_id', user_b::text, true);
  IF (SELECT count(*) FROM user_data_exports WHERE id = export_a) <> 0 THEN
    RAISE EXCEPTION 'another account can read the export status';
  END IF;
  BEGIN
    INSERT INTO user_data_exports (user_id) VALUES (user_a);
    RAISE EXCEPTION 'another account inserted an export for the owner';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  SET LOCAL ROLE platform_worker;
  PERFORM set_config('app.user_id', user_a::text, true);
  UPDATE user_data_exports
     SET status = 'processing', locked_at = now(), attempt_count = 1
   WHERE id = export_a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'worker cannot claim export jobs';
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
    RAISE EXCEPTION 'worker could not create recipient export-completion notification';
  END IF;
END;
$$;
ROLLBACK;
