-- Complete durable operator recovery for transactional outbox dispatch.
ALTER TABLE outbox_events
  ADD COLUMN dispatch_status text NOT NULL DEFAULT 'pending'
    CHECK (dispatch_status IN ('pending', 'published', 'failed', 'dismissed'));

UPDATE outbox_events
   SET dispatch_status = 'published'
 WHERE published_at IS NOT NULL;

CREATE INDEX outbox_events_failed_workspace
  ON outbox_events (workspace_id, occurred_at DESC)
  WHERE dispatch_status = 'failed';
