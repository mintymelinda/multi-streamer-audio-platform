# Modular-monolith boundaries

The platform is one modular monolith with independently runnable API and worker processes. Process separation is an operational boundary, not permission to create duplicated business logic or hidden service-to-service dependencies.

## Business modules

- **Identity** — platform account identity and Twitch sign-in.
- **Workspaces** — workspace lifecycle, ownership, settings, and tenant context.
- **Authorization** — workspace membership, role and capability checks, and access enforcement.
- **Team Management** — invitations, membership changes, and team administration.
- **Requests** — intake, normalization, validation, and request lifecycle.
- **Queues** — authoritative logical ordering, priorities, limits, moderation holds, and queue operations.
- **Playback** — serialized playback coordination, output assignment, and reconciliation.
- **Integrations** — provider adapters, credentials, capabilities, and connection health.
- **Overlay** — scene configuration, publication, bearer-token authorization, and read-only runtime contracts.
- **Administration** — platform operations and controlled support workflows.
- **Audit** — durable security and administrative audit records.

## Dependency rules

1. Each business module owns its domain model, application use cases, persistence mapping, and public module interface.
2. Other modules call exported application interfaces or consume documented domain events; they do not reach into another module's private implementation or tables.
3. Cross-module workflows are orchestrated through application services and the transactional outbox. No module imports another module's internal repository.
4. Provider SDKs and protocol details stay inside Integration adapters. Domain modules depend on provider-neutral ports and capability contracts.
5. Shared contracts contain stable transport/domain-neutral types only. They must not become a dumping ground for business logic.
6. Presentation layers (REST controllers, Socket.IO gateways, dashboard and overlay pages) call application interfaces; they do not implement business rules.
7. Workers execute the same application use cases as the API. They must not fork or reimplement domain behavior.
8. Avoid circular dependencies. Any proposed exception requires an explicit architecture decision recorded in the master plan.

## Tenant isolation

Workspace identity is explicit in application use cases and persistence operations. PostgreSQL is authoritative; tenant-scoped database access must run inside a transaction that sets transaction-local workspace context. Runtime database credentials must not own tables or bypass row-level security. Tenant context must never be inferred from a client-supplied workspace ID without membership authorization.

## Runtime boundaries

- API: authenticated control plane and workspace REST/realtime endpoints.
- Worker: durable asynchronous jobs and outbox delivery.
- Dashboard: authenticated user interface.
- Overlay: independently deployable, read-only public runtime protected by per-scene revocable tokens.

The dashboard and overlay are separate deployable frontends; neither is a separate business microservice.
