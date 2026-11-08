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
  INSERT INTO twitch_eventsub_subscriptions (
    subscription_id, workspace_id, event_type, event_version, status, secret_envelope
  ) VALUES (
    'worker-eventsub-subscription', workspace_id,
    'channel.channel_points_custom_reward_redemption.add', '1', 'enabled',
    '{"formatVersion":1}'::jsonb
  );
  INSERT INTO twitch_eventsub_deliveries (
    workspace_id, subscription_id, message_id, message_type, payload
  ) VALUES (
    workspace_id, 'worker-eventsub-subscription', 'worker-eventsub-message',
    'notification', '{"event":{"safe":true}}'::jsonb
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
  IF has_column_privilege('platform_worker', 'outbox_events', 'payload', 'UPDATE') THEN
    RAISE EXCEPTION 'worker unexpectedly has permission to rewrite outbox payloads';
  END IF;
  IF (SELECT count(*) FROM twitch_eventsub_deliveries WHERE message_id = 'worker-eventsub-message') <> 1 THEN
    RAISE EXCEPTION 'worker cannot claim the durable EventSub delivery';
  END IF;
  IF has_table_privilege('platform_worker', 'twitch_eventsub_subscriptions', 'SELECT') THEN
    RAISE EXCEPTION 'worker unexpectedly has access to EventSub signing secrets';
  END IF;
  IF has_column_privilege('platform_worker', 'twitch_eventsub_deliveries', 'payload', 'UPDATE') THEN
    RAISE EXCEPTION 'worker unexpectedly has permission to rewrite EventSub payloads';
  END IF;
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'platform_worker') THEN
    RAISE EXCEPTION 'worker role must not be superuser or bypass RLS';
  END IF;
END;
$$;
UPDATE outbox_events
   SET published_at = now()
 WHERE idempotency_key = 'worker-isolation-test';
UPDATE twitch_eventsub_deliveries
   SET dispatch_published_at = now()
 WHERE message_id = 'worker-eventsub-message';
ROLLBACK;
