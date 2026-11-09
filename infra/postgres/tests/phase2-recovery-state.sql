-- Verify the persisted Phase 2 authorization and retry recovery states.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE platform_runtime;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.workspace_id', '', true);

DO $$
BEGIN
  IF (SELECT count(*) FROM workspace_integrations WHERE recovery_state = 'paused') <> 0 THEN
    RAISE EXCEPTION 'Twitch recovery state leaked without tenant context';
  END IF;
END;
$$;

DO $$
DECLARE
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  workspace_a uuid := gen_random_uuid();
  workspace_b uuid := gen_random_uuid();
  integration_id uuid;
  delivery_id uuid;
  outbox_id uuid;
BEGIN
  PERFORM set_config('app.user_id', user_a::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_a, '950000001');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_a, 'Recovery Tenant A', user_a, '950000001');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_a, user_a, 'owner');

  PERFORM set_config('app.user_id', user_b::text, true);
  INSERT INTO platform_users (id, twitch_user_id) VALUES (user_b, '950000002');
  INSERT INTO workspaces (id, name, owner_user_id, broadcaster_twitch_user_id)
    VALUES (workspace_b, 'Recovery Tenant B', user_b, '950000002');
  INSERT INTO workspace_memberships (workspace_id, user_id, role)
    VALUES (workspace_b, user_b, 'owner');

  PERFORM set_config('app.user_id', user_a::text, true);
  PERFORM set_config('app.workspace_id', workspace_a::text, true);
  INSERT INTO workspace_integrations (
    workspace_id, provider, status, recovery_state, paused_at, pause_reason,
    credential_ciphertext, credential_nonce, credential_auth_tag, wrapped_dek,
    dek_nonce, dek_auth_tag, kek_version, credential_format_version
  ) VALUES (
    workspace_a, 'twitch', 'reauth_required', 'paused', now(),
    'twitch_authorization_rejected',
    decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex'), decode('04', 'hex'),
    decode('05', 'hex'), decode('06', 'hex'), 'test-kek', 1
  ) RETURNING id INTO integration_id;

  IF NOT EXISTS (
    SELECT 1 FROM workspace_integrations
     WHERE id = integration_id AND status = 'reauth_required' AND recovery_state = 'paused'
  ) THEN
    RAISE EXCEPTION 'Twitch authorization pause was not persisted';
  END IF;

  UPDATE workspace_integrations
     SET status = 'connected', recovery_state = 'pending_reconciliation',
         paused_at = NULL, pause_reason = NULL
   WHERE id = integration_id;
  IF NOT EXISTS (
    SELECT 1 FROM workspace_integrations
     WHERE id = integration_id AND status = 'connected'
       AND recovery_state = 'pending_reconciliation'
  ) THEN
    RAISE EXCEPTION 'Reconnected Twitch integration must remain gated pending reconciliation';
  END IF;

  UPDATE workspace_integrations
     SET recovery_state = 'ready'
   WHERE id = integration_id;
  IF NOT EXISTS (
    SELECT 1 FROM workspace_integrations
     WHERE id = integration_id AND recovery_state = 'ready'
  ) THEN
    RAISE EXCEPTION 'Twitch recovery did not reach ready state';
  END IF;

  INSERT INTO twitch_eventsub_subscriptions (
    subscription_id, workspace_id, event_type, event_version, status, secret_envelope
  ) VALUES (
    'phase2-recovery-subscription', workspace_a, 'channel.update', '1', 'enabled', '{"test":true}'::jsonb
  );
  INSERT INTO twitch_eventsub_deliveries (
    workspace_id, subscription_id, message_id, message_type, payload, status
  ) VALUES (
    workspace_a, 'phase2-recovery-subscription', 'phase2-recovery-message',
    'notification', '{"event":{}}'::jsonb, 'failed'
  ) RETURNING id INTO delivery_id;

  UPDATE twitch_eventsub_deliveries
     SET status = 'accepted', attempts = 0, dispatch_published_at = NULL,
         dispatch_attempts = 0, dispatch_generation = dispatch_generation + 1,
         last_retried_at = now()
   WHERE workspace_id = workspace_a AND id = delivery_id AND status = 'failed';
  IF NOT EXISTS (
    SELECT 1 FROM twitch_eventsub_deliveries
     WHERE id = delivery_id AND status = 'accepted' AND attempts = 0
       AND dispatch_attempts = 0 AND dispatch_generation = 1 AND last_retried_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Failed EventSub delivery could not be requeued';
  END IF;

  UPDATE twitch_eventsub_deliveries
     SET status = 'dismissed', processed_at = now()
   WHERE workspace_id = workspace_a AND id = delivery_id AND status = 'accepted';
  IF NOT EXISTS (
    SELECT 1 FROM twitch_eventsub_deliveries
     WHERE id = delivery_id AND status = 'dismissed'
  ) THEN
    RAISE EXCEPTION 'EventSub delivery could not be dismissed';
  END IF;

  INSERT INTO outbox_events (
    workspace_id, event_type, aggregate_type, aggregate_id, idempotency_key,
    payload, attempt_count, dispatch_status, last_error_code
  ) VALUES (
    workspace_a, 'test.recovery', 'test', 'recovery-event', 'recovery-event-a',
    '{}'::jsonb, 8, 'failed', 'outbox_dispatch_exhausted'
  ) RETURNING id INTO outbox_id;
  IF NOT EXISTS (
    SELECT 1 FROM outbox_events WHERE id = outbox_id AND dispatch_status = 'failed'
  ) THEN
    RAISE EXCEPTION 'Terminal outbox failure was not persisted';
  END IF;
  UPDATE outbox_events
     SET dispatch_status = 'pending', attempt_count = 0,
         last_retried_at = now(), dispatch_generation = dispatch_generation + 1,
         available_at = now(), published_at = NULL
   WHERE workspace_id = workspace_a AND id = outbox_id AND dispatch_status = 'failed';
  IF NOT EXISTS (
    SELECT 1 FROM outbox_events WHERE id = outbox_id
      AND dispatch_status = 'pending' AND attempt_count = 0
      AND last_retried_at IS NOT NULL AND dispatch_generation = 1
  ) THEN
    RAISE EXCEPTION 'Failed outbox event could not be retried';
  END IF;
  UPDATE outbox_events
     SET dispatch_status = 'dismissed', published_at = NULL
   WHERE workspace_id = workspace_a AND id = outbox_id AND dispatch_status = 'pending';
  IF NOT EXISTS (
    SELECT 1 FROM outbox_events WHERE id = outbox_id AND dispatch_status = 'dismissed' AND published_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Outbox event could not be dismissed';
  END IF;

  PERFORM set_config('app.user_id', user_b::text, true);
  PERFORM set_config('app.workspace_id', workspace_b::text, true);
  IF (SELECT count(*) FROM workspace_integrations WHERE id = integration_id) <> 0 THEN
    RAISE EXCEPTION 'Twitch recovery state leaked across workspaces';
  END IF;
  IF (SELECT count(*) FROM twitch_eventsub_deliveries WHERE id = delivery_id) <> 0 THEN
    RAISE EXCEPTION 'EventSub recovery state leaked across workspaces';
  END IF;
  IF (SELECT count(*) FROM outbox_events WHERE id = outbox_id) <> 0 THEN
    RAISE EXCEPTION 'Outbox recovery state leaked across workspaces';
  END IF;
END;
$$;
ROLLBACK;
