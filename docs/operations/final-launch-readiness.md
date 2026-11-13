# Final launch-readiness review

**Status: NOT READY FOR PUBLIC LAUNCH.** This checklist is the final gate for roadmap Phase 8 item 75. It records the current implementation evidence and the remaining operator, legal, infrastructure, and multi-instance acceptance work. A merged code change or passing CI run is not, by itself, a launch approval.

## Phase 3 — Provider playback and recovery

- [x] Durable provider playback sessions are promoted to main and bind completion to session identity and dispatch generation.
- [x] Provider-observed natural completion and retryable queue advancement are implemented.
- [x] Manual terminal recovery closes the active durable playback session so a stale monitor cannot later complete or advance it.
- [x] Phase 3 coordinator/recovery tests and coverage matrix updates are promoted to main.
- [ ] Complete the true two-process API/worker/provider recovery exercise under Phase 8, including uncertain outcomes and manual recovery after process restart.
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
- [ ] Add and pass browser-level E2E coverage for sign-in, workspace creation/selection, moderator invitations/revocation, request intake/moderation/queue, provider playback and recovery, overlay editor draft/publish, OBS snapshot/reconnect, export/deletion, and deletion-safe restore.
- [ ] Verify each relevant test against the actual non-production application and service topology, not only mocked HTTP servers or internal service methods.

### 69. Capacity and SLOs

- [x] A weighted HTTP workload runner reports throughput, error rate, timeouts, per-scenario counts, and latency percentiles with configurable error/p95 budgets.
- [x] A representative staging workload profile is supplied with placeholders for isolated test workspace, session, scene, and media values.
- [ ] Run baseline, expected peak, burst, and soak profiles against staging with representative tenant, overlay/WebSocket, Twitch event, queue, and provider activity.
- [ ] Capture API/worker CPU and memory, DB pool/lock/connection utilization, Redis queue depth/latency, object storage latency, WebSocket connections, provider failures/rate limits, and queue lag.
- [ ] Derive and approve SLOs, alert thresholds, safe concurrency limits, and capacity assumptions from measured results. No performance target is considered established by the example defaults.

### 70. Multi-instance correctness

- [x] The PostgreSQL lease upsert is verified using two independent database sessions; the test checks the live lease owner and fencing token.
- [ ] Run two API processes and two provider worker processes against shared PostgreSQL/Redis with actual playback/provider traffic.
- [ ] Verify duplicate BullMQ deliveries, scheduler overlap, worker crashes/restarts, expired lease reclaim, stale fencing-token rejection, and natural completion/queue advancement across process boundaries.
- [ ] Configure and verify the Socket.IO Redis adapter for cross-instance room/event fan-out. The current API bootstrap uses the default Socket.IO adapter, so cross-instance realtime fan-out is not yet proven.
- [ ] Verify workspace authorization, overlay reconnect/snapshot recovery, and no cross-tenant realtime leakage across API instances.

### 71. Non-production deployment

- [x] The isolated Compose smoke command is implemented for PostgreSQL, Redis, MinIO, object initialization, and cleanup under a unique Compose project.
- [ ] Run the Compose smoke command on a disposable non-production host and retain its output.
- [ ] Validate a complete application deployment, including API, worker, dashboard, overlay runtime, PostgreSQL, Redis, object storage, HTTPS reverse proxy, WebSocket upgrades, OAuth callbacks, and configured domain.
- [ ] Verify persistent-volume behavior and safe domain migration against the actual deployment manifest.

The current Compose stack does not define an API service or the complete hosted frontend/reverse-proxy deployment. The smoke command is infrastructure-only; it does not satisfy the complete deployment gate.

### 72. Operational readiness

- [x] Backup/recovery and release/rollback runbooks are documented.
- [x] Phase 8 verification guidance describes evidence requirements and known gaps.
- [ ] Establish and verify health dashboards, alert routing, on-call ownership, backup freshness alerts, WAL archiver alerts, and service/provider dependency alerts.
- [ ] Rehearse incident response, rights-holder reports, maintenance communications, provider outages, account/workspace recovery, and support access revocation.
- [ ] Review operator setup, streamer onboarding, moderator support, credential recovery, and deployment procedures with the people who will execute them.

The current API readiness endpoint checks PostgreSQL only. It does not yet assert Redis, object storage, worker, or provider readiness.

### 73. CI quality gates

- [x] The existing CI workflow runs dependency installation, database role/migration/isolation checks, type checking, migration naming checks, tests, and build; CodeQL runs separately.
- [x] The new tests are discovered by the existing test glob without workflow edits.
- [ ] Require green CI and CodeQL for the exact release candidate commit and retain the workflow-run evidence.
- [ ] Confirm no suppressed/ skipped release-critical test, unresolved security finding, or unreviewed migration remains.
- [ ] Keep formatting/lint policy aligned with the repository owner's explicit CI decision; do not silently introduce new CI gates in this launch checklist.

### 74. Audit, release health, and rollback

- [x] A release/rollback runbook covers immutable artifacts, forward-compatible migrations, application rollback, PITR recovery, deletion-ledger replay, and verification evidence.
- [ ] Perform a non-production release rehearsal with immutable versioned artifacts and record release/audit metadata.
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

**Launch decision:** [Not approved / Approved with documented exceptions]

**Release candidate commit:** [SHA]

**Review date:** [Date]

**Platform owner:** [Name]

**Evidence bundle:** [Links to CI, CodeQL, E2E, load reports, restore drills, rollback rehearsal, and legal approvals]
