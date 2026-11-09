# PostgreSQL schema migrations

Schema migrations are immutable, ordered SQL files named `NNNN_short_description.sql`.
- Apply migrations with the dedicated `platform_migrator` role, never the runtime role.
- Never edit an applied migration; add a forward migration instead.
- Include tenant ownership columns, RLS policies, forced RLS, and indexes with each tenant table.
- The runtime role must not own protected tables or have `BYPASSRLS`.
- Authenticate the user and verify workspace membership before setting transaction-local `app.user_id` and `app.workspace_id`.
- CI applies migrations with the migrator and runs tenant-isolation tests with the restricted runtime role.

## Local checks

Start local services with `pnpm dev:infra`. CI is the canonical automated migration check.

## Initial migrations

- `0001_identity_workspaces_authorization.sql`: identity, workspaces, memberships, invitations, sessions, and RLS.
- `0002_integrations_and_outbox.sql`: tenant-scoped integrations and transactional outbox.
- `0008_twitch_reward_mappings.sql`: Twitch reward links and feature mappings.
- `0009_twitch_workspace_authorization.sql`: workspace broadcaster authorization.
- `0011_phase2_recovery_state.sql`: authorization pause/reconciliation and recovery state.
- `0012_outbox_operator_recovery.sql`: terminal outbox dispatch states and worker permissions.
- `0014_provider_instances.sql`: workspace-scoped provider identity, capabilities, and health.
- `0015_provider_credentials.sql`: encrypted provider credentials and lifecycle metadata.
- `0016_provider_output_assignments.sql`: explicit provider/player output ownership and unique active ownership per workspace/output, player, and provider instance.

New tenant-owned tables must follow the same RLS pattern. Never put plaintext credentials in logs, audit details, outbox payloads, or job messages.
