# ADR-0012: Organization settings and member role changes

- Status: accepted
- Date: 2026-11-06
- Implements: PRD ORG-04 (except data-retention configuration) and member role changes
- Amends: ADR-0010 (closes its "invitations outlive their sender's authority" gap)

## Decision

**Organization settings.** `PATCH /v1/organizations/{id}` with `expectedVersion` (optimistic
concurrency) and an `Idempotency-Key`. **Permission is checked per field**:

| Field                                            | Permission            |
| ------------------------------------------------ | --------------------- |
| `displayName`, `legalName`, `locale`, `timezone` | `organization.manage` |
| `billingContact` (`name`, `email`)               | `billing.manage`      |

A request containing any field the caller cannot change is rejected as a whole, listing the
offending fields, so nothing is partially applied. So Admins cannot change billing details, and
Billing admins can change only billing details. Nullable fields (`legalName`, `billingContact`)
are cleared with `null`. The billing contact is personal data: it is returned only to roles with
`billing.read`, and audit/outbox records carry field names, not values.

**Member role changes.** `POST /v1/organizations/{id}/members/{membershipId}/role {role}`
requires `membership.manage` and passes the role ceiling **twice**: the caller must be able to
act on the member's _current_ role and to grant the _new_ one (`canAssignRole`). All active
Owner rows are locked first, so the last Owner can never be demoted, even when two Owners demote
each other concurrently (one succeeds; the other is refused). The new role applies on the
member's next request. Setting the same role is a no-op without audit.

**Invitations follow their sender's current authority.** When a member is demoted, their pending
invitations to roles the new role could not grant are revoked. A role without
`membership.manage` can grant nothing, so all of them are revoked. When a member is removed, all
their pending invitations are revoked. The count is recorded in the audit event.

## Consequences

- **Not built: data-retention configuration** (ORG-04 "constrained by plan"). It needs plan
  entitlements (Phase 4) and the retention policy (D9). Inventing values now would mislead.
- Ownership _transfer_ (an Owner handing over and stepping down in one step) is achievable as
  promote-then-demote. A dedicated, audited transfer flow using `organization.transfer_ownership`
  can follow.
- A caller's own role is resolved at the start of each request without a row lock, to avoid
  deadlocks between concurrent membership changes. Safety-critical invariants (last Owner,
  ceilings on the locked target rows) are enforced on locked rows inside the transaction.
