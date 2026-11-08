-- Verify request, moderation, history and logical queue tables enforce tenant isolation.
-- Run as platform_runtime after all migrations have been applied.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.workspace_id', '', true);

DO $$
BEGIN
  IF (SELECT count(*) FROM media_requests) <> 0 THEN
    RAISE EXCEPTION 'request rows leaked without tenant context';
  END IF;
  IF (SELECT count(*) FROM request_state_history) <> 0 THEN
    RAISE EXCEPTION 'request history leaked without tenant context';
  END IF;
  IF (SELECT count(*) FROM logical_queue_entries) <> 0 THEN
    RAISE EXCEPTION 'queue rows leaked without tenant context';
  END IF;
END;
$$;

DO $$
DECLARE
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  workspace_a uuid := gen_random_uuid();
  workspace_b uuid := gen_random_uuid();
  request_a uuid;
BEGIN
  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_a, '930000001');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_a, 'Request Tenant A', user_a, '930000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_a, user_a, 'owner');

  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_b, '930000002');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_b, 'Request Tenant B', user_b, '930000002');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_b, user_b, 'owner');

  SET CONSTRAINTS ALL IMMEDIATE;

  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  INSERT INTO workspace_request_settings (workspace_id) VALUES (workspace_a);
  INSERT INTO workspace_queue_counters (workspace_id) VALUES (workspace_a);
  INSERT INTO media_requests (
    workspace_id, source, title, status, requester_twitch_user_id
  ) VALUES (
    workspace_a, 'dashboard', 'Tenant A song', 'queued', '930000001'
  ) RETURNING id INTO request_a;
  INSERT INTO request_state_history (
    workspace_id, request_id, from_status, to_status, actor_user_id, actor_type
  ) VALUES (
    workspace_a, request_a, NULL, 'submitted', user_a, 'user'
  );
  INSERT INTO logical_queue_entries (
    workspace_id, request_id, priority, sequence, inserted_by_user_id
  ) VALUES (
    workspace_a, request_a, 0, 1, user_a
  );

  UPDATE media_requests SET status = 'resolving' WHERE id = request_a;
  UPDATE media_requests SET status = 'ready' WHERE id = request_a;
  UPDATE media_requests SET status = 'playing' WHERE id = request_a;
  UPDATE media_requests SET status = 'completed' WHERE id = request_a;
  IF (SELECT completed_at FROM media_requests WHERE id = request_a) IS NULL THEN
    RAISE EXCEPTION 'completed request did not receive completed_at';
  END IF;
  BEGIN
    UPDATE media_requests SET status = 'queued' WHERE id = request_a;
    RAISE EXCEPTION 'terminal request state was allowed to transition';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  PERFORM set_config('app.user_id', user_b::text, true);
  PERFORM set_config('app.workspace_id', workspace_b::text, true);
  IF (SELECT count(*) FROM workspace_request_settings WHERE workspace_id = workspace_a) <> 0 THEN
    RAISE EXCEPTION 'cross-workspace request settings leaked';
  END IF;
  IF (SELECT count(*) FROM workspace_queue_counters WHERE workspace_id = workspace_a) <> 0 THEN
    RAISE EXCEPTION 'cross-workspace queue counter leaked';
  END IF;
  IF (SELECT count(*) FROM media_requests WHERE workspace_id = workspace_a) <> 0 THEN
    RAISE EXCEPTION 'cross-workspace request leaked';
  END IF;
  IF (SELECT count(*) FROM request_state_history WHERE workspace_id = workspace_a) <> 0 THEN
    RAISE EXCEPTION 'cross-workspace request history leaked';
  END IF;
  IF (SELECT count(*) FROM logical_queue_entries WHERE workspace_id = workspace_a) <> 0 THEN
    RAISE EXCEPTION 'cross-workspace queue entry leaked';
  END IF;
END;
$$;
ROLLBACK;
