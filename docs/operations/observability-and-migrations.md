# Operational observability and database-change baseline

## Health

- `/health/live` answers whether the API process is alive.
- `/health/ready` currently returns HTTP 503 because PostgreSQL and queue readiness checks are not yet connected.
- Readiness must become successful only after all dependencies required to serve the relevant process are healthy. Liveness must not fail merely because a downstream dependency is temporarily unavailable.

## Logs and correlation

- Emit structured JSON logs from API and worker processes.
- HTTP requests accept a bounded, character-validated `x-request-id`; otherwise the API generates a UUID.
- Carry the correlation ID through application use cases, outbox records, queued jobs, provider calls, and emitted realtime events as those systems are implemented.
- Redact access/refresh tokens, OAuth secrets, encryption material, authorization headers, and user-submitted private data.
- Never use workspace IDs, user IDs, request IDs, or other high-cardinality identifiers as metric labels.

## Errors

- Return stable, documented error codes and safe messages from public APIs.
- Keep stack traces, SQL details, provider credentials, and internal infrastructure details in access-controlled server logs only.
- Distinguish validation, authorization, dependency-unavailable, conflict, and unexpected internal errors.
- Do not retry non-retryable validation or authorization failures. Durable jobs must use bounded retries and idempotency.

## Metrics and alerts

- Start with built-in health, structured logs, and application-level metrics; do not introduce Prometheus/Grafana as a deployment dependency in the initial release.
- Instrument request latency/error counts, queue depth/age, worker failures/retries, provider health, playback transitions, and outbox lag.
- Use bounded metric dimensions such as process, operation, provider type, and outcome. Keep tenant-specific diagnostics in authorized logs rather than metric labels.
- Alert on service health and sustained user-visible failures, not isolated transient events.

## Database changes

See [PostgreSQL migration conventions](../../infra/postgres/migrations/README.md). Migrations are ordered and immutable after application, use a dedicated non-runtime role, and are checked in CI.
