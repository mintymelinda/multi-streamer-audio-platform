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
- `0026_notification_delivery_reliability.sql` adds recipient-scoped deduplication claims, five-minute grouping windows, linked email delivery status, and recipient/workspace-scoped access to idempotency metadata.
- `0026_notification_delivery_reliability.sql` adds recipient-scoped notification deduplication, five-minute grouping windows, linked email delivery status, and recipient-only status visibility.
- `0027_account_data_exports.sql` adds queued personal account exports, RLS-protected export payloads, worker-only generation, authenticated downloads, and seven-day expiry.
- `0028_user_appearance_preferences.sql` adds account-wide light/dark theme and accent-color preferences with self-only RLS, and grants the account-export worker scoped read access.
- `0029_overlay_scenes.sql` adds workspace-owned scene identities and hashed, independently revocable OBS access tokens with forced workspace RLS.
- `0030_overlay_scene_runtime.sql` adds the published-state snapshot column and migrator-owned, narrowly scoped token/active-scene lookup functions for the read-only overlay runtime.
- `0033_workspace_asset_library.sql` adds workspace-isolated image asset metadata, forced RLS, and a token-scoped runtime lookup for assets referenced by published scenes.
- `0034_starter_scene_default_layout.sql` backfills existing empty, unpublished starter scenes with the standard Now Playing component layout.
- `0035_overlay_scene_management.sql` adds audited scene rename/reorder/deletion, a one-time starter provisioning marker, and a centrally configurable platform-wide scene ceiling with a trigger-maintained global usage counter protected from runtime-role mutation.
- `0036_now_playing_starter_layout.sql` updates only untouched starter scenes to the agreed artwork-left, information-right layout geometry; customized scene drafts and published layouts are preserved.
- `0037_platform_administration.sql` adds platform owner/administrator assignments, function-scoped administrator permissions, final-owner protection, and append-only platform administration audit records. Bootstrap the first owner only after verifying the operator's Twitch numeric user ID; the migration deliberately does not infer or automatically appoint an owner.
- `0038_workspace_support_access.sql` adds read-only, reasoned support grants with a 5–240 minute expiry, owner-visible grant history and audit events, immediate revocation, append-only grant/read/revoke/diagnostic auditing, and separate technical diagnostics. Support and diagnostic reads use narrow SECURITY DEFINER functions plus additional SELECT-only RLS policies; the runtime role cannot directly read grant or audit tables.

The initial overlay scene safety ceiling is 1,000 across the entire platform. The platform runtime can read the configured value but cannot change it or mutate the usage counter. Until the platform settings controls are added to the platform-administration console, an operator changes it through the privileged database administration path, for example: `UPDATE platform_settings SET setting_value = '1500'::jsonb, updated_at = now() WHERE setting_key = 'overlay_scene_safety_ceiling';`.

New tenant-owned tables must follow the same pattern. Never put plaintext provider credentials in integration rows, audit details, outbox payloads, logs, or job messages.


## Optional email delivery

The optional notification email dispatcher uses the Resend email API. Configure the worker with `RESEND_API_KEY_FILE` pointing to a protected file containing the API key and `EMAIL_FROM` set to a verified sender identity. Email delivery remains disabled until both are present. This provider credential is independent of Twitch OAuth; the platform never requests Twitch email scope. Verification messages and opted-in notification messages are written to a restricted PostgreSQL outbox and retried with bounded exponential backoff (up to ten attempts). Notification emails link to their inbox record so the recipient can see pending, sent, or failed delivery status and attempt count. Outbox payloads are redacted after success or retry exhaustion, and terminal records are pruned after 30 days. Repeated notification producers can supply a recipient-scoped deduplication key; related events are grouped into aligned five-minute windows.

## Personal account data exports

Account exports are generated asynchronously by the worker and stored as JSON in PostgreSQL. The export contains only the signed-in user's account identity, own workspace membership records, invitations addressed to that Twitch identity, personal notification history, notification preferences, and account-wide appearance preferences. Workspace-owned content is reserved for the separate workspace export workflow. Session records, OAuth state, provider credentials, token hashes, email outbox contents, and other users' personal information are never included. Export status and payload access are protected by recipient RLS; downloads require the same authenticated account, are served with private no-store headers, and expire after seven days. The API limits requests to one per account per 24 hours, reuses active jobs, and the worker retries transient generation failures up to three attempts. Expired payloads are purged and terminal history is retained for 30 days.
