-- Make operator-triggered EventSub retries distinct from retained failed BullMQ jobs.
ALTER TABLE twitch_eventsub_deliveries
  ADD COLUMN last_retried_at timestamptz,
  ADD COLUMN dispatch_generation integer NOT NULL DEFAULT 0
    CHECK (dispatch_generation >= 0);

CREATE INDEX twitch_eventsub_deliveries_due_dispatch
  ON twitch_eventsub_deliveries (next_dispatch_at, received_at)
  WHERE status = 'accepted' AND dispatch_published_at IS NULL;
