-- Durable, idempotent EventSub intake. This deliberately does not map rewards
-- to features or create media_requests / logical queue entries.
ALTER TABLE twitch_eventsub_deliveries
  ADD CONSTRAINT twitch_eventsub_deliveries_workspace_id_unique UNIQUE (workspace_id, id);

CREATE TABLE twitch_eventsub_intake (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_id uuid NOT NULL,
  subscription_id text NOT NULL,
  message_id text NOT NULL,
  message_type text NOT NULL CHECK (message_type IN ('notification', 'revocation')),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 160),
  event_version text NOT NULL DEFAULT '1',
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 160),
  event_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, delivery_id)
    REFERENCES twitch_eventsub_deliveries(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, event_type, event_id),
  UNIQUE (delivery_id)
);
CREATE INDEX twitch_eventsub_intake_workspace_received
  ON twitch_eventsub_intake (workspace_id, received_at DESC);
CREATE INDEX twitch_eventsub_intake_event_type
  ON twitch_eventsub_intake (event_type, received_at DESC);
ALTER TABLE twitch_eventsub_intake ENABLE ROW LEVEL SECURITY;
ALTER TABLE twitch_eventsub_intake FORCE ROW LEVEL SECURITY;
CREATE POLICY twitch_eventsub_intake_worker_access
  ON twitch_eventsub_intake TO platform_worker USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA public TO platform_worker;
GRANT SELECT, INSERT ON twitch_eventsub_intake TO platform_worker;
GRANT UPDATE (status, attempts, processed_at, last_error)
  ON twitch_eventsub_deliveries TO platform_worker;
