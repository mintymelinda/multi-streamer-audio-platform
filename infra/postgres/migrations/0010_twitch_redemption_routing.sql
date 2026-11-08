-- Route verified Twitch redemptions through the existing Requests application use case.
-- The workspace owner is the stable service actor for webhook-originated requests;
-- the worker still has no direct access to reward mappings or request tables.

ALTER TABLE twitch_eventsub_subscriptions
  ADD COLUMN service_actor_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL;
ALTER TABLE twitch_eventsub_deliveries
  ADD COLUMN service_actor_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL;
ALTER TABLE twitch_eventsub_intake
  ADD COLUMN service_actor_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  ADD COLUMN routing_status text NOT NULL DEFAULT 'pending'
    CHECK (routing_status IN ('pending', 'processing', 'processed', 'ignored', 'failed')),
  ADD COLUMN routing_attempts integer NOT NULL DEFAULT 0 CHECK (routing_attempts >= 0),
  ADD COLUMN routing_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN routing_locked_at timestamptz,
  ADD COLUMN routing_lock_token uuid,
  ADD COLUMN routed_request_id uuid,
  ADD COLUMN routing_error_code text,
  ADD CONSTRAINT twitch_eventsub_intake_routing_lock_pair
    CHECK ((routing_locked_at IS NULL) = (routing_lock_token IS NULL)),
  ADD CONSTRAINT twitch_eventsub_intake_request_fk
    FOREIGN KEY (workspace_id, routed_request_id)
    REFERENCES media_requests(workspace_id, id) ON DELETE SET NULL (routed_request_id);

CREATE INDEX twitch_eventsub_intake_routing
  ON twitch_eventsub_intake (routing_next_attempt_at, received_at, id)
  WHERE routing_status IN ('pending', 'processing');

-- The API router may claim durable intake rows across workspaces. It then
-- re-enters the normal tenant RLS context (owner + workspace) before reading
-- a reward mapping or invoking RequestsService.
CREATE POLICY twitch_eventsub_intake_api_router
  ON twitch_eventsub_intake TO platform_runtime
  USING (true)
  WITH CHECK (true);
GRANT SELECT, UPDATE (
  routing_status,
  routing_attempts,
  routing_next_attempt_at,
  routing_locked_at,
  routing_lock_token,
  routed_request_id,
  routing_error_code
) ON twitch_eventsub_intake TO platform_runtime;

GRANT SELECT, UPDATE (service_actor_user_id)
  ON twitch_eventsub_subscriptions TO platform_runtime;
GRANT SELECT, UPDATE (service_actor_user_id)
  ON twitch_eventsub_deliveries TO platform_runtime;
