# Phase 2 — Workspace REST, OpenAPI, and Socket.IO contracts

This document scopes roadmap item 25 from architecture issue #3.

## REST and OpenAPI

- Keep the API versioned and workspace-scoped.
- Derive actor identity from the verified server session.
- Resolve workspace access through existing authorization guards and RLS transaction context.
- Define DTO schemas for request intake, moderation, queue actions, Twitch reward mappings, integration health, and recovery actions.
- Generate OpenAPI from the API implementation and use it to generate shared TypeScript contracts.
- Treat the generated specification as a CI-verified artifact; fail on uncommitted drift.

## Socket.IO authorization

- Authenticate the handshake with the existing HTTP-only server session.
- Require the client to request a workspace context, then independently verify active membership and required permissions.
- Assign room names only on the server after verification.
- Re-check or revoke room access when membership or role changes.
- Never broadcast credentials, raw webhook payloads, or cross-tenant identifiers.

## Event delivery and recovery

- Publish committed outbox events to Socket.IO.
- Use stable event IDs and workspace IDs for deduplication and routing.
- On reconnect, clients fetch an authorized REST snapshot and resume live events; Socket.IO is not the source of truth.
- Test missed events, duplicate delivery, stale sessions, revoked memberships, and attempts to subscribe to another workspace's room.
