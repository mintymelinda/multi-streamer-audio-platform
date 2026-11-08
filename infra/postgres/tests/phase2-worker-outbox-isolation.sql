-- The worker can dispatch outbox rows but cannot read workspace business data.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  actor_id uuid := gen_random_uuid();
  workspace_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO platform_users (id, twitch_user_id) VALUES (actor_id, '950000001');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_id, 'Worker dispatch isolation', actor_id, '950000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_id, actor_id, 'owner');
  INSERT INTO outbox_events (
    workspace_id, event_type, aggregate_type, aggregate_id, idempotency_key, payload
  ) VALUES (
    workspace_id, 'test.event', 'test', 'test-aggregate', 'worker-isolation-test', '{"safe":true}'::jsonb
  );
END;
$$;

SET LOCAL ROLE platform_worker;
DO $$
BEGIN
  IF current_user <> 'platform_worker' THEN
    RAISE EXCEPTION 'worker role was not activated';
  END IF;
  IF (SELECT count(*) FROM outbox_events WHERE idempotency_key = 'worker-isolation-test') <> 1 THEN
    RAISE EXCEPTION 'worker cannot claim the outbox event';
  END IF;
  IF has_table_privilege('platform_worker', 'media_requests', 'SELECT') THEN
    RAISE EXCEPTION 'worker unexpectedly has access to media_requests';
  END IF;
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'platform_worker') THEN
    RAISE EXCEPTION 'worker role must not be superuser or bypass RLS';
  END IF;
END;
$$;
UPDATE outbox_events
   SET published_at = now()
 WHERE idempotency_key = 'worker-isolation-test';
ROLLBACK;
