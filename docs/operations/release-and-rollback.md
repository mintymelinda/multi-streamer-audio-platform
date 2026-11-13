# Release, migration, and rollback runbook

This runbook applies to non-production validation and the eventual hosted release process. It does not authorize a production deployment. The current Compose file is a development/infrastructure stack, not a complete application deployment manifest.

## Release preflight

Before any release candidate is promoted:

1. Identify the exact source commit and immutable API/worker/overlay artifacts. Record artifact digests and the intended previous known-good release. Do not rely on rebuilding a moving branch name as the rollback artifact.
2. Confirm CI and CodeQL are green for the exact commit. Review migration changes, provider capability changes, worker scheduling changes, and security-relevant diffs.
3. Confirm a recent successful PostgreSQL base backup, a complete recent WAL archive chain, a current object-storage snapshot, independently recoverable backup keys, and a current deletion-ledger export.
4. Verify the backup health monitor and alert routing. A current status marker alone does not prove the WAL chain is complete; the last successful PITR drill is the evidence for that chain.
5. Validate the release in an isolated non-production deployment with the same PostgreSQL major version, Redis behavior, object storage, reverse proxy/TLS, OAuth callbacks, and provider types planned for production.
6. Run the E2E journey, isolation tests, multi-instance tests, representative load profile, overlay checks, provider recovery tests, and a rollback rehearsal. Record actual results rather than assuming that a passing unit test implies a deployment gate passed.
7. Record the approver, maintenance/incident communications, expected impact, rollback decision owner, and the data-loss implications of any recovery choice.

Do not release while a required legal/privacy review, rights-use approval, unresolved backup recovery gap, cross-tenant isolation failure, or security finding remains open.

## Database migration policy

The database is authoritative. Treat migrations as forward-only unless a specific migration includes a separately reviewed and tested rollback.

- Use expand/contract migrations. First add nullable columns, tables, indexes, and compatibility paths; deploy code that can read old and new shapes; backfill in bounded and observable batches; then remove obsolete schema only in a later release after all old application/worker versions have been retired.
- Never assume that rolling application code back reverses a migration.
- Do not run an ad-hoc DROP, manual schema edit, or down migration during an incident without the database owner and a reviewed recovery plan.
- Capture the exact schema migration version and current database recovery point before a data-affecting release.
- Verify migrations from a clean database and upgrade from the previous supported schema using the dedicated migrator identity. Runtime/API/worker identities must not acquire migration privileges.

## Application rollback

When the new application/worker release is unhealthy but the database schema remains compatible with the previous release:

1. Stop or drain new traffic and pause actions that could compound data corruption or external side effects.
2. Preserve logs, release identifiers, health responses, migration state, provider status, queue/worker state, and relevant timestamps.
3. Restore the previous immutable API, worker, and overlay artifacts as a coordinated release. Do not roll back only one component when their contracts or migrations are incompatible.
4. Keep PostgreSQL, Redis, and object storage intact. Do not remove volumes, reinitialize services, or replay a database snapshot merely to roll back application code.
5. Confirm /health/live returns HTTP 200 and /health/ready returns HTTP 200 with PostgreSQL ready.
6. Confirm workers have resumed, outbox/EventSub processing is progressing, queues remain durable, and playback operations are not left in ambiguous states.
7. Test a controlled request/queue operation, a published overlay snapshot, a workspace boundary check, and the relevant provider path. Reconcile uncertain playback outcomes before retrying any command.
8. Record the cause, affected data/time range, any manual recovery, and the decision to resume normal traffic.

The readiness endpoint currently probes PostgreSQL only. A healthy response is not evidence that Redis, object storage, Twitch, Spotify, or optional Lyrion integrations are healthy.

## Database recovery and rollback

If the release has made the database incompatible or corrupted durable data, do not attempt to make the current database look older by deleting migration records or running reverse SQL without a tested rollback.

1. Stop API and worker writes. Preserve the failed database and diagnostics for investigation.
2. Select a known-good PostgreSQL base backup and a recovery target supported by the retained WAL archive. Restore to a new isolated data directory and verify the base backup/WAL chain.
3. Restore the matching object-storage snapshot to a new empty bucket when the incident affects object state.
4. Apply the schema migrations required by the selected application release.
5. Replay the newest independent deletion/revocation ledger export after restore and before restarting application services. The ledger key and artifact must be recovered independently of the database and backup set.
6. Recover integration credential KEKs and backup archive keys independently; they are separate key hierarchies.
7. Validate workspace isolation, account/workspace tombstones, memberships, provider credentials, queue/request states, overlay tokens, assets, worker recovery, and audit records.
8. Measure the data loss against the chosen recovery point and actual RPO. Obtain the required approval before cutting traffic over to the restored instance.

A database PITR restore can discard writes committed after its recovery target. Never describe it as a no-data-loss rollback. Confirm the target point and expected impact with the incident owner.

## Rollback verification record

For each release rehearsal or real rollback, record:

- Source/release commit and immutable artifact digests.
- Previous known-good release and schema migration version.
- Backup ID, object snapshot ID, deletion-ledger export ID, and recovery target timestamp, if applicable.
- Health/liveness results and database/Redis/object-storage probe outcomes.
- Workspace-isolation, authenticated request, queue, playback reconciliation, and overlay checks.
- Time traffic was stopped, time service was restored, and actual RPO/RTO.
- Any missing data, manual remediation, provider reauthorization, or follow-up action.
- Operator and approver names/roles.

## Local Compose infrastructure smoke test

For an isolated non-production machine, run:

    node scripts/ops/compose-infra-smoke.mjs

The script uses a unique Compose project name, starts only PostgreSQL, Redis, MinIO, and the object-storage initialization job, verifies PostgreSQL/Redis health and successful bucket initialization, then removes only that temporary project's containers and volumes. It intentionally does not start or validate the API because the current Compose file does not define an API service. It does not modify the Compose file or environment files.

Do not adapt this smoke command to a production project name or run it against volumes containing user data.
