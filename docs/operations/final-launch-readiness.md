# Final launch-readiness review

**Status: NOT READY FOR PUBLIC LAUNCH.** This checklist is the final gate for roadmap Phase 8 item 75. It records the current implementation evidence and the remaining operator, legal, infrastructure, and multi-instance acceptance work. A merged code change or passing CI run is not, by itself, a launch approval.

## Decision 91 — first-release feature coverage

The repository contains implementation and automated tests across the agreed first-release scope. This is an evidence index, not a declaration that every feature has passed release acceptance. Most automated tests use deterministic fixtures; operator/provider/legal acceptance remains separate.

| First-release area | Repository evidence | Remaining launch verification |
|---|---|---|
| Twitch identity, sessions, workspaces, membership, roles, and RLS | Identity/workspace/team modules; migrations 0001 and later authorization migrations; API, workspace-permission, team, and tenant-isolation tests; authenticated browser test seeds a server-side session and verifies workspace isolation and invitation/revocation | Exercise the real Twitch OAuth authorization-code exchange and identity validation; verify production callback registration, session revocation, and workspace selection with real accounts |
| Requests, moderation, queue policy, EventSub, rewards, and recovery | Requests/queue/EventSub/reward/recovery modules; request-state, queue-ordering, EventSub signature/routing, recovery, and PostgreSQL isolation tests | Complete browser-level request submission through moderation, queue ordering, provider execution, and recovery; verify real Twitch EventSub subscription delivery and reconciliation in staging |
| Provider adapters, routing, output assignment, and playback | Provider contracts/instances/credentials/routing/output assignment/execution queue/Playback Coordinator; Phase 3 coverage matrix and provider integration tests | YouTube/Invidious currently provides search/metadata only and direct playback is disabled; Spotify catalog/Connect control does not provide broadcast audio and playback capabilities remain false; validate optional Lyrion against an operator-controlled device and complete provider/legal approvals before enabling any path |
| Streamer dashboard, onboarding, team, notifications, and preferences | Dashboard routes and API/worker modules for onboarding, team, notifications, email dispatch, and user preferences; corresponding API/worker tests | Verify complete user journeys and real email delivery/configuration in staging; confirm all notification categories, retention, and cross-workspace behavior against real users |
| OBS scenes, editor, assets, and overlay runtime | Scene management/editor, published runtime, bearer-token handling, asset library, migrations, and API tests; authenticated browser E2E verifies starter scene, draft/publish isolation, token revocation, overlay snapshot, and reconnect recovery | Verify the full editor/component interactions and actual OBS browser-source rendering; test uploads and asset recovery against the deployed object-storage service |
| Platform administration, support, restrictions, status, maintenance, and rights operations | Platform-admin/support/status/maintenance/compliance modules, migrations, dashboard routes, and authorization/workflow tests | Rehearse operator workflows with appointed administrators; verify public status/incident communications, rights-holder intake, escalation, support-access revocation, and account/workspace restriction procedures |
| Export, deletion, retention, and recovery safeguards | Account/workspace export and deletion services, worker export, retention jobs, deletion ledger, migrations, SQL isolation tests, and operator runbooks | Complete independent-key backup restore, real PostgreSQL PITR, object restore, newest deletion-ledger replay, and measured RPO/RTO drills |
| Appearance and hosted deployment foundations | User-level appearance preference service/UI/tests; separate dashboard and overlay apps; staging application Compose plus separate Caddy edge Compose | Verify deployed appearance persistence and the complete non-production topology, public DNS/TLS, callbacks, WebSockets, assets, and persistent volumes on a disposable staging host |

**Scope rule:** Decision 91 remains the first-release target. Missing release evidence is not permission to remove a feature from scope or to treat a mocked/fixture test as provider or operational approval.

## Phase 3 — Provider playback and recovery

- [x] Durable provider playback sessions bind completion to session identity and dispatch generation on the reviewed stacked release branch.
- [x] Provider-observed natural completion and retryable queue advancement are implemented.
- [x] Manual terminal recovery closes the active durable playback session so a stale monitor cannot later complete or advance it.
- [x] Phase 3 coordinator/recovery tests and coverage matrix updates are present on the reviewed stacked release branch.
- [x] API coordinator restart after a provider accepted a play command but before the API received its response is covered by a multi-process test: the durable operation remains uncertain, the same idempotency key does not replay play, and a different command is blocked while the outcome is unresolved.
- [ ] Complete provider-worker crash/stalled-job recovery, scheduler overlap, expired-lease reclaim, stale-fencing-token rejection, and manual recovery after restart; the current restart fixture uses deterministic HTTP providers, not live hardware.
- [ ] Complete the rights/use approvals and provider assessments required for each enabled provider before public use.

## Phase 7 — Backups, privacy, and legal materials

### Backups and recovery (roadmap items 65–66)

- [x] Streaming AES-256-GCM backup archive format, versioned key ring, authenticated artifact context, integrity verification, and S3-compatible storage transport are implemented in the backup PR.
- [x] PostgreSQL base backup, WAL archive/restore, object snapshot/restore, immutable artifact handling, and health marker commands are implemented.
- [x] Operational backup/recovery documentation includes independent key recovery, storage separation, provisional RPO/RTO, monitoring, retention boundaries, restore order, and drill procedures.
- [ ] Provision the production/offsite backup bucket, retention/Object Lock policy, least-privilege credentials, protected key ring, and independent encrypted key recovery copy.
- [ ] Enable PostgreSQL WAL archiving through the managed PostgreSQL configuration process and verify the archiver is continuously successful.
- [ ] Run a real PostgreSQL PITR recovery to a timestamp using a complete retained WAL chain.
- [ ] Restore an object snapshot into a separate empty bucket and verify object bytes, content types, key inventory, and any application-required metadata not currently represented by the manifest.
- [ ] Replay the newest independent deletion ledger after restore and before services restart.
- [ ] Record measured database/object RPO and full-service RTO. The 15-minute database, 24-hour object, and 4-hour full-recovery objectives in the runbook are provisional and not measured guarantees.
- [ ] Establish and verify a lifecycle policy that retains every WAL segment needed by every retained base backup. The runner intentionally does not prune archives.

The implementation is present, but these items remain open until a real independent-key and deletion-safe restore drill passes.

### Privacy, retention, and terms (roadmap item 67)

- [x] A product-specific Terms of Service draft, Privacy Policy draft, and publication review checklist are available in the stacked legal documentation PR.
- [ ] Confirm the Operator's legal identity, entity form, operating jurisdictions, contact details, age restrictions, and complaint/request intake process.
- [ ] Verify the deployed data inventory, cookies, analytics/logging, provider scopes, hosting/backup regions, subprocessors, onward transfers, and actual retention behavior.
- [ ] Obtain qualified legal and privacy review of terms, privacy disclosures, rights-use requirements, provider restrictions, consumer-law requirements, and operational procedures.
- [ ] Complete the approval record and publish approved policy versions before public registration.

The drafts are not legal advice and are not approved for publication. Do not treat item 67 as complete until the review and operational facts are confirmed.

## Phase 8 — Verification, capacity, deployment, and release

### 68. Test coverage

- [x] Existing unit, API integration, database isolation, provider recovery, overlay, export/deletion, and backup tooling tests run through the repository's existing test command.
- [x] A two-independent-PostgreSQL-session lease contention test is added and included through the existing scripts test glob.
- [x] PostgreSQL readiness behavior has unit coverage.
- [x] CI builds and exercises the production dashboard/overlay in Playwright, including sign-in boundary, authenticated workspace creation and isolation, moderator invitation/acceptance/revocation, starter scene creation, draft/publish isolation, bearer-token security, overlay snapshot/reconnect, and session/CSRF revocation.
- [x] Browser E2E covers request submission, moderation approval, queue ordering, provider-fixture execution, and the resulting playback state, in addition to authenticated workspace/overlay flows.
- [ ] Exercise the real Twitch OAuth authorization-code exchange; the browser test seeds a server-side session and does not contact Twitch OAuth.
- [ ] Extend browser E2E to cover export/deletion and deletion-safe restore; those currently have service/worker/database tests but not the full browser journey.
- [ ] Verify each relevant test against the actual non-production application and service topology, not only mocked HTTP servers or internal service methods.

### 69. Capacity and SLOs

- [x] A weighted HTTP workload runner reports throughput, error rate, timeouts, per-scenario counts, and latency percentiles with configurable error/p95 budgets.
- [x] A representative staging workload profile is supplied with placeholders for isolated test workspace, session, scene, and media values.
- [ ] Run baseline, expected peak, burst, and soak profiles against staging with representative tenant, overlay/WebSocket, Twitch event, queue, and provider activity.
- [ ] Capture API/worker CPU and memory, DB pool/lock/connection utilization, Redis queue depth/latency, object storage latency, WebSocket connections, provider failures/rate limits, and queue lag.
- [ ] Derive and approve SLOs, alert thresholds, safe concurrency limits, and capacity assumptions from measured results. No performance target is considered established by the example defaults.

### 70. Multi-instance correctness

- [x] The PostgreSQL lease upsert is verified using two independent database sessions; the test checks the live lease owner and fencing token.
- [x] Two independent API coordinator processes run against shared PostgreSQL/Redis with the production Redis Socket.IO adapter; real WebSocket clients verify cross-instance room broadcast and outbox fan-out, while duplicate play commands issue one provider start.
- [x] Two independent BullMQ provider consumers share PostgreSQL/Redis and use the live API handoff, Playback Coordinator, Invidious resolver, and Lyrion adapter with deterministic HTTP fixtures; five workspaces reach `playing` without duplicate handoffs/starts.
- [x] API coordinator process restart with an uncertain provider outcome is tested across two real API processes sharing PostgreSQL/Redis; recovery does not replay the ambiguous play command and blocks conflicting commands.
- [ ] Complete provider-worker crash/stalled-job recovery, scheduler overlap, expired-lease reclaim, stale-fencing-token rejection, and natural-completion/queue-advance tests across process boundaries; current fixtures do not exercise live provider hardware.
- [ ] Verify cross-tenant realtime isolation and the complete overlay reconnect/missed-event behavior across independently deployed API instances.

### 71. Non-production deployment

- [x] The isolated local Compose smoke command validates PostgreSQL, Redis, MinIO, object initialization, and cleanup under a unique Compose project.
- [x] A separate staging application Compose definition includes PostgreSQL, Redis, object storage, migrations, API, worker, dashboard, and overlay; a separate Caddy edge Compose definition provides the HTTPS reverse proxy. CI validates the Compose models and Caddy configuration.
- [ ] Run the infrastructure smoke and complete staging application/edge deployment on a disposable non-production host; retain health, ingress, WebSocket, OAuth-callback, and volume-restart evidence.
- [ ] Verify persistent-volume behavior and safe domain migration against the deployed manifests and real DNS/TLS.

The local development Compose file remains infrastructure-only. The full staging manifests now exist, but static validation is not a substitute for a real non-production deployment rehearsal.

### 72. Operational readiness

- [x] Backup/recovery and release/rollback runbooks are documented.
- [x] Phase 8 verification guidance describes evidence requirements and known gaps.
- [ ] Establish and verify health dashboards, alert routing, on-call ownership, backup freshness alerts, WAL archiver alerts, and service/provider dependency alerts.
- [ ] Rehearse incident response, rights-holder reports, maintenance communications, provider outages, account/workspace recovery, and support access revocation.
- [ ] Review operator setup, streamer onboarding, moderator support, credential recovery, and deployment procedures with the people who will execute them.

The API `/health/ready` endpoint currently checks PostgreSQL only. The worker readiness endpoint checks PostgreSQL and Redis, and production API bootstrap requires `REDIS_URL` for the Socket.IO Redis adapter; API readiness still does not assert object storage, worker, or provider readiness. Health endpoints are not yet a complete dependency dashboard or alerting system.

### 73. CI quality gates

- [x] The existing CI workflow runs dependency installation, database role/migration/isolation checks, type checking, migration naming checks, tests, and build; CodeQL runs separately.
- [x] The new tests are discovered by the existing test glob without workflow edits.
- [x] CI and CodeQL both pass on Phase 8 integration commit `cdd01df3517d02f5aa4cb29a6b832c9b04193c00`; CI run [#43636257506](https://github.com/mintymelinda/multi-streamer-audio-platform/actions/runs/43636257506) and CodeQL run [#43636257385](https://github.com/mintymelinda/multi-streamer-audio-platform/actions/runs/43636257385) are retained in GitHub Actions.
- [ ] Re-run both checks for any later release-candidate code change and retain the exact final candidate evidence.
- [ ] Confirm no suppressed/ skipped release-critical test, unresolved security finding, or unreviewed migration remains.
- [ ] Keep formatting/lint policy aligned with the repository owner's explicit CI decision; do not silently introduce new CI gates in this launch checklist.

### 74. Audit, release health, and rollback

- [x] A release/rollback runbook covers immutable artifacts, forward-compatible migrations, application rollback, PITR recovery, deletion-ledger replay, and verification evidence.
- [x] The staging workflow emits a sanitized machine-readable `release-audit.json` for successful and failed deployment attempts, retains it with ingress evidence as a 90-day run artifact, and summarizes build/deploy/health/rollback outcomes. Routine rollback verifies restored container health and reruns public ingress checks before reporting recovery.
- [ ] Perform a non-production release rehearsal with immutable versioned artifacts and retain the audit artifact and job summary as evidence.
- [ ] Perform an application rollback without restoring database state and prove the previous app/worker version remains schema-compatible.
- [ ] Perform a database/PITR recovery rehearsal and record the expected data-loss window, measured RPO/RTO, deletion-ledger replay, and post-restore checks.
- [ ] Verify health checks, provider recovery, queue state, overlay access, incident notices, and audit evidence before traffic resumes.

### 75. Final decision

- [ ] All Decision 91 first-release capabilities are verified in the actual release candidate.
- [ ] Every Phase 3 rights/provider approval and qualified legal review is recorded.
- [ ] Phase 7 independent-key backup restore, object restore, WAL/PITR, deletion-safe replay, privacy, and retention gates are complete.
- [ ] Phase 8 browser E2E, load/SLO, API/worker/Socket.IO multi-instance, complete non-production deployment, incident runbooks, and rollback gates are complete.
- [ ] Outstanding defects, exceptions, and operational risks have named owners and written acceptance from the platform owner.
- [ ] Platform owner has explicitly approved launch.

**Launch decision: NOT APPROVED.** The implementation has substantial automated coverage, but the release-blocking operator, legal, provider, deployment, capacity, restore, and end-to-end evidence above is not complete. No production or NAS deployment is authorized by this review.

**Reviewed repository commit:** `cdd01df3517d02f5aa4cb29a6b832c9b04193c00` (Phase 8 integration branch after item 74 release-audit work and item 70 API restart-recovery coverage).

**Review date:** 2026-11-14

**Platform owner approval:** Not recorded.

**Evidence bundle:** CI and CodeQL must be linked for the exact eventual release candidate; retain browser E2E, load/SLO, staging deployment/ingress, rollback, independent-key restore/PITR, deletion-ledger replay, and legal/provider approval evidence here before reconsidering launch.
