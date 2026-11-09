-- Complete durable operator recovery for transactional outbox dispatch.
ALTER TABLE outbox_events
  ADD COLUMN last_retried_at timestamptz,
  ADD COLUMN dispatch_generation integer NOT NULL DEFAULT 0
    CHECK (dispatch_generation >= 0),
  ADD COLUMN dispatch_status text NOT NULL DEFAULT 'pending'
    CHECK (dispatch_status IN ('pending', 'published', 'failed', 'dismissed'));

UPDATE outbox_events
   SET dispatch_status = 'published'
 WHERE published_at IS NOT NULL;

CREATE INDEX outbox_events_failed_workspace
  ON outbox_events (workspace_id, occurred_at DESC)
  WHERE dispatch_status = 'failed';

GRANT UPDATE (dispatch_status) ON outbox_events TO platform_worker;
