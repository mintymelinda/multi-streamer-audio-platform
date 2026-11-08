# PostgreSQL schema migrations

Schema migrations are immutable, ordered SQL files named `NNNN_short_description.sql` (for example, `0001_create_identity_tables.sql`).

- Apply migrations with the dedicated `platform_migrator` role, never the runtime role.
- Never edit a migration after it has been applied to a shared environment; add a new forward migration instead.
- Keep migrations transactional where PostgreSQL supports it.
- Prefer expand/contract changes so application and worker versions can overlap safely during deployment.
- Include tenant ownership columns, RLS policies, forced RLS, indexes, and default privileges in the migration that creates tenant data.
- The application runtime role must not own tables and must not have `BYPASSRLS`.
- The migrator is a separate schema owner with no superuser or `BYPASSRLS` privilege.
- The application must authenticate the user and verify workspace membership before setting transaction-local `app.user_id` and `app.workspace_id`. RLS is an additional boundary, not a substitute for authorization.
- Use transaction-local settings only. Never use session-level `SET` for tenant context with pooled connections.
- CI applies every migration using the migrator role and executes tenant-isolation tests using the restricted runtime role.

## Local migration checks

Start the local services with `pnpm dev:infra`, then apply the role bootstrap and migrations using the local-only credentials from the Compose example. Do not reuse those credentials outside local development. The CI workflow is the canonical automated integration check.

## Initial migrations

- `0001_identity_workspaces_authorization.sql` establishes stable Twitch-ID accounts, explicit workspaces, one-owned-workspace enforcement, protected owner membership, team roles/invitations, server-side session records, OAuth state, append-only audit writes, and RLS policies.
- `0002_integrations_and_outbox.sql` establishes tenant-scoped provider integration records with encrypted credential-envelope columns, plus the transactional outbox table. Both tables use ENABLE and FORCE ROW LEVEL SECURITY and are inaccessible without verified user/workspace context.

New tenant-owned tables must follow the same pattern. Never put plaintext provider credentials in integration rows, audit details, outbox payloads, logs, or job messages.
