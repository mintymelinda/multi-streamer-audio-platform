# PostgreSQL schema migrations

Schema migrations are immutable, ordered SQL files named `NNNN_short_description.sql` (for example, `0001_create_identity_tables.sql`).

- Apply migrations with the dedicated `platform_migrator` role, never the runtime role.
- Never edit a migration after it has been applied to a shared environment; add a new forward migration instead.
- Keep migrations transactional where PostgreSQL supports it.
- Prefer expand/contract changes so application and worker versions can overlap safely during deployment.
- Include tenant ownership columns, RLS policies, forced RLS, indexes, and default privileges in the migration that creates tenant data.
- The application runtime role must not own tables and must not have `BYPASSRLS`.
- CI validates file naming/order and tests the local role-bootstrap SQL. Database-specific migration execution checks become active when the first migration is added.
