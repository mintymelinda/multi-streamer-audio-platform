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

- The API's global exception filter maps HTTP failures to stable public error codes and safe messages.
- Unexpected server errors return a generic response with a request ID; stack traces and internal details remain in server logs only.
- Distinguish validation, authentication, authorization, not-found, conflict, rate-limit, dependency-unavailable, and unexpected internal errors.
- Do not retry non-retryable validation or authorization failures. Durable jobs must use bounded retries and idempotency.
- Provider-specific and domain-specific error codes are added by the owning modules without leaking provider payloads or secrets.

## Metrics and alerts

- Start with built-in health, structured logs, and application-level metrics; do not introduce Prometheus/Grafana as a deployment dependency in the initial release.
- Instrument request latency/error counts, queue depth/age, worker failures/retries, provider health, playback transitions, and outbox lag as those features are introduced.
- Use bounded metric dimensions such as process, operation, provider type, and outcome. Keep tenant-specific diagnostics in authorized logs rather than metric labels.
- Alert on service health and sustained user-visible failures, not isolated transient events.

## Database changes

See [PostgreSQL migration conventions](../../infra/postgres/migrations/README.md). Migrations are ordered and immutable after application, use a dedicated non-runtime role, and are checked in CI.
