-- Dispatch durable Twitch EventSub deliveries to BullMQ without granting
-- the worker access to subscription secrets or workspace business tables.

ALTER TABLE twitch_eventsub_deliveries
  ADD COLUMN next_dispatch_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  ADD COLUMN dispatch_locked_at timestamptz,
  ADD COLUMN dispatch_lock_token uuid,
  ADD COLUMN dispatch_published_at timestamptz,
  ADD COLUMN dispatch_error_code text,
  ADD CONSTRAINT twitch_eventsub_delivery_dispatch_lock_pair
    CHECK ((dispatch_locked_at IS NULL) = (dispatch_lock_token IS NULL));

CREATE INDEX twitch_eventsub_deliveries_dispatch
  ON twitch_eventsub_deliveries (next_dispatch_at, received_at, id)
  WHERE status = 'accepted' AND dispatch_published_at IS NULL;

ALTER POLICY twitch_eventsub_deliveries_member_or_webhook_access
  ON twitch_eventsub_deliveries TO platform_runtime;

CREATE POLICY twitch_eventsub_deliveries_worker_dispatch
  ON twitch_eventsub_deliveries TO platform_worker
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON twitch_eventsub_deliveries TO platform_worker;
GRANT UPDATE (
  next_dispatch_at,
  dispatch_attempts,
  dispatch_locked_at,
  dispatch_lock_token,
  dispatch_published_at,
  dispatch_error_code
) ON twitch_eventsub_deliveries TO platform_worker;
