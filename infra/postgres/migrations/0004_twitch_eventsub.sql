-- Durable Twitch EventSub subscription metadata and verified webhook deliveries.
-- Signing secrets are stored only as versioned encrypted envelopes.

CREATE TABLE twitch_eventsub_subscriptions (
  subscription_id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'enabled', 'revoked', 'disabled')),
  condition jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_envelope jsonb NOT NULL,
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, subscription_id)
);
CREATE INDEX twitch_eventsub_subscriptions_workspace_status
  ON twitch_eventsub_subscriptions (workspace_id, status, event_type);

CREATE TABLE twitch_eventsub_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id text NOT NULL,
  message_id text NOT NULL UNIQUE,
  message_type text NOT NULL CHECK (
    message_type IN ('notification', 'revocation')
  ),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'processing', 'processed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  FOREIGN KEY (workspace_id, subscription_id)
    REFERENCES twitch_eventsub_subscriptions(workspace_id, subscription_id)
    ON DELETE CASCADE
);
CREATE INDEX twitch_eventsub_deliveries_pending
  ON twitch_eventsub_deliveries (received_at, id)
  WHERE status IN ('accepted', 'failed');
CREATE INDEX twitch_eventsub_deliveries_workspace_received
  ON twitch_eventsub_deliveries (workspace_id, received_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'twitch_eventsub_subscriptions',
    'twitch_eventsub_deliveries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (
        (
          workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
          AND EXISTS (
            SELECT 1 FROM workspace_memberships m
             WHERE m.workspace_id = %I.workspace_id
               AND m.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
               AND m.status = ''active''
          )
        )
        OR subscription_id = nullif(current_setting(''app.twitch_lookup_id'', true), '''')
      ) WITH CHECK (
        (
          workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
          AND EXISTS (
            SELECT 1 FROM workspace_memberships m
             WHERE m.workspace_id = %I.workspace_id
               AND m.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
               AND m.status = ''active''
          )
        )
        OR subscription_id = nullif(current_setting(''app.twitch_lookup_id'', true), '''')
      )',
      table_name || '_member_or_webhook_access', table_name, table_name, table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON twitch_eventsub_subscriptions TO platform_runtime;
GRANT SELECT, INSERT, UPDATE ON twitch_eventsub_deliveries TO platform_runtime;
