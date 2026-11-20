# Multi-Streamer Audio Platform

A centrally hosted, multi-tenant audio request and playback platform for Twitch streamers.

The architecture and product decisions are maintained in [GitHub Issue #3](https://github.com/mintymelinda/multi-streamer-audio-platform/issues/3), which is the single source of truth.

## Project status

The repository now contains the core API, worker, dashboard, OBS overlay runtime, provider/playback foundations, workspace administration, privacy/recovery tooling, and staging deployment workflows. Implementation has progressed through the Phase 8 release-verification work.

**Public launch is not approved.** The final readiness review in [docs/operations/final-launch-readiness.md](docs/operations/final-launch-readiness.md) tracks the remaining browser journey, provider/legal approvals, staging-host rehearsal, capacity/SLO evidence, multi-instance recovery, and independent backup/restore acceptance. Passing CI or merging implementation work does not authorize production or NAS deployment.

See [GitHub Issue #3](https://github.com/mintymelinda/multi-streamer-audio-platform/issues/3) for the agreed product scope and implementation sequence, and [docs/development/README.md](docs/development/README.md) for local development guidance.
