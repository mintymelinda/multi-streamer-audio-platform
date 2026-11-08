-- Verify the API router can inspect durable intake while the worker cannot
-- directly read reward mappings or create media requests.
\\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.workspace_id', '', true);

DO $$
BEGIN
  IF (SELECT count(*) FROM twitch_eventsub_intake) <> 0 THEN
    RAISE EXCEPTION 'redemption intake leaked without tenant or router context';
  END IF;
  IF NOT has_table_privilege('platform_runtime', 'twitch_eventsub_intake', 'SELECT') THEN
    RAISE EXCEPTION 'API router cannot inspect durable intake';
  END IF;
  IF has_table_privilege('platform_worker', 'twitch_reward_mappings', 'SELECT') THEN
    RAISE EXCEPTION 'worker unexpectedly has reward mapping access';
  END IF;
  IF has_table_privilege('platform_worker', 'media_requests', 'INSERT') THEN
    RAISE EXCEPTION 'worker unexpectedly can create media requests';
  END IF;
END;
$$;
ROLLBACK;
