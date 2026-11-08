-- Worker can durably intake EventSub notifications without reading secrets.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE actor_id uuid := gen_random_uuid(); workspace_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO platform_users (id, twitch_user_id) VALUES (actor_id, '950000002');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_id, 'EventSub intake isolation', actor_id, '950000002');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_id, actor_id, 'owner');
  INSERT INTO twitch_eventsub_subscriptions
    (subscription_id, workspace_id, event_type, event_version, status, secret_envelope)
  VALUES ('worker-intake-subscription', workspace_id,
    'channel.channel_points_custom_reward_redemption.add', '1', 'enabled',
    '{"formatVersion":1}'::jsonb);
  INSERT INTO twitch_eventsub_deliveries
    (workspace_id, subscription_id, message_id, message_type, payload, dispatch_published_at)
  VALUES (workspace_id, 'worker-intake-subscription', 'worker-intake-message',
    'notification',
    '{"subscription":{"type":"channel.channel_points_custom_reward_redemption.add","version":"1"},"event":{"id":"redemption-123","reward":{"id":"reward-123"}}}'::jsonb,
    now());
END;
$$;
SET LOCAL ROLE platform_worker;
DO $$
DECLARE v_delivery_id uuid; v_workspace_id uuid;
BEGIN
  SELECT id, d.workspace_id INTO v_delivery_id, v_workspace_id
    FROM twitch_eventsub_deliveries d WHERE message_id = 'worker-intake-message';
  INSERT INTO twitch_eventsub_intake
    (workspace_id, delivery_id, subscription_id, message_id, message_type,
     event_type, event_version, event_id, event_payload)
  VALUES (v_workspace_id, v_delivery_id, 'worker-intake-subscription',
    'worker-intake-message', 'notification',
    'channel.channel_points_custom_reward_redemption.add', '1',
    'redemption-123', '{"id":"redemption-123"}'::jsonb)
  ON CONFLICT (workspace_id, event_type, event_id) DO NOTHING;
  IF (SELECT count(*) FROM twitch_eventsub_intake WHERE event_id = 'redemption-123') <> 1
    THEN RAISE EXCEPTION 'worker could not persist EventSub intake'; END IF;
  IF has_table_privilege('platform_worker', 'media_requests', 'SELECT')
    THEN RAISE EXCEPTION 'worker unexpectedly has media_requests access'; END IF;
  IF has_table_privilege('platform_worker', 'twitch_eventsub_subscriptions', 'SELECT')
    THEN RAISE EXCEPTION 'worker unexpectedly has subscription-secret access'; END IF;
  IF has_column_privilege('platform_worker', 'twitch_eventsub_deliveries', 'payload', 'UPDATE')
    THEN RAISE EXCEPTION 'worker unexpectedly can rewrite EventSub payloads'; END IF;

  -- Terminal failure state is writable without granting payload or secret access.
  UPDATE twitch_eventsub_deliveries
     SET status = 'failed', last_error = 'eventsub_processing_exhausted'
   WHERE id = v_delivery_id AND workspace_id = v_workspace_id;
  IF (SELECT status FROM twitch_eventsub_deliveries WHERE id = v_delivery_id) <> 'failed'
    THEN RAISE EXCEPTION 'worker could not persist terminal EventSub failure'; END IF;
END;
$$;
ROLLBACK;
