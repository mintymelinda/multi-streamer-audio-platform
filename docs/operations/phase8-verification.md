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

The merged Phase 8 worker-to-live-API acceptance test boots two independent BullMQ provider consumers sharing PostgreSQL and Redis and routes them through the real Fastify handoff controller, Playback Coordinator, Invidious resolver, and Lyrion adapter using deterministic local HTTP fixtures. Five independent workspaces prove the second worker consumes from the shared queue; duplicate delivery does not create an extra handoff. It verifies all five requests reach `playing` with one durable operation and one play per assigned output.

The broader restart/fencing/reconciliation acceptance criteria remain:
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

This is the automated cross-instance Redis/outbox/playback regression gate for the tested application modules; require a green CI run on the exact PR head before marking item 70 complete. It does not replace browser OBS/streamer journeys, actual Twitch OAuth session issuance, disconnect/reconnect and missed-event recovery tests, or a live Lyrion device. Do not infer those broader release gates from this test.

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

The first browser harness lives in `scripts/e2e/browser-smoke.mjs`. CI builds the dashboard and overlay, installs an isolated pinned Playwright runtime and Chromium, starts both production Next.js servers, and drives them in headless Chromium.

The initial browser smoke suite covers:
- the unauthenticated dashboard sign-in boundary and Twitch sign-in link;
- published overlay rendering through the actual overlay page/client, with a stubbed snapshot HTTP response;
- bearer-token handling (the token is read from the URL fragment, scrubbed from browser history, and sent in the Authorization header);
- the overlay Socket.IO namespace handshake; and
- invalid/missing overlay-token rejection.

The test intentionally stubs API HTTP responses and the Socket.IO server. It proves the real built frontend and browser code, but does **not** yet prove PostgreSQL-backed authentication, actual Twitch OAuth, real API/Redis integration, reconnect/missed-event recovery, moderator workflows, editor publish isolation, OBS rendering, or playback. The Playwright package is installed into the runner's temporary directory and is not added to the application dependency graph or lockfile.

A second browser test, `scripts/e2e/authenticated-session.mjs`, starts the built dashboard and overlay against a real API process backed by the CI PostgreSQL service. It seeds a short-lived, hashed server-side session for a disposable test identity, then verifies:
- an unauthenticated browser sees the Twitch sign-in boundary;
- the real API resolves the opaque HTTP-only session cookie and returns the expected stable Twitch identity;
- the dashboard can explicitly create a workspace through the real authenticated API;
- a second disposable workspace owned by another identity is absent from the authenticated user's workspace list, and both read and mutation attempts against its scene API return the non-disclosing not-found boundary;
- a pending invitation grants no workspace access, a different signed-in identity cannot accept it, acceptance by the intended Twitch identity grants exactly the assigned Moderator role, and the owner can revoke that membership with subsequent protected access denied immediately;
- the dashboard creates a published starter scene through the real workspace-scoped API;
- the built OBS overlay loads that scene snapshot through the real bearer-token endpoint and scrubs the fragment token from browser history;
- published snapshot responses enforce private no-store caching, no-referrer, and authorization-vary headers;
- unknown well-formed bearer tokens are rejected without scene disclosure, and malformed fragment tokens are rejected before any snapshot request;
- publishing a changed scene while the overlay browser is offline is recovered from the latest published snapshot after the Socket.IO connection reconnects;
- saving a draft does not alter the public overlay until the draft is explicitly published, after which the live overlay receives the published state;
- revoking the scene token through the authenticated API invalidates the live overlay connection and returns the browser to the revoked-token boundary;
- an invalid CSRF token cannot log out the session;
- a valid CSRF token revokes the session and the next page load returns to the sign-in boundary.

This exercises the production session guard, workspace creation transaction, PostgreSQL runtime role, RLS-backed workspace queries, scene creation and publication, overlay bearer-token authentication, live Socket.IO access revocation, CSRF guard, and session revocation through the browser/API boundary. The identity is seeded directly; the test does **not** exercise Twitch's external OAuth authorization-code exchange or prove actual Twitch identity validation. It also does not yet cover moderator queue workflows, full Twitch OAuth issuance, or OBS rendering. The reconnect check verifies snapshot recovery after a deliberately missed publication event, not every transport failure mode. The API proxy origin is fixed to the local CI API address at build time for this test suite.

The HTTP workload runner and API tests still do not cover a complete user playback journey.

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

## Item 71 — non-production HTTPS edge proxy

The staging edge proxy is defined separately from the local-development Compose stack:

- `infra/compose/docker-compose.edge.yml` runs Caddy on ports 80/443 and joins the application network as an external network.
- `infra/compose/Caddyfile` routes the dashboard, overlay, and API hostnames to the corresponding internal service names. Caddy's reverse proxy handles WebSocket upgrades for Socket.IO without a separate WebSocket listener.
- `infra/compose/.env.edge.example` lists the non-secret hostname, ACME contact, and shared network settings. Copy it to a private staging environment file and replace every example hostname with a DNS name resolving to the staging host before starting the edge service.
- Caddy's certificate and account state is persisted in the `caddy_data` volume; `caddy_config` persists its runtime configuration. Do not delete these volumes during routine container replacement.

The registered Twitch callback URLs must exactly match the externally reachable API hostname:

- Sign-in: `https://<API_DOMAIN>/auth/twitch/callback`
- Broadcaster authorization: `https://<API_DOMAIN>/auth/twitch/integration/callback`

Set the API's `TWITCH_REDIRECT_URI` and `TWITCH_INTEGRATION_REDIRECT_URI` to those exact HTTPS URLs. The app uses explicit configured callback URLs rather than reconstructing them from proxy headers. Keep the API, dashboard, overlay, PostgreSQL, Redis, and object-storage services on the private application network; only the Caddy edge publishes host ports.

CI validates the edge Compose model and parses/validates the Caddyfile. These static checks do not prove public DNS, ACME issuance, upstream reachability, WebSocket operation, OAuth provider registration, or persistence across a real staging restart; those remain runtime acceptance checks for this item. Do not use the example `.net` hostnames as real deployment values.

### Staging Compose application stack

The non-production application deployment is defined in `infra/compose/docker-compose.staging.yml` and built with `infra/compose/Deployment.Dockerfile`. The deployment uses one immutable image for the API, background worker, dashboard, and overlay, while each runs as a separate container/process.

Before starting staging:

1. Copy `infra/compose/.env.staging.example` to a private `.env.staging` file and replace all example values. Use distinct randomly generated PostgreSQL role passwords and MinIO credentials; set the file mode to `0600`.
2. Create the secret files named by the `*_SECRET_FILE` settings under `infra/compose/secrets/`. They must contain the matching API, worker, provider-worker, and Redis connection URLs; the Twitch client secret; a valid integration KEK ring; and a provider-execution handoff secret of at least 32 characters. Generate a unique 32-byte KEK for the staging environment. Never reuse CI or example values.
3. Register the two exact Twitch callback URLs shown above and use the same API hostname in the staging environment file.
4. Point all four hostnames (dashboard, overlay, API, assets) at the staging host. Only the Caddy edge publishes ports 80/443; PostgreSQL and Redis are on an internal-only network, and object storage has no direct host port.
5. Start the application stack, wait for the migration job and service health checks, then start the edge proxy using the same staging environment file:

   ```sh
   docker compose --env-file infra/compose/.env.staging -f infra/compose/docker-compose.staging.yml up -d --build
   docker compose --env-file infra/compose/.env.staging -f infra/compose/docker-compose.edge.yml up -d
   ```

6. Verify `/health/ready`, dashboard and overlay pages, a real Socket.IO connection through the API hostname, an upload/download round trip through the assets hostname, and both Twitch OAuth redirect destinations. Confirm PostgreSQL, Redis, object storage, and Caddy data volumes survive container recreation.

The app network is shared with Caddy so the proxy can reach only the intended HTTP upstreams. PostgreSQL and Redis use a separate internal-only network. The Compose definitions and Caddyfile are validated in CI; the runtime checks above still require a disposable staging host with real DNS and provider callback registration. This stack is a staging verification target, not a production/NAS deployment recipe.

### Staging ingress smoke runner

After the Compose services and Caddy edge are running with real staging DNS and TLS, execute the ingress acceptance probe from a trusted operator workstation:

```sh
node scripts/ops/staging-deployment-smoke.mjs \
  --api-url https://api.staging.example.net \
  --dashboard-url https://dashboard.staging.example.net \
  --overlay-url https://overlay.staging.example.net \
  --assets-url https://assets.staging.example.net \
  --twitch-integration-callback-url https://api.staging.example.net/auth/twitch/integration/callback \
  --i-confirm-non-production
```

The runner checks API liveness/readiness, dashboard and overlay HTTP responses, MinIO readiness through the asset hostname, a real Socket.IO Engine.IO WebSocket handshake through Caddy, and the Twitch sign-in redirect URI returned by the API. It also checks that the supplied broadcaster-authorization callback exactly matches the API hostname. The Twitch sign-in probe creates a short-lived OAuth state record but does not authorize an account or exchange a code. The runner does not print the authorization URL or its state token.

Use the exact configured callback from the staging environment file. The probe intentionally requires HTTPS and an explicit non-production confirmation; it is not a production health checker. A passing result is evidence of public ingress only, not full OAuth provider approval, browser behavior, asset upload authorization, or persistence across container recreation.

### Persistent-volume restart drill

Run this only during a quiet staging maintenance window. It recreates the PostgreSQL, Redis, MinIO, and Caddy edge containers but deliberately retains their named volumes. The drill writes temporary probe data to all three stores, recreates the containers, verifies that the same named volumes are reattached and the probe data survives, then removes the probe records:

```sh
node scripts/ops/staging-volume-restart-drill.mjs \
  --env-file infra/compose/.env.staging \
  --api-url https://api.staging.example.net \
  --assets-url https://assets.staging.example.net \
  --i-confirm-non-production
```

The drill never runs `docker compose down --volumes` and never deletes the named volumes. Run both the application and edge Compose stacks before starting it; Caddy must already have issued its staging certificates. It briefly interrupts staging database, Redis, and object-storage connections while the three containers are recreated. If interrupted before cleanup, the PostgreSQL probe table is removed on the next successful run and Redis/object-storage probes have unique identifiers; inspect any leftover object before manually deleting it. A passing drill proves persistence across container recreation, not backup restoration or disaster recovery.

### Preparing staging secrets

Keep `infra/compose/.env.staging` private (`chmod 600`) and use URL-safe hexadecimal values for database and MinIO passwords so they can safely appear in PostgreSQL connection URLs. Generate unique values; never copy the example strings or CI credentials:

```sh
umask 077
cp infra/compose/.env.staging.example infra/compose/.env.staging
# Edit .env.staging: set each password to a different value from: openssl rand -hex 32
mkdir -p infra/compose/secrets
chmod 700 infra/compose/secrets
set -a
. infra/compose/.env.staging
set +a
printf 'postgres://platform_runtime:%s@postgres:5432/platform' "$PLATFORM_RUNTIME_PASSWORD" > infra/compose/secrets/api-database-url
printf 'postgres://platform_worker:%s@postgres:5432/platform' "$PLATFORM_WORKER_PASSWORD" > infra/compose/secrets/worker-database-url
printf 'postgres://platform_provider_worker:%s@postgres:5432/platform' "$PLATFORM_PROVIDER_WORKER_PASSWORD" > infra/compose/secrets/provider-execution-database-url
printf '%s' 'redis://redis:6379' > infra/compose/secrets/redis-url
openssl rand -hex 32 > infra/compose/secrets/provider-execution-handoff-secret
node --input-type=module -e 'import { randomBytes } from "node:crypto"; const key = randomBytes(32).toString("base64"); process.stdout.write(JSON.stringify({ currentVersion: "v1", keys: { v1: key } }));' > infra/compose/secrets/integration-kek-ring.json
install -m 600 /secure/location/twitch-client-secret infra/compose/secrets/twitch-client-secret
chmod 600 infra/compose/secrets/* infra/compose/.env.staging
```

Keep the generated KEK ring independent of database/object-storage backups and retain its recovery copy securely. The KEK ring is not interchangeable between staging and production. The Twitch client secret file must contain the exact secret from the registered Twitch application. The database URL files must use the matching role password from `.env.staging`. Do not print or commit any of these files.

### Safe staging domain migration

Treat a domain change as a coordinated configuration and OAuth change, not just a DNS edit:

1. Lower the DNS TTL for the existing hostnames in advance, then add the new dashboard, overlay, API, and asset records pointing at the staging host.
2. Register both new Twitch callback URLs in the Twitch developer console before switching the API configuration: `https://<new-api-host>/auth/twitch/callback` and `https://<new-api-host>/auth/twitch/integration/callback`.
3. Update the four domain values and both callback URLs in `.env.staging`. Add temporary old-host site blocks to `infra/compose/Caddyfile` that reverse-proxy to the same internal services so existing browser/OBS clients and outstanding signed asset URLs continue to work during the transition.
4. Recreate the edge and API services using the updated environment. Caddy obtains certificates for the new names and retains its account/certificate state in the existing `caddy_data` volume.
5. Run the ingress smoke runner against the new four origins. Confirm the Twitch sign-in `redirect_uri` matches the new API host and the broadcaster callback value is exact.
6. Keep the old host routes until DNS caches have expired and existing overlay clients have had time to reconnect. Keep the old asset host available for at least the maximum signed-URL lifetime. Then remove the temporary old-host blocks and retire the old DNS records.

Do not delete Caddy or application data volumes as part of a domain migration. This procedure is for the isolated staging environment; production migration requires a separately approved maintenance and rollback plan.



## Item 73 — CI quality-gate baseline

The required pull-request check is the `Quality gates` job in `.github/workflows/ci.yml`. It runs:

- Biome lint on changed, existing JavaScript/TypeScript/JSON/CSS files via `pnpm lint:changed` (formatting is intentionally not a CI gate);
- TypeScript type checking and migration naming/order validation;
- unit and integration tests, including PostgreSQL tenant/authorization checks;
- workspace builds and the immutable staging application image build;
- standalone dashboard/overlay container smoke tests; and
- browser UI smoke tests plus authenticated browser/API/overlay E2E.

The CI workflow uses a read-only repository token and disables persisted checkout credentials. It does not mutate or push lockfile changes. Dependency lockfile updates must be reviewed and committed as ordinary source changes. The repository-wide `pnpm lint` command currently reports pre-existing lint debt, so it is not used as a blanket gate; changed supported files are linted instead, preventing unrelated legacy findings from making every PR red. The changed-file runner uses the pull-request base/head range or push before/head range, ignores deleted files and unsupported formats, and fails closed when it cannot determine the event range.

Protect the default branch in repository settings: require pull requests, require the `Quality gates` and `Analyze JavaScript and TypeScript` checks, dismiss stale approvals when new commits are pushed, and restrict bypasses to the platform owner. The GitHub connector available during this implementation cannot configure branch-protection rules, so these repository settings remain an explicit operator setup step.

This section records the CI baseline only. The controlled deployment path and its risk/approval policy are implemented separately; passing CI alone is not authorization to deploy.


## Item 73 — controlled staging releases

The release workflow is `.github/workflows/staging-deploy.yml`. It deploys only to a separately provisioned non-production staging host; it does not deploy to production or the operator's NAS.

### Release classification

The workflow runs automatically only after the `CI` workflow completes successfully for a push to `main` from this repository. It refuses to deploy if a newer commit has already reached `main`, compares the tested commit with the previous successful main-branch CI push, and applies the conservative classifier in `scripts/release/classify-change.mjs`:

- **Routine:** every runtime change is limited to dashboard/overlay CSS or static raster/font presentation assets under the relevant app's `public` directory. Active SVG content and all other paths require approval. If staging deployment is enabled, the immutable image is deployed automatically.
- **Documentation-only:** no application deployment is needed.
- **Approval required:** all other paths, including application logic, API/worker code, provider behavior, authorization/security, dependencies, migrations, infrastructure, CI/workflow changes, and unknown or incomplete change lists.

If no trustworthy prior successful CI baseline is available, the workflow defaults to approval required. A manual deployment is always treated as high risk, even if its changed files would otherwise be routine.

### High-risk approval

A high-risk staging release must be started through the workflow's `workflow_dispatch` entry on `main`, with `approve_high_risk` explicitly checked. The initiating GitHub actor must be the platform owner account `mintymelinda`, and the exact main commit must already have a successful CI push run. The job uses the `staging-approval` GitHub environment as an additional review gate.

Routine deployments use the separate `staging-auto` environment. Configure `staging-approval` with the platform owner as a required reviewer; configure self-review according to the owner's approval policy. Do not add reviewers to `staging-auto` if automatic routine deployment is desired.

### One-time GitHub configuration

Automatic and manual deployment remain disabled until the repository variable `STAGING_DEPLOY_ENABLED` is set to `true`. Configure the following secrets in **both** `staging-auto` and `staging-approval` environments:

- `STAGING_SSH_HOST`, `STAGING_SSH_USER`, and `STAGING_DEPLOY_PATH` (an absolute path on the disposable staging host);
- `STAGING_SSH_PRIVATE_KEY` and `STAGING_SSH_KNOWN_HOSTS` (the latter must contain a host key fingerprint verified out of band; the workflow does not trust runtime `ssh-keyscan`);
- `STAGING_GHCR_USERNAME` and `STAGING_GHCR_READ_TOKEN` (a registry identity/token with package read access);
- `STAGING_API_URL`, `STAGING_DASHBOARD_URL`, `STAGING_OVERLAY_URL`, `STAGING_ASSETS_URL`, and `STAGING_TWITCH_INTEGRATION_CALLBACK_URL` (the exact public HTTPS origins and registered callback for that staging environment).

The host must already have Docker Engine and the Compose plugin. Provision `infra/compose/.env.staging` and every referenced secret file on the host before enabling the workflow. Keep those values out of GitHub logs and repository files. The deployment copies only the Compose definitions, Caddyfile, PostgreSQL initialization SQL, and migrations; it does not copy or overwrite the staging environment file, credentials, or persistent volumes.

### Deployment and recovery behavior

The workflow builds one image tagged with the exact tested commit SHA and publishes it to GHCR, then deploys that image through the remote no-build Compose override. It first verifies PostgreSQL, Redis, and object-storage initialization. Only an explicitly approved high-risk release runs the migration service; the workflow waits for successful migration completion before updating the API, then waits for API readiness before restarting the worker, dashboard, and overlay. It verifies all application containers and the edge container before running the public ingress smoke test for HTTPS, API readiness, Socket.IO WebSocket upgrade, and Twitch callback configuration. Routine presentation-only releases do not rerun database migrations.

A failed routine presentation-only deployment attempts to restore the previous application image. High-risk deployments do not automatically roll back the application image because a schema or data change may make the previous image incompatible; follow the operator recovery procedure and assess database/PITR recovery separately. Image rollback is not database rollback.

The remote override is validated alongside the staging Compose model in CI. The actual SSH deployment is intentionally not run by pull-request CI. Configure the staging host and environment secrets only when a disposable non-production target is ready; enabling the workflow is an explicit operator action.


## Item 74 — release audit, post-deployment verification, and recovery

Every staging deployment job writes a sanitized `release-audit.json` in an `always()` step, including when image publication, remote deployment, container readiness, or public ingress fails. The workflow uploads that record together with `staging-ingress-checks.json` as a run-specific Actions artifact retained for 90 days. The job summary includes the release commit, risk class, immutable image reference, build/deploy/ingress outcomes, and rollback outcome. The record deliberately excludes SSH credentials, secret values, environment contents, and private service URLs.

The ingress evidence is emitted by `scripts/ops/staging-deployment-smoke.mjs` and covers API liveness/readiness, dashboard and overlay HTTP responses, object-storage readiness, Socket.IO WebSocket upgrade, and exact Twitch sign-in/integration callback configuration. The remote deployment gate separately requires healthy PostgreSQL, Redis, API, worker, dashboard, and overlay containers, successful object-storage initialization, and a running edge container before the public ingress checks run.

Routine image rollback is limited to presentation-only releases. Both the in-deploy rollback path and the post-ingress rollback step wait for API, worker, dashboard, and overlay to report `running:healthy`; a rollback is not reported as successful merely because Compose accepted the restart command. The workflow then reruns the full public ingress smoke test after a successful dedicated rollback, and the audit reports recovery as successful only when both the container rollback and the post-rollback ingress checks pass. If the in-deploy routine rollback is triggered inside the remote deployment command, its detailed result remains in that step log and the audit explicitly marks the result as not independently reported rather than claiming success.

High-risk releases do not automatically restore the previous image or database. If one fails, the audit marks operator recovery as required. Follow the backup/PITR and failed-release runbook, assess schema/data compatibility, restore only from a verified recovery point when authorized, and rerun the complete staging health probe before considering the environment recovered. Image rollback is not database rollback.

The artifacts are release evidence for the non-production staging workflow, not proof of a production release or authorization to deploy to the NAS. Actual SSH deployment, external DNS/ACME, real Twitch callback exchange, and volume restoration still require a separately provisioned disposable staging environment.
