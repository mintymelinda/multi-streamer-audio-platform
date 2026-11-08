# Transactional outbox contract

The API writes business state and its corresponding `outbox_events` row in the
same PostgreSQL transaction. If either write fails, neither may commit.

## Write rules

- Use `OutboxService.append(client, event)` with the exact `PoolClient` used
  for the business transaction.
- The transaction must have authenticated user context and a workspace context
  established only after membership verification.
- Use a stable, deterministic idempotency key for the logical event.
- Keep payloads limited to the data required by downstream handlers. Never put
  access tokens, refresh tokens, client secrets, session tokens, or encryption
  keys in an outbox payload.
- Treat PostgreSQL as authoritative. Redis/BullMQ messages are dispatch hints
  and must be safely reconstructible from unpublished outbox rows.
- Consumers must be idempotent. Publishing, delivery, and processing are
  separate states; a successful Redis enqueue is not proof that the business
  operation completed.

## Worker contract

The Phase 2 dispatcher must claim events with bounded leases, recover expired
leases, increment attempts, and publish using stable event IDs. It must not
use a database role with `BYPASSRLS`. Event payload reads and state changes
must occur with verified workspace context. Failed dispatches must remain
durable and observable; no event may be silently dropped.

## Retention

Outbox rows are temporary operational data. Apply the architecture's 30-day
retention to completed dispatch records, while never expiring an unpublished
event solely because it is old. Active work must be reconciled before cleanup.
