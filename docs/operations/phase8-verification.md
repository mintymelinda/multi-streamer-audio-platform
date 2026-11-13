# Phase 8 verification and capacity test guide

This guide separates automated checks, operator-run staging checks, and capabilities that are not yet implemented. Passing the current unit/integration suite is not equivalent to passing the full Phase 8 release gate.

## Automated CI evidence

The existing repository test command includes all files matching `scripts/test/*.test.mjs`. CI provides PostgreSQL 18.6 and Redis 7.4 services for the multi-process acceptance test.

| Check | Automated evidence | What it proves | What it does not prove |
|---|---|---|---|
| Database readiness | `apps/api/test/health.controller.test.mjs` | Liveness stays independent of PostgreSQL; readiness returns 200 after `SELECT 1` and a sanitized 503 on DB failure | Redis, object storage, worker, provider, or end-to-end readiness |
| Two-process lease contention | `scripts/test/phase8-postgres-multiprocess-lease.test.mjs` | Two independent `psql` processes using `platform_runtime` cannot steal the same live workspace/provider/player lease; the row/fencing token remains owned by the first session | Two actual API/worker deployments coordinating a full playback request across processes |
| Two API processes with playback and real-time fan-out | `scripts/test/phase8-playback-coordinator-multiprocess.test.mjs` | Boots two independent NestJS playback-coordinator processes, each with the production Redis Socket.IO adapter and workspace gateway, against shared PostgreSQL/Redis. Two real WebSocket clients subscribe to the same workspace. A Redis room broadcast and one PostgreSQL outbox notification each arrive exactly once per client, while concurrent duplicate play commands produce exactly one Lyrion `play` | BullMQ worker handoff in this same test, browser journeys, Twitch OAuth/session issuance, or a live Lyrion device |
| PostgreSQL outbox realtime fan-out | `scripts/test/phase8-workspace-realtime-multiprocess.test.mjs` | Two independent API gateway processes each subscribe to `platform_outbox_event`, authorize a workspace socket, and emit the same committed notification to their local room | Direct Socket.IO remote-room operations, cross-node socket enumeration, browser transport E2E, or the BullMQ provider-worker test |
| HTTP load runner | `scripts/test/load-http-workload.test.mjs` | Weighted scenario execution, authorization header handling, per-request identity templates, latency reporting, and failure-budget exit behavior | Platform capacity or SLO targets; tests use a local mock HTTP server |
| Backup CLI / crypto / S3 / WAL | `scripts/test/platform-backup-*.test.mjs` | Streaming archive primitives, immutable object transport, artifact context, WAL retry idempotency and tamper rejection | Real storage provider behavior, full PostgreSQL PITR, or independent-key restore drill |

The PostgreSQL concurrency test runs in CI when the existing PostgreSQL 18.6 service container is available. It is skipped during ordinary local `pnpm test` runs when CI service infrastructure is absent. CI must show the test as passed, not skipped, for the Phase 8 multi-process database lease gate.

## Representative non-production HTTP load

The sample profile is `scripts/load/representative-workload.example.json`. It includes weighted health, overlay snapshot, workspace queue, and request-intake scenarios. Its scene ID, workspace ID, test media ID, session cookie, CSRF token, and scene bearer token are placeholders and must be replaced with valid disposable staging data.

Create a private scenario file. Do not commit staging cookies, OAuth credentials, bearer tokens, CSRF tokens, or other live secrets:

```sh
umask 077
cp scripts/load/representative-workload.example.json /secure/staging-workload.json
chmod 600 /secure/staging-workload.json
```

After replacing the placeholders, run against an isolated staging deployment only:

```sh
node scripts/load/http-workload.mjs \
  --base-url https://staging.example.invalid \
  --scenario-file /secure/staging-workload.json \
  --duration-seconds 300 \
  --concurrency 40 \
  --timeout-ms 15000 \
  --max-error-rate 1 \
  --max-p95-ms 800 \
  --i-confirm-non-production
```

The runner limits duration to one hour, concurrency to 500, and scenario count to 50. It rejects non-HTTPS targets except loopback, scenario paths that escape the configured origin, scenario files that are not private, invalid header names/values, and GET/HEAD request bodies. It returns JSON with the target origin, request rate, success/error/timeout counts, per-scenario status totals, latency percentiles, and the configured pass/fail thresholds. It does not print request headers or bodies. It does not automatically discover or provision users/workspaces, and it is not a browser automation framework.

Use disposable request sources or a dedicated staging workspace. The sample request-intake scenario deliberately generates a different idempotency key and UUID for each request; remove the write scenario if the staging workspace is not isolated or if the expected provider route cannot safely process the test media. Clean up test requests and assets after each run.

### Workload sequence

Run separate staged profiles and retain the JSON output plus deployment metrics:

1. **Baseline:** 5 minutes at 10 concurrency. Confirm health, overlay snapshots, queue reads, and request intake.
2. **Expected load:** 15 minutes at the measured expected peak concurrency. Record p50/p95/p99 latency, RPS, error rate, DB pool utilization, Redis latency/queue depth, object storage latency, API/worker CPU and memory, and WebSocket connection counts.
3. **Burst:** 5 minutes at 2x the expected peak, within the runner's safety cap. Confirm bounded backpressure and no cross-workspace effects.
4. **Soak:** 60 minutes at expected sustained concurrency. Watch memory growth, open handles, queue lag, provider rate limiting, database connections, and error trends.
5. **Recovery:** stop one non-production API/worker instance while load remains active. Confirm other instances continue safe work, jobs are not duplicated, uncertain playback remains reserved for reconciliation, and the failed instance rejoins without replaying stale commands.

Do not infer an SLO from the sample defaults. Derive capacity thresholds from observed staging workload, expected tenant mix, provider rate limits, and available resource budgets. Publish the accepted SLO and alert thresholds only after operator review.

## Multi-instance validation

### PostgreSQL leases

The new two-connection test proves the conflict behavior at the database layer: one session holds the live lease row while another independent process attempts the same key. The second session's conditional upsert must not update the unexpired row. The assertion checks both the fencing token and the original owner after both sessions finish.

The new API coordinator regression test boots two independent NestJS `PlaybackCoordinatorModule` processes against shared PostgreSQL and deterministic local Invidious/Lyrion HTTP fixtures. It deliberately pauses the second process's stale Lyrion status observation until the first process has persisted `completed`, then verifies the duplicate reconciliation cannot downgrade that terminal row and no second `play` is issued. This tests the real API coordinator module and database repository across process boundaries, but it does not run BullMQ consumers or real provider hardware.

The remaining full multi-instance acceptance run must add at least two BullMQ provider consumers sharing PostgreSQL and Redis, with a single configured Lyrion test output (or a deterministic fake provider output). It must verify:
- concurrent play requests against one output issue at most one provider start;
- a second instance cannot steal an unexpired lease;
- an expired lease is reclaimed with a higher fencing token;
- a stale owner cannot write after fencing changes;
- a monitor observation cannot race a command on the same output;
- duplicate BullMQ delivery cannot double-start a request;
- worker restart and process termination leave uncertain commands recoverable;
- playback completion and queue advancement are idempotent across instances.

### Socket.IO and real-time fan-out

The multi-process acceptance test starts two independent playback-coordinator Nest application processes. Each process creates the production `RedisIoAdapter`, a real Socket.IO `/workspace` namespace, and the production `WorkspaceRealtimeGateway` against shared PostgreSQL and Redis. Two real WebSocket clients subscribe to the same workspace.

The test verifies both delivery paths:
- A room broadcast initiated by API process A reaches clients connected to both API processes through Redis, exactly once per client.
- One PostgreSQL outbox notification is delivered independently to both API processes; each gateway enumerates local sockets only, so each client receives exactly one copy rather than every process re-emitting to every socket.

The same two API processes concurrently execute the same idempotent playback command while a deterministic Lyrion fixture delays the first play and the duplicate's status reconciliation. The test verifies the operation remains completed and the provider receives exactly one `play`.

This closes the automated cross-instance Redis/outbox/playback regression gate for the tested application modules. It does not replace browser OBS/streamer journeys, actual Twitch OAuth session issuance, disconnect/reconnect and missed-event recovery tests, or a live Lyrion device. Do not infer those broader release gates from this test.

### Worker and scheduler coordination

The provider playback monitor is scheduled from the provider execution consumer. Its local boolean prevents overlap only within one process; cross-process output serialization depends on the database lease. The full two-worker acceptance test must confirm that scheduler overlap is harmless, DB leases serialize observation/commands, and all instances can shut down/restart without losing the durable session.

## Compose infrastructure smoke check

Run the isolated smoke test on a non-production host with Docker Compose available:

```sh
node scripts/ops/compose-infra-smoke.mjs
```

The script uses a unique Compose project, starts PostgreSQL, Redis, MinIO, and the MinIO initialization job, waits for PostgreSQL/Redis health and successful bucket setup, probes PostgreSQL and Redis, and tears down only that project's containers and volumes. The unique project prevents it from targeting the normal development project's named volumes.

**Scope boundary:** the repository's current Compose file has no API service and no complete overlay/web/reverse-proxy stack. This smoke check validates infrastructure services only. It is not full application deployment verification and must not be used against persistent development or production volumes. The existing CI Compose config validation continues to run separately.

## Browser-level E2E gap

There is no browser E2E harness in the current repository baseline. The HTTP workload runner and API tests do not cover a Twitch OAuth browser journey, dashboard interaction, moderator invite/accept flow, overlay editor publish flow, OBS browser-source rendering, or a complete user playback journey.

Before Phase 8 item 68 can close, add and run browser-level E2E tests in a disposable non-production environment for at least:
- Twitch sign-in, explicit workspace creation, workspace selection, and membership/role authorization;
- moderator invitation, acceptance under the intended Twitch identity, and immediate revocation;
- request intake, moderation, queue ordering, provider resolution, output assignment, playback, natural completion, and queue advance;
- uncertain provider result, manual recovery, worker restart, and duplicate-event delivery;
- scene creation, published token access, draft/publish isolation, unauthorized token rejection, and overlay reconnect/snapshot;
- export/deletion and deletion-safe restore, including an independent ledger replay.

Do not count a test as E2E unless it exercises the deployed HTTP/UI boundary and the required backing infrastructure, rather than only invoking an internal service method.

## Evidence required to close Phase 8

For each run, keep the exact source/artifact digest, environment topology, instance count, database/Redis/storage versions, scenario mix, request rate, resource metrics, latency percentiles, errors, recovery events, and test outputs. Redact cookies, provider tokens, OAuth codes, scene bearer tokens, media URLs containing credentials, and private viewer content.

Phase 8 remains open until:
- browser-level E2E coverage passes;
- two-process API coordinator playback regression passes against shared PostgreSQL;
- BullMQ worker/Redis and Socket.IO cross-instance multi-instance correctness is demonstrated with shared PostgreSQL/Redis;
- the load profile produces measured and approved capacity/SLO thresholds;
- the full application deployment is validated in a non-production environment (the current Compose smoke is infrastructure-only);
- incident, backup/restore, maintenance, operator, and streamer runbooks are rehearsed;
- application rollback and database/PITR recovery are verified and actual RPO/RTO are recorded.
