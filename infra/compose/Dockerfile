FROM node:26.13.0-bookworm-slim AS toolchain

ENV PNPM_HOME="/home/node/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install --global pnpm@12.18.0 @biomejs/biome@2.6.5 \
    && node --version \
    && pnpm --version \
    && biome --version

WORKDIR /workspace

FROM toolchain AS workspace

USER node

CMD ["sleep", "infinity"]

# Immutable source snapshot for reproducible formatting, lint, typecheck,
# migration validation, tests, and production builds.
FROM toolchain AS checks

COPY --chown=node:node . .

USER node

RUN pnpm install --frozen-lockfile

CMD ["sh", "-lc", "pnpm format:check && pnpm lint && pnpm typecheck && pnpm db:migrations:check && pnpm test && pnpm build"]
