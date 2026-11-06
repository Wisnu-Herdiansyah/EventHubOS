# ADR-0002: Runtime, monorepo layout, and API framework

- Status: accepted
- Date: 2026-11-06

## Context

The architecture proposes TypeScript on Node.js LTS, a pnpm monorepo, a modular monolith with
separately deployable public, admin, worker processes, and an OpenAPI-described REST API. The
HTTP framework was not specified.

## Decision

- **Runtime:** Node.js 22 LTS (`>=22.18`), running TypeScript source directly via Node's built-in
  type stripping. Code is written in the erasable TypeScript subset (`erasableSyntaxOnly`:
  no enums, namespaces, or parameter properties). `tsc` is used only for type checking.
  This removes a build step and source-map drift; revisit if a bundling need appears.
- **Monorepo:** pnpm workspaces. `packages/*` are internal libraries consumed from source;
  `apps/*` are deployable processes (`api`, `worker`; `admin-web` and `public-web` arrive in
  Phase 1/2 UI work).
- **API framework:** Fastify 5 — mature, fast, first-class hooks for request IDs, logging with
  redaction, body limits, and rate limiting.
- **Validation and contract:** Zod 4 schemas declared per route (`defineRoute`) are the single
  source of truth for input validation, response validation (non-production), and the generated
  OpenAPI 3.1 document (`apps/api/openapi.json`, verified up-to-date in CI).
- **Tooling:** TypeScript 6.0, ESLint 10 + typescript-eslint (type-aware), Prettier, Vitest 5.

## Consequences

- Admin and public Next.js applications (baseline) are not yet scaffolded; they will be added
  when Phase 1 UI work starts, as separate apps consuming the OpenAPI contract.
- `typescript@7` (native compiler) is not adopted until typescript-eslint supports it.
