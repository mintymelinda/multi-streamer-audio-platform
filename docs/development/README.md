# Local development

## Prerequisites

- Node.js 26.13.x (Active LTS when this baseline was selected).
- pnpm 12.18.0, pinned through the root `packageManager` field.
- Docker Engine with the Docker Compose plugin.

## Start infrastructure

From the repository root:

```sh
pnpm dev:infra
```

This starts PostgreSQL, Redis, and an S3-compatible local object store. Ports are bound to loopback only. The sample credentials are for local development and must never be reused in a deployed environment.

To stop the services:

```sh
pnpm dev:infra:down
```

Persistent named volumes are retained by the down command. Use `docker compose ... down -v` only when you intentionally want to erase local development data.

## Install and verify

```sh
pnpm install
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

The root scripts are the canonical local equivalents of CI quality gates.

## Configuration policy

Application behavior and workspace preferences belong in PostgreSQL-backed configuration, not environment variables. Environment variables are reserved for process bootstrap and infrastructure wiring (ports, database/Redis/object-store endpoints, and secret-file locations). Never commit real credentials or production configuration. The local Compose file and its sample credentials are not a production deployment recipe.

## Runtime processes

- `apps/api`: NestJS HTTP API using Fastify.
- `apps/worker`: NestJS application-context process for asynchronous jobs.
- `apps/dashboard`: Next.js streamer dashboard.
- `apps/overlay`: independently built Next.js read-only OBS overlay runtime.
- `packages/contracts`: small, dependency-light contracts shared between processes.

The API and worker are separate processes from the same modular-monolith codebase. They are not independent business services.
