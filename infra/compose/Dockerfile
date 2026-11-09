FROM node:26.13.0-bookworm-slim

ENV PNPM_HOME="/home/node/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN npm install --global pnpm@12.18.0 @biomejs/biome@2.6.5 \
    && node --version \
    && pnpm --version \
    && biome --version

WORKDIR /workspace

USER node

CMD ["sleep", "infinity"]
