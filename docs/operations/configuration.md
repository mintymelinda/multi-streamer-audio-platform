# Configuration and secret-loading policy

## Configuration categories

**Database-backed application configuration**

- Workspace settings, provider preferences, queue limits, moderation behavior, playback policy, overlay layout, notification preferences, and user appearance settings.
- These values are mutable product state and must not require container recreation or environment-file edits.

**Process and infrastructure configuration**

- Bind addresses and ports.
- Database, Redis, and object-storage connection endpoints.
- Runtime identity and deployment-specific service wiring.
- Secret-file paths or secret-provider references.
- Feature-independent operational limits needed to safely start a process.

**Secrets**

- Encryption key material, database passwords, OAuth client secrets, and provider credentials.
- Production secrets are injected through protected deployment secret facilities or mounted secret files. Never commit them, print them, or pass them to browser clients.

## Loading rules

- Validate required bootstrap configuration at process startup and fail with a redacted, actionable error.
- Parse configuration once into typed immutable runtime configuration.
- Do not use environment variables as a mutable settings database.
- Keep local-only examples visibly marked and never reuse their values in production.
- Document every new process-level variable, its purpose, whether it is secret, and its safe default.
