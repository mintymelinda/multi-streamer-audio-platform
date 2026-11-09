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
  request_a uuid := gen_random_uuid();
  queue_sequence bigint := 17;
BEGIN
  PERFORM set_config('app.user_id', actor_a::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (actor_a, '940000001');
  PERFORM set_config('app.user_id', actor_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (actor_b, '940000002');

  PERFORM set_config('app.user_id', actor_a::text, true);
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_a, 'Execution Queue A', actor_a, '940000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_a, actor_a, 'owner');

  PERFORM set_config('app.user_id', actor_b::text, true);
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_b, 'Execution Queue B', actor_b, '940000002');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_b, actor_b, 'owner');

  PERFORM set_config('app.user_id', actor_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  INSERT INTO provider_instances (id, workspace_id, provider_id, instance_key, contract_version)
    VALUES (provider_a, workspace_a, 'youtube', 'execution-queue-a', 1);
  INSERT INTO media_requests (
    id, workspace_id, source, title, status, priority
  ) VALUES (
    request_a, workspace_a, 'api', 'Queue authority test', 'queued', 10
  );
  INSERT INTO logical_queue_entries (
    workspace_id, request_id, priority, sequence
  ) VALUES (workspace_a, request_a, 10, queue_sequence);
  INSERT INTO provider_execution_states (
    workspace_id, request_id, provider_instance_id, state, attempt
  ) VALUES (workspace_a, request_a, provider_a, 'retry_wait', 2);

  UPDATE provider_execution_states
     SET state = 'resolving', attempt = 3, updated_at = now()
   WHERE workspace_id = workspace_a AND request_id = request_a
     AND provider_instance_id = provider_a;

  IF (SELECT status FROM media_requests WHERE id = request_a) <> 'queued' THEN
    RAISE EXCEPTION 'provider execution state changed the authoritative request lifecycle';
  END IF;
  IF (SELECT sequence FROM logical_queue_entries WHERE request_id = request_a) <> queue_sequence THEN
    RAISE EXCEPTION 'provider execution state changed the logical queue order';
  END IF;

  PERFORM set_config('app.user_id', actor_b::text, true);
  PERFORM set_config('app.workspace_id', workspace_b::text, true);
  IF (SELECT count(*) FROM provider_execution_states WHERE request_id = request_a) <> 0 THEN
    RAISE EXCEPTION 'provider execution state leaked across workspace boundaries';
  END IF;
END;
$$;
ROLLBACK;
