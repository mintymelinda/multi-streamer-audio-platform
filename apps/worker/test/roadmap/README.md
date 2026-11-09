# Worker roadmap acceptance tests

These specifications target later Phase 3 items and are excluded from the active
`apps/worker/test/*.test.mjs` test glob until their implementation is introduced.

- `phase3-provider-execution-policy.test.mjs` — item 31: provider-specific execution policy and queue authority.
- `phase3-provider-outage-recovery.integration.test.mjs` — item 32: provider outage recovery and failover.

Move each test into the active worker test directory with its corresponding implementation PR.
