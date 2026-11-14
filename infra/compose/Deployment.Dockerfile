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
