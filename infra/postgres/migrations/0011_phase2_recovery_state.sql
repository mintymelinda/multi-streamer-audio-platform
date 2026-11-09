-- Phase 2 completion: persist authorization pause/recovery and operator-controlled
-- EventSub retry state. PostgreSQL remains authoritative; BullMQ jobs are hints.

ALTER TABLE workspace_integrations
  ADD COLUMN recovery_state text NOT NULL DEFAULT 'ready'
    CHECK (recovery_state IN ('ready', 'paused', 'pending_reconciliation')),
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN pause_reason text;

ALTER TABLE workspace_integrations
  ADD CONSTRAINT workspace_integrations_recovery_state_consistency
  CHECK (
    (recovery_state = 'paused' AND status = 'reauth_required' AND paused_at IS NOT NULL)
    OR recovery_state <> 'paused'
  );

ALTER TABLE twitch_eventsub_deliveries
  DROP CONSTRAINT twitch_eventsub_deliveries_status_check,
  ADD CONSTRAINT twitch_eventsub_deliveries_status_check
    CHECK (status IN ('accepted', 'processing', 'processed', 'failed', 'dismissed'));

CREATE INDEX twitch_eventsub_deliveries_failed_workspace
  ON twitch_eventsub_deliveries (workspace_id, received_at DESC)
  WHERE status = 'failed';

-- The existing member RLS policy remains the only runtime access path for
-- recovery actions. The API uses the verified workspace transaction context.
