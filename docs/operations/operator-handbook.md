# Operator handbook

This handbook is the day-to-day operating guide for the hosted Multi-Streamer Audio Platform. It supplements [Phase 8 verification and capacity testing](./phase8-verification.md) with repeatable operator, support, incident, and recovery procedures.

## Operating boundaries

- Use a disposable non-production environment for staging drills, load tests, and recovery exercises.
- Do not run staging scripts against production or the operator's NAS deployment. This roadmap work does not authorize production deployment or NAS operations.
- PostgreSQL is the source of truth for accounts, workspaces, requests, queue state, credentials metadata, playback operations, and audit history. Redis is coordination/delivery infrastructure, not durable business storage.
- Keep PostgreSQL and Redis private. Only the HTTPS edge publishes public ports.
- Never request or accept a user's password, Twitch OAuth code/state, session cookie, scene bearer token, provider access token, encryption key, or database credential in a support ticket or chat.
- Do not inspect workspace content as a routine diagnostic. Any future support-access feature must be temporary, scoped, reasoned, visible to the workspace owner, revocable, and audited as required by the architecture.
- A green health check is not proof that playback, OAuth, WebSockets, backups, or every provider is working. Use the specific acceptance procedure for the operation being verified.

## Service inventory and ownership

| Service | Responsibility | Durable state / dependency | First checks |
|---|---|---|---|
| API | Authentication, workspace APIs, request intake, authorization, health endpoints | PostgreSQL; Redis for cross-instance Socket.IO | `/health/live`, `/health/ready`, API logs |
| Worker | Event processing, outbox delivery, provider execution, retention and export jobs | PostgreSQL and Redis/BullMQ | Container state, worker logs, queue age/failure counts |
| Dashboard | Streamer and moderator browser application | API | HTTPS page, browser network errors |
| Overlay | OBS browser-source runtime | API snapshot and Socket.IO | HTTPS page, overlay snapshot, reconnect |
| PostgreSQL | Authoritative application data | Named volume; encrypted backups and WAL/PITR | Container health, connection availability, migration status |
| Redis | BullMQ and Socket.IO coordination | Named volume for configured persistence; rebuildable from durable state where applicable | Container health, latency, queue depth |
| Object storage | Workspace assets and exports | Named volume; independent object backup | MinIO readiness, bucket access, asset URL |
| Caddy edge | Public HTTPS and WebSocket reverse proxy | Persistent certificate/config volumes | Container health, certificate state, public ingress |

The API's current readiness endpoint checks PostgreSQL only. It does not assert worker health, Redis/BullMQ health, object-storage readiness, provider availability, or successful delivery of background jobs. Do not interpret `/health/ready` as a complete service-health dashboard.

## Routine operator checks

### Before a staging session

1. Confirm the target is the disposable staging environment and that the maintenance window is acceptable.
2. Confirm the staging environment file and secret files exist with restrictive permissions. Never print them to a terminal transcript.
3. Confirm all required containers are running and their configured health checks are healthy.
4. Confirm API liveness and readiness, dashboard and overlay HTTPS responses, asset-store readiness, and the public Socket.IO WebSocket handshake.
5. Confirm Twitch callback URLs in the provider console exactly match the two configured HTTPS callback URLs.
6. Record the deployed commit/image identity, time, operator, and intended test.

### After a staging session

1. Remove disposable test requests, users/workspaces, assets, and OAuth test registrations when no longer needed.
2. Confirm no probe records or temporary objects remain from volume/recovery drills.
3. Confirm no unexpected container restarts, failed jobs, stuck queue entries, or unresolved playback operations remain.
4. Save sanitized test output and relevant commit/run identifiers. Do not archive credentials, authorization URLs, request headers, or bearer tokens.
5. Record failures as follow-up issues with the affected service, first observed time, impact, and reproduction steps.

### Useful read-only commands

Run from the repository root and supply the private staging environment file explicitly:

```sh
docker compose --env-file infra/compose/.env.staging -f infra/compose/docker-compose.staging.yml ps
docker compose --env-file infra/compose/.env.staging -f infra/compose/docker-compose.staging.yml logs --since=15m api worker dashboard overlay
docker compose --env-file infra/compose/.env.staging -f infra/compose/docker-compose.staging.yml logs --since=15m postgres redis object-storage
docker compose --env-file infra/compose/.env.staging -f infra/compose/docker-compose.edge.yml ps
```

Treat logs as sensitive operational data. Share only a sanitized excerpt, preserving correlation/request IDs while removing tokens, cookies, OAuth state, provider credentials, personal data, and signed URLs.

## Incident severity and response

Use impact, not the number of error messages, to set severity.

| Severity | Examples | Immediate response |
|---|---|---|
| SEV-1 — security or platform-wide outage | Suspected cross-workspace data exposure; leaked signing/encryption key; database corruption; all users unable to authenticate or use the service | Stop the affected path or public ingress if needed, preserve evidence, revoke exposed credentials, notify the platform owner, and begin the relevant recovery procedure |
| SEV-2 — major service degradation | API or database unavailable; broad request intake/playback failure; worker backlog growing without recovery; widespread overlay disconnect | Stabilize dependencies, prevent duplicate or unsafe playback actions, communicate impact, and track recovery until service is verified |
| SEV-3 — isolated feature/workspace issue | One provider disconnected; one workspace cannot publish an overlay; a single export or notification is delayed | Confirm workspace scope and provider status, use a safe retry/reconnect path, and communicate directly with the affected user |
| SEV-4 — question or cosmetic defect | Setup guidance, non-blocking UI issue, or documentation correction | Record and route through normal support; no emergency changes |

For every incident:

1. Assign one incident lead. Keep one timeline in UTC with detection, decisions, actions, and verification.
2. State the known impact and unknowns. Do not speculate about data loss or security exposure.
3. Prefer reversible containment over broad destructive changes.
4. Preserve relevant logs and sanitized diagnostic output before restarting or deleting resources.
5. Make one change at a time and record the exact command/commit.
6. Verify recovery from the affected user's perspective and with service-level checks.
7. Close with cause, impact window, recovery evidence, follow-up actions, and any required user communication.

## Incident runbooks

### API or database unavailable

1. Check the API container state and recent API logs; compare `/health/live` and `/health/ready`.
2. Check PostgreSQL container health and whether it accepts a local readiness query. Do not expose the database port publicly.
3. If PostgreSQL is unavailable, stop repeated API restarts that could obscure the original failure. Preserve database logs and volume identity.
4. Check disk capacity and recent migration/backup activity before attempting repair.
5. Do not run migrations manually against an unknown schema state. Confirm the last applied migration and use the repository migration procedure.
6. Restore service only after database readiness returns and API readiness is 200. Then verify sign-in, workspace-scoped reads, and request intake in staging.

A liveness response only means the API process is alive. A readiness failure currently identifies PostgreSQL as unavailable; it does not diagnose the underlying database cause.

### Redis or background-job backlog

1. Check Redis availability, memory/eviction signals, persistence state, BullMQ waiting/active/failed counts, and oldest-job age.
2. Determine whether the issue affects Socket.IO fan-out, background jobs, or both.
3. Do not flush Redis or delete BullMQ keys as a recovery shortcut. PostgreSQL remains authoritative, but queue contents may represent pending delivery work.
4. Preserve failed-job metadata and representative sanitized errors. Confirm idempotency/retry behavior before retrying jobs in bulk.
5. After Redis recovery, verify cross-instance Socket.IO delivery and that outbox/provider work resumes without duplicate side effects.

### Object storage or asset delivery failure

1. Check MinIO readiness, container logs, free disk, bucket existence, and the public asset hostname through Caddy.
2. Separate service availability from authorization failures: a healthy MinIO endpoint does not prove workspace asset permissions or signed URL correctness.
3. Do not make private buckets public as a workaround.
4. Verify a disposable upload, authorized read, and deletion using a staging workspace.
5. Confirm asset delivery and dashboard/overlay behavior before closing the incident.

### Twitch OAuth or callback failure

1. Confirm the public API hostname resolves to the intended edge and has a valid HTTPS certificate.
2. Compare the configured broadcaster callback and integration callback character-for-character with the Twitch application registration.
3. Check the API's redirect response and sanitized error logs; never paste OAuth state, authorization codes, or full callback URLs containing query parameters into a ticket.
4. Do not change session signing or integration encryption keys to troubleshoot a callback mismatch.
5. Verify the sign-in redirect in staging. A redirect check is not proof that Twitch will complete authorization or that a provider token can be exchanged.

### Playback stuck, duplicated, or uncertain

1. Stop issuing repeated play/skip commands until the durable operation and provider output state are understood.
2. Identify the workspace, request, provider instance, assigned output, playback session, operation ID, and dispatch generation from authorized diagnostics.
3. Check whether an operation is pending, executing, completed, failed, or awaiting reconciliation. Preserve the current lease/fencing information.
4. Use the supported manual recovery action only after the provider's actual state is known. Do not mark a request completed or replay a start merely to clear a stuck UI.
5. Verify one provider start per intended output, correct request lifecycle state, and queue advancement before resuming normal use.

### Suspected cross-workspace access or credential exposure

1. Treat the event as SEV-1. Restrict or disable the affected endpoint, integration, scene token, or provider path while preserving evidence.
2. Record affected workspace/user identifiers only in the restricted incident record. Do not copy private content into general support channels.
3. Revoke the exposed scene token or provider authorization using the supported control. If a master encryption/signing key may be exposed, involve the platform owner and follow a planned rotation/recovery procedure; do not improvise key replacement.
4. Review audit events, request IDs, access logs, and affected deployment commits for the incident window.
5. Assess whether another workspace or user could have been affected. Notify affected users as required by the approved incident/privacy process.
6. Re-enable the path only after a targeted tenant-isolation regression test and independent review of the fix.

## Backup and recovery procedure

Backup restoration is a controlled operation, not a routine container restart.

1. Declare an incident and identify the recovery point and expected data-loss window. Record the best available RPO/RTO estimate; do not promise a target that has not been measured.
2. Locate the encrypted PostgreSQL backup/WAL and object-storage snapshot set, plus the independently stored matching encryption-key ring. A backup without its required key is not a recoverable backup.
3. Restore into an isolated recovery environment first. Never overwrite the only surviving database or object store during investigation.
4. Follow the backup runbook for integrity verification, PostgreSQL base restore/PITR, object restore, and key loading. Do not invent a new key or silently skip failed integrity checks.
5. Replay the deletion ledger/tombstones after restoring ordinary backups so deleted accounts/workspaces, revoked access, and credentials are not resurrected.
6. Run migrations only when the recovery procedure calls for them and the restored schema/version is understood.
7. Verify database integrity, tenant RLS, workspace membership, scene-token revocation, credential state, object references, queue/request state, and API/worker health.
8. Have the incident lead approve the cutover. Preserve the original recovery artifacts until the recovery is accepted.
9. Record actual restore duration, recovered point, missing data, verification results, and follow-up improvements.

A successful archive creation or CI restore test is not a completed disaster-recovery drill. Off-site storage, independent key recovery, real PITR, deletion-ledger replay, and measured recovery objectives must be verified in a disposable recovery environment.

## Streamer onboarding checklist

Use this as a support checklist; it is not a substitute for the product's in-app onboarding flow.

1. The streamer signs in with Twitch. Basic sign-in creates an account, not a workspace.
2. The streamer explicitly creates their workspace and connects the intended broadcaster identity during setup.
3. Confirm the streamer understands that loss/revocation of broadcaster authorization can pause workspace activity until authorization is restored.
4. Invite moderators by their Twitch identity and assign the least-privileged appropriate role. Invitations are workspace-specific; native Twitch moderator status alone does not grant platform access.
5. Connect only the providers the streamer intends to use. Explain provider-specific capabilities and limitations before enabling playback.
6. Assign the intended provider/player output and confirm no other active integration is competing for that output.
7. Configure moderation, request rules, queue limits, and reward mappings; test with a disposable request before announcing availability.
8. Create or review the starter overlay scene, publish it, and add the scene URL as an OBS Browser Source. Treat the scene URL as a bearer credential and do not share it publicly.
9. Confirm the overlay reconnects and displays the latest published state after a browser-source refresh.
10. Explain how to disconnect a provider while retaining harmless settings versus disconnecting and removing integration data.

## Support intake and access boundaries

Collect only what is needed to reproduce the issue:

- approximate UTC timestamp and timezone;
- affected feature and whether the issue is isolated to one workspace or multiple;
- browser/OBS version and operating system when relevant;
- sanitized error text and request/correlation ID;
- steps to reproduce and expected versus actual behavior;
- whether the issue began after a known configuration or release change.

Never request passwords, OAuth codes/state, cookies, scene URLs/tokens, provider tokens, encryption keys, or raw database URLs. Ask the user to revoke any secret they have already posted.

Support staff should begin with technical diagnostics and user-provided evidence. Do not request screenshots or exports that expose unrelated workspace/member data. Access to workspace content is not implied by support duties; it requires the separately specified temporary, reasoned, scoped, visible, revocable, and audited support-access mechanism.

## Communications templates

### Service incident

> We are investigating an issue affecting [service/feature] beginning around [time UTC]. The current known impact is [confirmed impact]. We are working to restore service and will provide another update by [time UTC]. Please do not repeatedly retry actions that may create duplicate requests or playback commands.

### Recovery completed

> Service has recovered as of [time UTC]. We verified [specific checks]. The incident affected [confirmed scope] between [start] and [end]. We are continuing to review the cause and will share any user action needed.

### Workspace-specific support request

> To investigate, please provide the approximate time (including timezone), the affected feature, the steps to reproduce, and any sanitized request ID or error message. Do not send passwords, OAuth links/codes, cookies, scene URLs, provider tokens, or other credentials.

## Change and recovery records

For each operator action with user impact, record:

- incident/change identifier and severity;
- operator and approver;
- UTC start/end time;
- affected services and confirmed user/workspace impact;
- deployment commit/image digest and migration state;
- commands/actions taken (excluding secret values);
- backup/recovery artifact identifiers, without encryption keys;
- verification evidence and remaining risks;
- follow-up issue owners and due dates.

Keep this record access-controlled and retain it according to the platform's approved security/audit retention policy.
