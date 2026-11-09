-- Verify EventSub subscriptions and deliveries are tenant-isolated while the
-- signature-verification lookup context can access only the matching subscription.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.workspace_id', '', true);
SELECT set_config('app.twitch_lookup_id', '', true);

DO $$
BEGIN
  IF (SELECT count(*) FROM twitch_eventsub_subscriptions) <> 0 THEN
    RAISE EXCEPTION 'EventSub subscriptions leaked without context';
  END IF;
  IF (SELECT count(*) FROM twitch_eventsub_deliveries) <> 0 THEN
    RAISE EXCEPTION 'EventSub deliveries leaked without context';
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
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_a, '940000001');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_a, 'EventSub Tenant A', user_a, '940000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_a, user_a, 'owner');

  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_b, '940000002');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_b, 'EventSub Tenant B', user_b, '940000002');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_b, user_b, 'owner');

  SET CONSTRAINTS ALL IMMEDIATE;

  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  INSERT INTO twitch_eventsub_subscriptions (
    subscription_id, workspace_id, event_type, event_version, status, secret_envelope
  ) VALUES (
    'eventsub-subscription-a', workspace_a, 'channel.channel_points_custom_reward_redemption.add',
    '1', 'enabled', '{"formatVersion":1}'::jsonb
  );
  INSERT INTO twitch_eventsub_deliveries (
    workspace_id, subscription_id, message_id, message_type, payload
  ) VALUES (
    workspace_a, 'eventsub-subscription-a', 'eventsub-message-a', 'notification', '{"event":{}}'::jsonb
  );

  PERFORM set_config('app.user_id', user_b::text, true);
  PERFORM set_config('app.workspace_id', workspace_b::text, true);
  IF (SELECT count(*) FROM twitch_eventsub_subscriptions WHERE subscription_id = 'eventsub-subscription-a') <> 0 THEN
    RAISE EXCEPTION 'cross-workspace EventSub subscription leaked';
  END IF;
  IF (SELECT count(*) FROM twitch_eventsub_deliveries WHERE message_id = 'eventsub-message-a') <> 0 THEN
    RAISE EXCEPTION 'cross-workspace EventSub delivery leaked';
  END IF;

  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.workspace_id', '', true);
  PERFORM set_config('app.twitch_lookup_id', 'eventsub-subscription-a', true);
  IF (SELECT count(*) FROM twitch_eventsub_subscriptions) <> 1 THEN
    RAISE EXCEPTION 'webhook lookup did not resolve its own subscription';
  END IF;
  IF (SELECT count(*) FROM twitch_eventsub_deliveries) <> 1 THEN
    RAISE EXCEPTION 'webhook lookup did not resolve its own deliveries';
  END IF;

  PERFORM set_config('app.twitch_lookup_id', 'not-a-real-subscription', true);
  IF (SELECT count(*) FROM twitch_eventsub_subscriptions) <> 0 THEN
    RAISE EXCEPTION 'webhook lookup exposed a different subscription';
  END IF;
  IF (SELECT count(*) FROM twitch_eventsub_deliveries) <> 0 THEN
    RAISE EXCEPTION 'webhook lookup exposed a different subscription delivery';
  END IF;
END;
$$;
ROLLBACK;
