# Contributing

## Source of truth

The architecture master plan in GitHub Issue #3 is the authoritative record of product and architecture decisions. Do not create parallel architecture plans or silently change an accepted decision.

## Change discipline

- Work in a focused branch and open a pull request for review.
- Keep business rules inside their owning modular-monolith module.
- Add or update tests for behavior changes.
- Preserve tenant isolation and authorization checks at every boundary.
- Never commit credentials, production data, or local environment files.
- Do not deploy to production or modify the NAS as part of ordinary development work.

## Required checks

Run the root lint, formatting, type-check, test, and build commands before requesting review. CI must pass before merge.
