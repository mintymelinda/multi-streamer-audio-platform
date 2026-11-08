# Twitch redemption routing

Twitch EventSub webhook verification and durable delivery intake are separate from feature execution. The worker validates the durable delivery envelope and writes an idempotent `twitch_eventsub_intake` row; it does not receive access to workspace reward mappings or request tables.

The API's redemption router claims pending intake rows using short database leases. For each row it re-enters the normal workspace RLS context using the workspace owner recorded when the EventSub subscription was registered, then loads only the matching reward mapping. A mapping must be enabled and have `synced` status before it can invoke the Requests application service.

Redemption input is taken from Twitch's `event.user_input`, not the reward title. The configured input mode is enforced before submission. The request uses Twitch's redemption ID as its source idempotency key and flows through the same moderation, per-user/source limits, queue ordering, state history, and transactional outbox as dashboard requests.

The router records processed, ignored, and terminal-failure outcomes on the intake row. Transient failures return to pending; expired processing leases are recoverable. If the router crashes after request creation but before recording completion, `RequestsService`' source-event deduplication returns the original request rather than creating a second one.

The platform runtime role can claim/update only routing fields on the intake table. The worker still has no direct grants on reward mappings, media requests, or workspace configuration.