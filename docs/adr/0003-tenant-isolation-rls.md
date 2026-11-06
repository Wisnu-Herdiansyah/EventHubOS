# ADR-0003: Tenant isolation with service authorization plus PostgreSQL RLS

- Status: accepted
- Date: 2026-11-06

## Context

PRD trust target: zero cross-tenant authorization incidents. Architecture §4 requires
server-resolved tenant context, RLS on every tenant-owned table, and a runtime role that cannot
bypass RLS.

## Decision

1. **Canonical tenant ID** is `organization.id` (UUID), generated server-side, immutable.
2. **Context resolution:** organization IDs in URLs are _locators only_.
   `withOrganization()` looks up an active membership for (authenticated user, locator); absence
   yields `404` (indistinguishable from non-existence), insufficient role yields `403`.
   Only then is `app.organization_id` set with `set_config(..., is_local => true)`.
3. **Database roles** (created by `pnpm db:bootstrap`):
   - `eventhub_migrator` — schema owner, used only by the migration job.
   - `eventhub_app` — runtime; `NOBYPASSRLS`, owns nothing, column-level grants, no `DELETE`.
   - `eventhub_worker` — outbox relay; delivery-state columns only.
4. **Every tenant-owned table**: `organization_id NOT NULL`, `ENABLE` + `FORCE ROW LEVEL
SECURITY`, policies comparing to `current_organization_id()`. Missing context matches no rows.
   A catalog test fails if any table with `organization_id` lacks enabled+forced RLS.
5. **Ownership is immutable**: no `UPDATE` grant on `organization_id`, plus a trigger guard.
6. **Child tables** referencing tenant aggregates use composite FKs `(organization_id, id)`
   (targets already exist, e.g. `event (organization_id, id)`).
7. **Global tables** (`app_user`, `auth_session`) have bespoke access: users see only themselves;
   sessions are resolved only through a `SECURITY DEFINER` function.
8. **Migration safety:** forward-only, checksummed, per-file transaction with `lock_timeout`,
   expand → migrate → contract. `pnpm db:check` rejects destructive or RLS-weakening statements
   unless annotated `-- eventhub:allow-destructive <reason>` and reviewed.

## Consequences

- Two independent layers must both fail for a cross-tenant read. Mutation tests during the
  Phase 0 build confirmed each layer's tests fail when that layer is removed.
- Every new tenant table must add RLS policies and grants in its migration; the catalog test
  enforces RLS presence, reviewers enforce policy correctness.
- Cross-tenant platform operations (support tooling, reporting) need dedicated roles/policies and
  their own ADR; they must not reuse `eventhub_app`.
