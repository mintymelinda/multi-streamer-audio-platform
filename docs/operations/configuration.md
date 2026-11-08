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


## Twitch broadcaster authorization

Platform sign-in and workspace broadcaster authorization are separate OAuth grants:

- `TWITCH_CLIENT_ID`: Twitch application client ID.
- `TWITCH_CLIENT_SECRET_FILE`: protected file containing the Twitch application client secret.
- `TWITCH_REDIRECT_URI`: exact registered callback URL for platform sign-in at `/auth/twitch/callback`.
- `TWITCH_INTEGRATION_REDIRECT_URI`: exact registered HTTPS callback URL for workspace authorization at `/auth/twitch/integration/callback`.
- `INTEGRATION_KEK_RING_FILE`: protected key-ring file used to encrypt workspace OAuth credentials at rest.

Register both callback URLs in the Twitch developer console. The workspace callback URL must be HTTPS outside localhost and must not contain a query string or fragment. Workspace authorization is initiated by the workspace owner and must be granted by the same Twitch broadcaster account that owns the workspace. The app requests `channel:manage:redemptions`, which Twitch requires for creating, updating, deleting, and listing the app's manageable Channel Point rewards.

Workspace access and refresh tokens are stored only inside the authenticated encrypted credential envelope in `workspace_integrations`. Never expose tokens, refresh tokens, encryption envelopes, or the KEK ring to the browser, logs, audit details, or outbox payloads.
