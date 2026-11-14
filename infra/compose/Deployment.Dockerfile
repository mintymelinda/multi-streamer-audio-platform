FROM node:26.13.0-bookworm-slim AS build

ENV PNPM_HOME="/home/node/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm install --global pnpm@12.18.0 \
    && node --version \
    && pnpm --version

WORKDIR /workspace
RUN chown node:node /workspace
USER node

COPY --chown=node:node . .

ARG API_INTERNAL_URL=http://api:3000
ENV API_INTERNAL_URL=$API_INTERNAL_URL

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN set -eu; \
    for app in dashboard overlay; do \
      standalone="apps/$app/.next/standalone"; \
      server="$(find "$standalone" -type d -name node_modules -prune -o -type f -name server.js -print -quit)"; \
      test -n "$server"; \
      runtime_dir="$(dirname "$server")"; \
      mkdir -p "$runtime_dir/.next/static"; \
      cp -a "apps/$app/.next/static/." "$runtime_dir/.next/static/"; \
      if [ -d "apps/$app/public" ]; then \
        mkdir -p "$runtime_dir/public"; \
        cp -a "apps/$app/public/." "$runtime_dir/public/"; \
      fi; \
    done

# One immutable application image is reused by API, worker, dashboard, and
# overlay containers. Commands are selected by the Compose service definition.
FROM node:26.13.0-bookworm-slim AS runtime

ENV PNPM_HOME="/home/node/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm install --global pnpm@12.18.0

WORKDIR /workspace
COPY --from=build --chown=node:node /workspace /workspace

USER node

EXPOSE 3000 3001

CMD ["node", "apps/api/dist/main.js"]
