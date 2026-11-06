# Contributing

## Non-negotiable invariants

1. Never trust a browser-supplied organization ID for authorization. Resolve tenant context via
   `withOrganization()` (membership) or, for public traffic, a verified route lookup.
2. Every tenant-owned table: `organization_id NOT NULL`, RLS enabled **and forced**, policies
   against `eventhub.current_organization_id()`, column-scoped grants, no grant on
   `organization_id` updates. Child tables use composite FKs `(organization_id, id)`.
3. Permissions are explicit and deny by default (`packages/kernel/src/permissions.ts`). Changing
   the catalog bumps `PERMISSION_CATALOG_VERSION` and the matrix test.
4. Side-effecting mutations: `idempotent: true` on the route, `runIdempotentCommand()`, and
   `writeAudit()` + `enqueueEvent()` in the same transaction. Side effects run only in outbox
   consumers using `processOnce()`.
5. Drafts and published revisions are separate, immutable-revision concepts; drafts are never
   publicly routable (Phase 2).
6. Section instances are typed, versioned, schema-validated; no tenant JavaScript/HTML execution.
7. Providers only behind ports/adapters (`src/adapters/**`), each with a shared contract test.
   ESLint blocks known provider SDK imports elsewhere.
8. Secrets never enter source, fixtures, logs, bundles, or error messages.

## Migrations

- Add `packages/db/migrations/NNNN_snake_name.sql` (contiguous numbering). Never edit an applied
  migration — checksums are enforced.
- Expand → migrate → contract. Destructive or RLS-weakening statements fail `pnpm db:check`
  unless the file contains `-- eventhub:allow-destructive <reason and ADR/plan reference>`.
- Keep DDL lock-friendly (`CREATE INDEX CONCURRENTLY` in its own migration when tables are large).

## API changes

Define routes with `defineRoute()`; run `pnpm openapi:generate` and commit `openapi.json`.
Use `AppError` codes; never return raw errors.

## Tests

Every behaviour change needs tests. Tenant-scoped features need a cross-organization access test
(API and, for new tables, RLS). Integration tests: `*.int.test.ts`; unit tests: `*.test.ts`.

## Decisions

Architecture-relevant choices need an ADR (`docs/adr/`). Unresolved items go in
`docs/architecture/open-decisions.md`.
