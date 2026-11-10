-- Account appearance preferences are visible and writable only by their owner.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
DO $$
DECLARE
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_a, '970000001');
  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_b, '970000002');

  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO user_appearance_preferences (user_id, theme, accent_color)
  VALUES (user_a, 'light', 'teal');
  IF NOT EXISTS (
    SELECT 1 FROM user_appearance_preferences
     WHERE user_id = user_a AND theme = 'light' AND accent_color = 'teal'
  ) THEN
    RAISE EXCEPTION 'account owner cannot read their appearance preferences';
  END IF;
  UPDATE user_appearance_preferences SET accent_color = 'rose' WHERE user_id = user_a;
  IF NOT EXISTS (
    SELECT 1 FROM user_appearance_preferences
     WHERE user_id = user_a AND accent_color = 'rose'
  ) THEN
    RAISE EXCEPTION 'account owner cannot update their appearance preferences';
  END IF;

  PERFORM set_config('app.user_id', user_b::text, true);
  IF (SELECT count(*) FROM user_appearance_preferences WHERE user_id = user_a) <> 0 THEN
    RAISE EXCEPTION 'another account can read appearance preferences';
  END IF;
  UPDATE user_appearance_preferences SET theme = 'dark' WHERE user_id = user_a;
  PERFORM set_config('app.user_id', user_a::text, true);
  IF NOT EXISTS (
    SELECT 1 FROM user_appearance_preferences
     WHERE user_id = user_a AND theme = 'light' AND accent_color = 'rose'
  ) THEN
    RAISE EXCEPTION 'another account modified appearance preferences';
  END IF;

  PERFORM set_config('app.user_id', user_b::text, true);
  BEGIN
    INSERT INTO user_appearance_preferences (user_id, theme, accent_color)
    VALUES (user_a, 'dark', 'blue');
    RAISE EXCEPTION 'another account inserted preferences for the owner';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
ROLLBACK;
