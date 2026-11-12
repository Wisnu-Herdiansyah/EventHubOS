# syntax=docker/dockerfile:1.7
#
# Container images for EventHub OS (ADR-0053): one target per service.
#   docker build --target api    -t eventhub-api .
#   docker build --target worker -t eventhub-worker .
#   docker build --target admin  -t eventhub-admin .
#   docker build --target site   -t eventhub-site .
# Every image runs as the unprivileged `node` user, listens on 8080 where it serves HTTP, and
# holds no configuration or secrets: those come from the environment at run time (Secret Manager
# on Cloud Run, ADR-0051). Database migrations run from the api image:
#   docker run ... eventhub-api node packages/db/src/cli/migrate.ts

# Node 22 (engines: >=22.18 <23) from Google's Docker Hub mirror, pinned by digest.
ARG NODE_IMAGE=mirror.gcr.io/library/node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

# ---------------------------------------------------------------------------------------------
# Build stages
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV CI=1 NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Behind a TLS-inspecting proxy, pass its CA as a build secret (never stored in a layer):
#   docker build --secret id=extra_ca,src=proxy-ca.pem --build-arg HTTPS_PROXY=... .
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# Every dependency in the lockfile, fetched once into the store (cached until the lockfile changes).
# `pnpm fetch` also fills node_modules with everything; that is dropped so each image installs only
# its own dependencies from the store.
FROM base AS fetched
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm fetch --frozen-lockfile && rm -rf node_modules
COPY . .

# API and worker run their TypeScript sources directly (Node type stripping), so each keeps the
# workspace layout with only its own production dependencies.
FROM fetched AS api-build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --prod --filter "@eventhub/api..."

FROM fetched AS worker-build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --prod --filter "@eventhub/worker..."

# Admin and site: Next.js standalone output (a traced, self-contained server).
FROM fetched AS web-deps
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@eventhub/admin..." --filter "@eventhub/site..."
ENV NODE_ENV=production NEXT_OUTPUT=standalone

FROM web-deps AS admin-build
RUN pnpm --filter @eventhub/admin build

FROM web-deps AS site-build
RUN pnpm --filter @eventhub/site build

# ---------------------------------------------------------------------------------------------
# Runtime images
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# The services need only `node`. The bundled package managers (npm, Corepack, Yarn) are never
# used at run time and carry their own vulnerable dependencies, so they are removed.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Files are owned by root and read-only to the service user.
USER node

FROM runtime AS api
ENV HTTP_HOST=0.0.0.0 HTTP_PORT=8080
COPY --from=api-build /app/package.json ./
COPY --from=api-build /app/node_modules ./node_modules
COPY --from=api-build /app/packages ./packages
COPY --from=api-build /app/apps/api ./apps/api
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/api/src/main.ts"]

FROM runtime AS worker
COPY --from=worker-build /app/package.json ./
COPY --from=worker-build /app/node_modules ./node_modules
COPY --from=worker-build /app/packages ./packages
COPY --from=worker-build /app/apps/worker ./apps/worker
CMD ["node", "apps/worker/src/main.ts"]

FROM runtime AS admin
ENV HOSTNAME=0.0.0.0 PORT=8080
COPY --from=admin-build /app/apps/admin/.next/standalone ./
COPY --from=admin-build /app/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=admin-build /app/apps/admin/public ./apps/admin/public
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/login').then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/admin/server.js"]

FROM runtime AS site
ENV HOSTNAME=0.0.0.0 PORT=8080
COPY --from=site-build /app/apps/site/.next/standalone ./
COPY --from=site-build /app/apps/site/.next/static ./apps/site/.next/static
EXPOSE 8080
CMD ["node", "apps/site/server.js"]
