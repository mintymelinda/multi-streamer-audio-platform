-- Give the background dispatcher a narrowly scoped, non-BYPASSRLS role.
-- It may claim and update outbox rows only; it cannot read business tables.
-- Production deployments must provision this login with a protected secret.

GRANT USAGE ON SCHEMA public TO platform_worker;

ALTER POLICY outbox_events_member_access ON outbox_events TO platform_runtime;

CREATE POLICY outbox_events_worker_dispatch ON outbox_events
  TO platform_worker
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON outbox_events TO platform_worker;
GRANT UPDATE (available_at, attempt_count, locked_at, lock_token, published_at, last_error_code)
  ON outbox_events TO platform_worker;
