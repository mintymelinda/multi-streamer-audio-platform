# Roadmap acceptance tests

These tests describe later roadmap items whose implementation modules have not been merged yet.
They are kept here as acceptance-test specifications and are intentionally excluded from the
active `apps/api/test/*.test.mjs` test glob until their matching implementation is introduced.

- `phase3-provider-queue-authority.test.mjs` — item 31: provider-specific execution queues and state.
- `phase3-playback-manual-recovery.test.mjs` — item 32: failover and manual recovery actions.
- `phase3-provider-adapter-integration.test.mjs` — item 33: YouTube/Invidious, Spotify, and Lyrion adapters.
- `phase3-rights-compliance.test.mjs` — item 34: rights-aware product safeguards.
- `phase3-rights-review-workflow.test.mjs` — item 34: rights-holder review and legal-readiness workflow.

When an item is implemented, move its acceptance tests into the active API test directory and
include them in the same pull request as the implementation.
