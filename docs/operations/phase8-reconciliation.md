# Phase 8 branch reconciliation

**Status:** Integration candidate assembled; automated verification pending.

## Candidate

- Branch: `release/phase-8-reconciled`
- Base: `main`
- Current integration commit: `f2770ed0231131ef96bc95449013c33abc4f2efc`
- Pull request: #191

The integration commit has five parents, in this order:

1. `main` — `35d61e64190619926f2460bd1d8b130bf4a6b2fe`
2. `phase-8/item-73-ci-quality-gates` — `4787f5bb08dd7a06912efdad5ece1a64e03552c4`
3. `phase-8/item-68-request-playback-e2e` — `fbd6351bb993741166c309b019c7885762225592`
4. `phase-8/item-74-release-verification` — `e137cd06dced224411c86d779149e02f1a759f2f`
5. `phase-8/item-75-launch-readiness-review` — `8f45e7fdacf3166aaedd67f085b3ba38000a6d43`

Using `main` as the first parent preserves its six main-only commits (#138 and #180–#184). The other parents retain the Phase 8 and follow-up branch histories.

## Conflict resolutions

- `apps/api/package.json`: retained Phase 8 Redis Socket.IO adapter, ioredis, and Fastify static dependencies while preserving main's NestJS 12.5 versions.
- `pnpm-lock.yaml`: combined main's updated dependency graph with Phase 8's additional dependency entries and aligned API importer versions. The initial CI run caught missing root package-manager metadata; the lockfile was corrected to retain the root `configDependencies` and `packageManagerDependencies` entries.
- `scripts/test/platform-backup-restore.test.mjs`: retained the Phase 8 extension, which includes the three main-side restore tests and adds the real PostgreSQL archive verification case.
- Follow-up branch-only files were overlaid from item-68, item-74, and item-75 so the request/playback E2E, staging audit, and launch-readiness updates are not omitted.

## Verification

The first CI run on the initial integration commit failed at `pnpm install --frozen-lockfile` because root package-manager metadata was missing from the hand-assembled lockfile. That metadata has since been restored in the candidate. The subsequent commit must pass a fresh frozen install, quality gates, tests, type checks, migrations, builds, and CodeQL before this PR can be considered merge-ready.

No production deployment or launch approval is authorized by this reconciliation.
