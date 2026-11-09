-- Verify Twitch reward mappings are tenant-scoped and unavailable to workers.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.workspace_id', '', true);

DO $$
BEGIN
  IF (SELECT count(*) FROM twitch_reward_mappings) <> 0 THEN
    RAISE EXCEPTION 'Twitch reward mappings leaked without tenant context';
  END IF;
  IF has_table_privilege('platform_worker', 'twitch_reward_mappings', 'SELECT') THEN
    RAISE EXCEPTION 'worker unexpectedly has direct reward mapping access';
  END IF;
END;
$$;

DO $$
DECLARE
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  workspace_a uuid := gen_random_uuid();
  workspace_b uuid := gen_random_uuid();
  mapping_id uuid;
BEGIN
  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_a, '960000001');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_a, 'Reward Mapping Tenant A', user_a, '960000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_a, user_a, 'owner');

  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_b, '960000002');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_b, 'Reward Mapping Tenant B', user_b, '960000002');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_b, user_b, 'owner');

  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);

  INSERT INTO twitch_reward_mappings
    (workspace_id, twitch_reward_id, reward_title, reward_cost, feature_key, feature_settings)
  VALUES
    (workspace_a, 'reward-tenant-a', 'Song Request', 100, 'media_request',
     '{"inputMode":"url_or_search","priority":0}'::jsonb)
  RETURNING id INTO mapping_id;

  IF (SELECT sync_state FROM twitch_reward_mappings WHERE id = mapping_id) <> 'pending_verification' THEN
    RAISE EXCEPTION 'manual reward link was incorrectly treated as Twitch-verified';
  END IF;

  BEGIN
    INSERT INTO twitch_reward_mappings
      (workspace_id, twitch_reward_id, reward_title, reward_cost, feature_key)
    VALUES (workspace_a, 'reward-tenant-a', 'Another name', 100, 'media_request');
    RAISE EXCEPTION 'duplicate reward mapping was allowed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO twitch_reward_mappings
      (workspace_id, twitch_reward_id, reward_title, reward_cost, feature_key, feature_settings)
    VALUES (workspace_a, 'reward-invalid-feature', 'Invalid', 100, 'unknown_feature', '{}'::jsonb);
    RAISE EXCEPTION 'unsupported reward feature was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  PERFORM set_config('app.user_id', user_b::text, true);
  PERFORM set_config('app.workspace_id', workspace_b::text, true);
  IF (SELECT count(*) FROM twitch_reward_mappings WHERE id = mapping_id) <> 0 THEN
    RAISE EXCEPTION 'cross-workspace Twitch reward mapping leaked';
  END IF;
END;
$$;
ROLLBACK;
