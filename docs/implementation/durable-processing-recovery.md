# Phase 2 — Durable processing retries and authorized recovery

This document scopes roadmap item 24 from architecture issue #3.

## Durable state

PostgreSQL is authoritative for:

- processing state and terminal outcome;
- attempt count and next eligible attempt;
- lease owner/expiry;
- normalized failure classification;
- last error safe for operators;
- recovery actor, reason, and timestamp.

Redis/BullMQ jobs are delivery hints and must be reconstructible from persisted state.

## Retry policy

- Retry only classified transient failures.
- Use bounded exponential backoff with jitter.
- Enforce maximum attempts and maximum retry age.
- Persist terminal failure before acknowledging the final job failure.
- Treat ambiguous provider side effects as reconciliation-required, not blindly retryable.
- Use stable idempotency keys for every externally visible effect.

## Authorized recovery

Provide explicit actions for authorized workspace roles:

- Retry: requeue a recoverable failure using the original idempotency identity.
- Dismiss: close the failed operation without re-executing it.

Both actions require server-side permission checks, a reason, audit history, and a transactional outbox event. A client-supplied actor/workspace identity is never trusted.

## Recovery and tests

A reconciler must find due or expired-lease work in PostgreSQL and restore missing BullMQ jobs. Tests must cover Redis loss, worker termination, lease expiry, duplicate jobs, permission failures, repeated recovery actions, and tenant isolation.
