# syntax=docker/dockerfile:1
#
# WhatsApp AI Business OS — production image.
# A single image that runs EITHER the API or the worker, chosen at runtime by
# the SERVICE env var ("api" | "worker", default "api"). Portable across
# Render, Railway, and any Docker-capable VPS.
#
#   docker build -t wabiz .
#   docker run -e SERVICE=api    -p 3000:3000 wabiz
#   docker run -e SERVICE=worker wabiz
#
# See docs/DEPLOYMENT.md for the full env var checklist.

FROM node:20-bookworm-slim AS build

WORKDIR /app

# Prisma needs a resolvable DATABASE_URL at `prisma generate` time (the
# postinstall step). The value below is only used to emit the client; the real
# URL is provided at runtime via env vars.
ARG DATABASE_URL=postgresql://prisma:prisma@localhost:5432/prisma
ENV DATABASE_URL=$DATABASE_URL

# Prisma's query engine needs openssl on slim images.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy the whole monorepo (npm workspaces: apps/* and packages/*).
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json vitest.config.ts vitest.integration.config.ts ./

RUN npm ci

RUN npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV SERVICE=api

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
# Full node_modules (includes dev deps) so `prisma migrate deploy` + `db:seed`
# can be run as one-off jobs inside the same image.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Brand assets (logo) referenced at runtime by the API dashboard.
COPY --from=build /app/apps/api/src/assets ./dist/apps/api/src/assets
# The compiled `dist/packages/db/src/client.js` requires './generated/client'
# (Prisma's output). tsc does not emit the generated client, so copy it into
# the dist tree alongside the compiled sources.
COPY --from=build /app/packages/db/src/generated ./dist/packages/db/src/generated
# Prisma schema, migrations, seed scripts and CLI entrypoint.
COPY --from=build /app/packages/db ./packages/db

COPY --chmod=0755 start.sh ./start.sh

EXPOSE 3000
CMD ["sh", "./start.sh"]