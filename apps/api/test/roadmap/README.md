# Roadmap acceptance tests

These tests describe roadmap items whose implementation modules have not yet been introduced.
They are intentionally excluded from the active `apps/api/test/*.test.mjs` test glob.

- `phase3-playback-manual-recovery.test.mjs` — item 32: failover and manual recovery actions.

Phase 3 item 34 rights-compliance acceptance tests and item 35 provider-adapter integration tests
have been promoted into the active API test directory. Capability routing, output conflicts,
authorization expiry, outage recovery, and duplicate-playback prevention are also covered by the
active API and worker test suites.
