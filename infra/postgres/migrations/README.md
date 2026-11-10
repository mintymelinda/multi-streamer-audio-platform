# PostgreSQL schema migrations

Schema migrations are immutable, ordered SQL files named `NNNN_short_description.sql` (for example, `0001_create_identity_tables.sql`).

- Apply migrations with the dedicated `platform_migrator` role, never the runtime role.
- Never edit a migration after it has been applied to a shared environment; add a new forward migration instead.
- Keep migrations transactional where PostgreSQL supports it.
- Prefer expand/contract changes so application and worker versions can overlap safely during deployment.
- Include tenant ownership columns, RLS policies, forced RLS, indexes, and default privileges in the migration that creates tenant data.
- The application runtime role must not own protected tables or have `BYPASSRLS`.
- The migrator is a separate schema owner with no superuser or `BYPASSRLS` privilege.
- The application must authenticate the user and verify workspace membership before setting transaction-local `app.user_id` and `app.workspace_id`. RLS is an additional boundary, not a substitute for application authorization.
- Use transaction-local settings only. Never use session-level `SET` for tenant context with pooled connections.
- CI applies every migration using the migrator role and executes tenant-isolation tests using the restricted runtime role.

## Local migration checks

Start the local services with `pnpm dev:infra`, then apply the role bootstrap and migrations using the local-only credentials from the Compose example. Do not reuse those credentials outside local development. The CI workflow is the canonical automated integration check.

## Initial migrations

- `0001_identity_workspaces_authorization.sql` establishes stable Twitch-ID accounts, explicit workspaces, one-owned-workspace enforcement, protected owner membership, team roles/invitations, server-side session records, OAuth state, append-only audit writes, and RLS policies.
- `0002_integrations_and_outbox.sql` establishes tenant-scoped provider integration records with encrypted credential-envelope columns, plus the transactional outbox table. Both tables use ENABLE and FORCE ROW LEVEL SECURITY and are inaccessible without verified user/workspace context.
- `0008_twitch_reward_mappings.sql` establishes tenant-scoped Twitch reward links, one explicit feature handler per reward, validated feature settings, synchronization state, and workspace RLS. Manually linked rewards remain pending verification until confirmed through Twitch.
- `0009_twitch_workspace_authorization.sql` distinguishes platform sign-in OAuth state from workspace broadcaster authorization and binds each workspace grant to the initiating user and workspace.
- `0011_phase2_recovery_state.sql` persists Twitch authorization pause/reconciliation state and operator-dismissed EventSub delivery outcomes.
- `0012_outbox_operator_recovery.sql` persists terminal outbox dispatch states and grants the restricted worker only the additional dispatch-state update permission.
- `0014_provider_instances.sql` establishes stable workspace-scoped provider identity, versioned adapter contracts, declared capabilities, and non-secret connection health metadata.
- `0015_provider_credentials.sql` establishes workspace-scoped envelope-encrypted provider credentials, granted-scope metadata, authorization expiry, and revocation lifecycle state.
- `0016_provider_output_assignments.sql` establishes explicit workspace-scoped provider/player output ownership, with unique active ownership per workspace/output, player, and provider instance.
- `0017_playback_coordination.sql` establishes workspace playback policy, database-backed expiring output leases with fencing generations, and durable idempotent playback operation records for uncertain-outcome recovery.
- `0018_provider_execution_queues.sql` establishes tenant-scoped provider execution state and due-work indexes while preserving PostgreSQL request lifecycle and logical queue ordering as separate authorities.
- `0019_provider_recovery_policies.sql` establishes owner/admin-configurable retry/failover policy and tenant-scoped manual recovery audit records with forced RLS.
- `0021_rights_compliance.sql` establishes versioned rights attestations, rights-holder report intake/review history, content blocks, provider-path restrictions, and forced tenant RLS.
- `0022_workspace_onboarding.sql` establishes durable, resumable workspace onboarding progress with workspace-scoped RLS.
- `0023_user_notifications.sql` establishes recipient-scoped, cross-workspace notifications with read state, grouping support, and recipient-only RLS that preserves addressed history after workspace access is revoked.
- `0024_user_notification_preferences.sql` establishes self-managed category preferences and per-user notification retention (90-day default; 30/90/180/365-day choices), with mandatory account/security notifications exempt from category suppression and expiry.
- `0025_optional_email_notifications.sql` establishes separately verified email addresses, per-category/priority opt-in settings, and a restricted durable email outbox for verification and notification delivery.

New tenant-owned tables must follow the same pattern. Never put plaintext provider credentials in integration rows, audit details, outbox payloads, logs, or job messages.
