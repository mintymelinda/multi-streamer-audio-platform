# Phase 2 — Twitch authorization-loss pause and recovery

This document scopes roadmap item 23 from architecture issue #3.

## State model

The implementation must distinguish:

- connected — credentials are valid and required scopes/broadcaster identity are verified;
- reauth_required — Twitch definitively rejected authorization or required identity/scope validation failed;
- temporarily_unavailable — network, rate-limit, or Twitch service failures where authorization is unknown.

Only the definitive reauth_required state may trigger the workspace pause.

## Pause transaction

In one workspace-scoped transaction:

1. Lock and update the Twitch integration state.
2. Mark Twitch-dependent activity paused using an explicit persisted workspace/integration state.
3. Prevent reward routing and other Twitch-triggered actions from proceeding.
4. Append an audit event and deterministic owner-notification outbox event.

Do not delete credentials, mappings, queue entries, requests, or preferences as a side effect of pausing.

## Recovery gate

After the owner reconnects:

1. Validate the connected broadcaster ID and required scopes.
2. Refresh/reconcile EventSub subscriptions.
3. Reconcile Twitch reward identities and mappings.
4. Clear the pause only after all mandatory checks succeed.
5. Emit one idempotent recovery audit/outbox event.

A transient outage must never set reauth_required or automatically pause/resume a workspace.

## Security and tests

All reads/writes must run under verified workspace RLS context. Tests must cover tenant isolation, concurrent pause/recovery, duplicate signals, preservation of durable request state, and no resume before reconciliation.
