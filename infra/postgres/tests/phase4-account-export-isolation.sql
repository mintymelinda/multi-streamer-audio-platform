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
  UPDATE user_data_exports SET downloaded_at = now() WHERE id = export_a;
  IF NOT EXISTS (SELECT 1 FROM user_data_exports WHERE id = export_a AND downloaded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'account owner cannot record their export download';
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

END;
$$;
ROLLBACK;
