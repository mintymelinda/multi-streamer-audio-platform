\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
DO $$
DECLARE
  actor_a uuid := gen_random_uuid();
  actor_b uuid := gen_random_uuid();
  workspace_a uuid := gen_random_uuid();
  workspace_b uuid := gen_random_uuid();
  provider_a uuid := gen_random_uuid();
  provider_b uuid := gen_random_uuid();
  request_a uuid := gen_random_uuid();
  execution_a uuid := gen_random_uuid();
  operation_a uuid := gen_random_uuid();
  lease_fence bigint;
BEGIN
  PERFORM set_config('app.user_id', actor_a::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (actor_a, '930000001');
  PERFORM set_config('app.user_id', actor_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (actor_b, '930000002');

  PERFORM set_config('app.user_id', actor_a::text, true);
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_a, 'Playback A', actor_a, '930000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_a, actor_a, 'owner');

  PERFORM set_config('app.user_id', actor_b::text, true);
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_b, 'Playback B', actor_b, '930000002');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_b, actor_b, 'owner');

  PERFORM set_config('app.user_id', actor_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  INSERT INTO provider_instances (id, workspace_id, provider_id, instance_key, contract_version)
    VALUES (provider_a, workspace_a, 'youtube', 'playback-a', 1);
  INSERT INTO workspace_playback_policies (workspace_id, enabled, reason)
    VALUES (workspace_a, false, 'Owner paused playback');
  INSERT INTO media_requests (
    id, workspace_id, source, submitted_by_user_id, title, status
  ) VALUES (
    request_a, workspace_a, 'dashboard', actor_a, 'Playback session test', 'playing'
  );
  INSERT INTO provider_execution_states (
    id, workspace_id, request_id, provider_instance_id, state
  ) VALUES (
    execution_a, workspace_a, request_a, provider_a, 'playing'
  );
  INSERT INTO provider_output_assignments (
    workspace_id, provider_instance_id, output_id, player_id, assigned_by
  ) VALUES (
    workspace_a, provider_a, 'output-a', 'player-a', actor_a
  );
  INSERT INTO playback_operations (
    id, workspace_id, provider_instance_id, player_id, request_id, requested_by,
    command, idempotency_key, status, result
  ) VALUES (
    operation_a, workspace_a, provider_a, 'player-a', request_a, actor_a,
    'play', 'playback-command-a', 'completed', '{"outcome":"started"}'::jsonb
  );
  INSERT INTO playback_sessions (
    workspace_id, request_id, provider_instance_id, execution_state_id,
    dispatch_generation, playback_operation_id, actor_user_id, output_id, player_id,
    expected_duration_ms
  ) VALUES (
    workspace_a, request_a, provider_a, execution_a, 1, operation_a, actor_a,
    'output-a', 'player-a', 180000
  );
  IF (SELECT count(*) FROM playback_sessions) <> 1 THEN
    RAISE EXCEPTION 'workspace owner cannot read its durable playback session';
  END IF;

  INSERT INTO playback_leases (
    workspace_id, provider_instance_id, player_id, lease_owner_id,
    lease_token, fencing_token, expires_at
  ) VALUES (
    workspace_a, provider_a, 'player-a', actor_a, gen_random_uuid(), 1, now() + interval '1 minute'
  );

  INSERT INTO playback_leases (
    workspace_id, provider_instance_id, player_id, lease_owner_id,
    lease_token, fencing_token, expires_at
  ) VALUES (
    workspace_a, provider_a, 'player-a', actor_a, gen_random_uuid(), 1, now() + interval '2 minutes'
  )
  ON CONFLICT (workspace_id, provider_instance_id, player_id)
  DO UPDATE SET
    lease_owner_id = EXCLUDED.lease_owner_id,
    lease_token = EXCLUDED.lease_token,
    fencing_token = playback_leases.fencing_token + 1,
    expires_at = EXCLUDED.expires_at
  WHERE playback_leases.expires_at <= now();

  IF (SELECT expires_at <= now() FROM playback_leases
       WHERE workspace_id = workspace_a AND provider_instance_id = provider_a AND player_id = 'player-a') THEN
    RAISE EXCEPTION 'live playback lease was unexpectedly expired';
  END IF;

  UPDATE playback_leases SET expires_at = now() - interval '1 second'
   WHERE workspace_id = workspace_a AND provider_instance_id = provider_a AND player_id = 'player-a';
  INSERT INTO playback_leases (
    workspace_id, provider_instance_id, player_id, lease_owner_id,
    lease_token, fencing_token, expires_at
  ) VALUES (
    workspace_a, provider_a, 'player-a', actor_b, gen_random_uuid(), 1, now() + interval '1 minute'
  )
  ON CONFLICT (workspace_id, provider_instance_id, player_id)
  DO UPDATE SET
    lease_owner_id = EXCLUDED.lease_owner_id,
    lease_token = EXCLUDED.lease_token,
    fencing_token = playback_leases.fencing_token + 1,
    expires_at = EXCLUDED.expires_at
  WHERE playback_leases.expires_at <= now()
  RETURNING fencing_token INTO lease_fence;

  IF lease_fence <> 2 THEN
    RAISE EXCEPTION 'expired lease was not reclaimed with a higher fencing generation';
  END IF;

  PERFORM set_config('app.user_id', actor_b::text, true);
  PERFORM set_config('app.workspace_id', workspace_b::text, true);
  INSERT INTO provider_instances (id, workspace_id, provider_id, instance_key, contract_version)
    VALUES (provider_b, workspace_b, 'youtube', 'playback-b', 1);

  IF (SELECT count(*) FROM playback_operations WHERE idempotency_key = 'playback-command-a') <> 0 THEN
    RAISE EXCEPTION 'playback operation leaked across workspace boundaries';
  END IF;
  IF (SELECT count(*) FROM playback_leases WHERE player_id = 'player-a') <> 0 THEN
    RAISE EXCEPTION 'playback lease leaked across workspace boundaries';
  END IF;
  IF (SELECT count(*) FROM workspace_playback_policies) <> 0 THEN
    RAISE EXCEPTION 'playback policy leaked across workspace boundaries';
  END IF;
  IF (SELECT count(*) FROM playback_sessions) <> 0 THEN
    RAISE EXCEPTION 'playback session leaked across workspace boundaries';
  END IF;
END;
$$;
ROLLBACK;
