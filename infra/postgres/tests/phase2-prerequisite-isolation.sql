-- Verify Phase 2 integration and outbox records remain tenant isolated.
-- Run as platform_runtime after all migrations have been applied.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.workspace_id', '', true);

DO $$
BEGIN
  IF (SELECT count(*) FROM workspace_integrations) <> 0 THEN
    RAISE EXCEPTION 'integration records leaked without tenant context';
  END IF;
  IF (SELECT count(*) FROM outbox_events) <> 0 THEN
    RAISE EXCEPTION 'outbox records leaked without tenant context';
  END IF;
END;
$$;

DO $$
DECLARE
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  workspace_a uuid := gen_random_uuid();
  workspace_b uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_a, '920000001');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_a, 'Integration Tenant A', user_a, '920000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_a, user_a, 'owner');

  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_b, '920000002');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_b, 'Integration Tenant B', user_b, '920000002');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_b, user_b, 'owner');

  SET CONSTRAINTS ALL IMMEDIATE;

  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  INSERT INTO workspace_integrations (workspace_id, provider, status)
    VALUES (workspace_a, 'twitch', 'disconnected');
  INSERT INTO outbox_events (
    workspace_id, event_type, aggregate_type, aggregate_id, idempotency_key, payload
  ) VALUES (
    workspace_a, 'test.event', 'test', 'aggregate-a', 'test-event-a',
    '{"safe":"payload"}'::jsonb
  );

  PERFORM set_config('app.user_id', user_b::text, true);
  PERFORM set_config('app.workspace_id', workspace_b::text, true);
  IF (SELECT count(*) FROM workspace_integrations WHERE workspace_id = workspace_a) <> 0 THEN
    RAISE EXCEPTION 'cross-workspace integration credential metadata leaked';
  END IF;
  IF (SELECT count(*) FROM outbox_events WHERE workspace_id = workspace_a) <> 0 THEN
    RAISE EXCEPTION 'cross-workspace outbox payload leaked';
  END IF;

  IF (SELECT count(*) FROM workspace_integrations WHERE workspace_id = workspace_b) <> 0 THEN
    RAISE EXCEPTION 'Tenant B unexpectedly sees Tenant A integration rows';
  END IF;
  IF (SELECT count(*) FROM outbox_events WHERE workspace_id = workspace_b) <> 0 THEN
    RAISE EXCEPTION 'Tenant B unexpectedly sees Tenant A outbox rows';
  END IF;
END;
$$;
ROLLBACK;
