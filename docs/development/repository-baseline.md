# Repository baseline — Phase 0

**Inspected:** 2026-11-08  
**Repository:** [mintymelinda/multi-streamer-audio-platform](https://github.com/mintymelinda/multi-streamer-audio-platform)  
**Default branch:** `main`  
**Working branch:** `phase-0/engineering-foundation`

## Observed state before Phase 0 changes

The repository had no source files, application manifests, dependencies, CI workflows, Docker configuration, migrations, deployment scripts, or documented engineering conventions. There was no existing application code or deployment configuration to preserve.

## Existing conventions

None were present in the repository at inspection time. Phase 0 establishes the first conventions rather than extending legacy ones.

## Approved architecture and deployment assumptions

- Modular monolith with explicit business-module boundaries.
- Node.js and TypeScript; NestJS with Fastify for the API and worker processes.
- Separate Next.js dashboard and independently deployable overlay frontend.
- PostgreSQL as the source of truth; Redis for jobs/realtime coordination; S3-compatible object storage.
- Docker Compose on the existing NAS as the initial hosting target.
- Existing reverse proxy/domain for HTTPS, with the hostname kept portable/configurable.
- Application and workspace settings stored in PostgreSQL; environment variables reserved for process bootstrap and infrastructure wiring.

These are approved project decisions, not findings about the current NAS. No NAS, production environment, credentials, or running services were inspected or changed during this baseline review.
