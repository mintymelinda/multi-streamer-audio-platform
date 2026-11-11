# Data retention classes and scheduled cleanup

Migration `0044_data_retention.sql` and the worker's daily retention cycle implement this policy. Cleanup is conservative: only terminal records are eligible, and each category is processed in batches of at most 5,000 rows.

| Data class | Retention | Behavior |
|---|---:|---|
| Workspace configuration and settings | Until workspace deletion | No age-based expiry; includes integrations, provider/output settings, scenes, and assets. |
| Active requests and logical queue entries | Until terminal transition or workspace deletion | Submitted, pending, held, approved, queued, resolving, ready, and playing requests are never removed due to age. |
| Request and request-state history | 14 days | Per-workspace setting; supported values 7, 14, 30, 90, 180, or 365 days. Applies only to terminal requests, measured from completion or final update. State history is removed by cascade with its request. |
| Temporary provider queue state and playback command operations | 30 days | Only terminal provider states and completed, failed, or reconciled playback operations expire. Pending, executing, and uncertain operations remain for recovery and duplicate-play prevention. |
| Expired playback leases | 1 day after expiry | Only already-expired leases are removed. |
| Processed EventSub deliveries and published outbox events | 30 days | Accepted, processing, failed, and unpublished/recoverable records remain. |
| User notification content | 90 days | Per-user choices: 30, 90, 180, or 365 days. Account and security notifications are exempt until account deletion. |
| Email outbox terminal records | 30 days | Sent and retry-exhausted records only; payloads are redacted by the dispatcher. |
| Personal account export payload | 7 days | Payload is cleared at expiry; terminal metadata remains 30 days from request. |
| Rights-holder reports, decisions, evidence, platform audit/security records | No automatic expiry in this phase | Legal, enforcement, and security retention requires separately reviewed policy. The routine job never purges these records. |

## Configuration

Workspace owners/admins configure request/playback history retention through `PATCH /workspaces/:workspaceId/requests/settings` using `historyRetentionDays`. The default is 14 days. Unsupported values are rejected by the API and database.

Notification retention remains a user-wide preference and is independent of workspace membership.

## Execution and safety

- The worker invokes `run_platform_retention()` at startup and then daily.
- The function is owned by the non-superuser `platform_migrator` role and exposed only through EXECUTE to `platform_worker`; the worker receives no direct cross-tenant DELETE grants.
- RLS maintenance policies apply only to the function owner. Ordinary runtime sessions cannot invoke the function.
- Cleanup uses bounded batches and returns per-class counts for operational logging, without logging user content or identifiers.
- Unresolved playback outcomes, active queue entries, recoverable deliveries, unpublished outbox records, workspace settings, and legal/security evidence are never age-pruned.
