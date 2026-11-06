# ADR-0013: Audit log viewer

- Status: accepted
- Date: 2026-11-06
- Implements: Phase 1 "audit log viewer" (roadmap); PRD auditability and Owner/Admin
  `audit.read`

## Decision

`GET /v1/organizations/{id}/audit-events` returns the organization's audit records, newest first,
to roles with `audit.read` (Owner, Admin).

- **Filters:** exact `action` or category `actionPrefix` (must end with a dot, e.g.
  `membership.`), `actorId`, `targetType` + `targetId` (the history of one object), and a
  `from`/`to` time range. Unknown or contradictory filters are rejected.
- **Paging:** keyset cursor on `(occurred_at, id)`, 1–100 rows per page (default 50). Pages stay
  stable and duplicate-free while new events are written.
- **Isolation:** tenant RLS on `audit_event` is the boundary. A mutation test removed the query's
  own tenant predicate and the cross-tenant test still passed. Platform-scoped `identity.*`
  records (no organization) are never visible to tenants.
- **Actor display:** emails are resolved only for current or former members of the same
  organization, through the tenant-bound `organization_members` function. Otherwise the email is
  `null`.
- **Privacy:** metadata is shown as written. Writers already minimise it (masked emails, changed
  field names rather than values), and the integration tests assert no plain invitee address
  appears.
- **Indexes (migration 0006):** `(organization_id, occurred_at DESC, id DESC)` for paging and
  `(organization_id, target_type, target_id, occurred_at DESC)` for object history.

## Consequences

- Viewing the audit log is not itself audited. Revisit if audit metadata ever carries personal
  data.
- CSV/JSON export of the audit log (compliance evidence) is a follow-up. It should be
  permission-gated, audited, and run as a background job.
- Index additions on large tables later must use `CREATE INDEX CONCURRENTLY` in their own
  non-transactional migration step. The migration runner will need that capability first.
