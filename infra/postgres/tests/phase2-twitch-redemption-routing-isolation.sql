-- Verify redemption routing uses workspace-scoped mappings and never grants the worker business-table access.
\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.workspace_id', '', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM twitch_eventsub_intake) <> 0 THEN
    RAISE EXCEPTION 'redemption intake leaked without tenant or router context';
  END IF;
  IF has_table_privilege('platform_worker', 'twitch_reward_mappings', 'SELECT') THEN
    RAISE EXCEPTION 'worker unexpectedly has reward mapping access';
  END IF;
  IF has_table_privilege('platform_worker', 'media_requests', 'INSERT') THEN
    RAISE EXCEPTION 'worker unexpectedly can create media requests';
  END IF;
  IF NOT has_table_privilege('platform_runtime', 'twitch_eventsub_intake', 'SELECT') THEN
    RAISE EXCEPTION 'API router cannot claim durable intake rows';
  END IF;
END;
$$;
DO $$
DECLARE
  actor_id uuid := gen_random_uuid();
  workspace_id uuid := gen_random_uuid();
  mapping_id uuid;
BEGIN
  PERFORM set_config('app.user_id', actor_id::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (actor_id, '970000001');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_id, 'Redemption Routing Tenant', actor_id, '970000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_id, actor_id, 'owner');
  PERFORM set_config('app.workspace_id', workspace_id::text, true);
  INSERT INTO twitch_reward_mappings
    (workspace_id, twitch_reward_id, reward_title, reward_cost, feature_key, feature_settings, enabled, sync_state)
  VALUES (workspace_id, 'routing-reward', 'Song Request', 100, 'media_request',
    '{"inputMode":"url_or_search","priority":25}'::jsonb, true, 'synced')
  RETURNING id INTO mapping_id;
  IF (SELECT count(*) FROM twitch_reward_mappings WHERE id = mapping_id) <> 1 THEN
    RAISE EXCEPTION 'workspace owner could not read their verified reward mapping';
  END IF;
END;
$$;
ROLLBACK;
