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

The Phase 2 dispatcher claims events with bounded leases and
`FOR UPDATE SKIP LOCKED`, then publishes stable event IDs to the BullMQ
`platform-outbox` queue. It uses the dedicated `platform_worker` database
role, which is not a superuser and does not have `BYPASSRLS`. The role can
read/update outbox rows but has no grants on request, workspace, or integration
business tables.

- Claims recover automatically when a 60-second lease expires.
- Redis enqueue failures release the claim and schedule bounded exponential
  retry (5 seconds up to 1 hour).
- BullMQ job IDs equal the PostgreSQL outbox UUID, making enqueue retries
  idempotent.
- Completed BullMQ jobs are retained for 30 days; failed jobs remain available
  for inspection.
- An event is marked published only after BullMQ confirms the enqueue.
- Publishing does not mean a downstream business handler completed. Consumer
  processing, exhausted-failure recovery, and authorized manual replay remain
  Phase 2 work.

## Retention

Outbox rows are temporary operational data. Apply the architecture's 30-day
retention to completed dispatch records, while never expiring an unpublished
event solely because it is old. Active work must be reconciled before cleanup.
