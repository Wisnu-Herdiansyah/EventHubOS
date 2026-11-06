# EventHub OS

Multi-tenant SaaS platform for organizations and agencies to build, publish, operate, and
measure branded event microsites on verified custom domains.

Specifications: `PRD.md`, `TECHNICAL_ARCHITECTURE.md`, `IMPLEMENTATION_ROADMAP.md` (supplied
separately). Repository status against the architecture: `docs/architecture/repository-map.md`.
Blocking decisions: `docs/architecture/open-decisions.md`.

## Current scope

Phase 0 (foundation) plus Phase 1 slices:

- **Identity** (ADR-0007): email/password sign-up with Argon2id, email verification, login with
  lockout, logout, and `GET /v1/me`.
- **Tenancy and events**: organization creation with Owner membership, listing a user's
  organizations, and creating, reading, and listing draft events.

All of it sits behind server-resolved tenant context, deny-by-default permissions, PostgreSQL
RLS, idempotency keys, and transactional audit/outbox records.

## Layout

```
apps/
  api/        Fastify control-plane API (modular monolith), OpenAPI contract in openapi.json
  worker/     Outbox relay, event consumers (verification email), email adapters (Resend, local)
packages/
  config/     Typed, fail-closed environment configuration
  kernel/     Errors, permission catalog, domain-event envelope, provider ports + contract tests
  db/         Pool, tenant transactions, audit/outbox/idempotency, migrations, role bootstrap,
              integration-test harness
tests/        Cross-process end-to-end tests (API + worker)
docs/         ADRs, open decisions, threat model, environment contract, operations runbooks
infra/        IaC (blocked on cloud decision)
```

## Prerequisites

- Node.js 22.18+ (`.nvmrc`), pnpm 10 (`corepack enable`)
- PostgreSQL 16 (local install, or `docker compose up -d` with `POSTGRES_ADMIN_PASSWORD` in `.env`)

## Common commands

```bash
pnpm install
pnpm verify              # format check, lint, typecheck, migration lint, unit + integration tests
pnpm test:unit           # no database needed
TEST_DATABASE_ADMIN_URL=postgres://postgres:<pw>@localhost:5432/postgres pnpm test:integration
pnpm openapi:generate    # regenerate apps/api/openapi.json after changing routes
pnpm test:live           # opt-in live provider contracts (needs RESEND_* credentials)
pnpm outbox:replay       # return dead-lettered events to the queue (see docs/operations)
```

## Running locally

```bash
createdb eventhub                                    # as a PostgreSQL superuser
DATABASE_ADMIN_URL=postgres://postgres:<pw>@localhost:5432/eventhub \
EVENTHUB_MIGRATOR_PASSWORD=<random> EVENTHUB_APP_PASSWORD=<random> EVENTHUB_WORKER_PASSWORD=<random> \
pnpm db:bootstrap
cp .env.example .env                                 # fill in the three role URLs
pnpm db:migrate
node --env-file=.env apps/api/src/main.ts
node --env-file=.env apps/worker/src/main.ts
```

With `EMAIL_SENDER=local_file`, verification emails are written as JSON files to
`EMAIL_LOCAL_DIR`. Open the link in the `text` field (or post its `#token=` value to
`POST /v1/auth/verify-email`) to verify an account locally.
