# ADR-0010: Organization invitations and membership removal

- Status: accepted
- Date: 2026-11-06
- Implements: PRD ORG-02 (invite by email with a role, revoke pending invitations, remove
  memberships; tokens single-use and expiring; no granting above the inviter's authority)

## Decision

**Data.** `eventhub.invitation` is tenant-owned with forced RLS. At most one _pending_ invitation
exists per address per organization (partial unique index). A lapsed pending invitation is
marked `expired` when a new one is created, and reported as `expired` when listed. The runtime
role cannot read or write `token_hash` (column-level grants) and cannot change an invitation's
email, role, or tenant.

**Role ceiling.** Creating, revoking, and removing all use `canAssignRole`: only Owners grant or
affect Owner, nobody acts above their own role, and `membership.manage` is required.

**Email delivery.** The API emits `membership.invited` with identifiers only. The worker
revalidates that the invitation belongs to the event's organization, derives the token
deterministically (`HMAC(EMAIL_TOKEN_SECRET, "eventhub:invitation:v1:" + eventId)`, domain-separated
from verification tokens, retry-stable per ADR-0008), binds its hash to the pending invitation,
and emails a fragment link. Re-issuing replaces the hash, so only the newest link works.
Organization names are sanitised for the subject line.

**Acceptance.** `POST /v1/invitations/accept {token}`:

1. The organization is resolved **from the token on the server** (`invitation_resolve`); clients
   never name the tenant.
2. The signed-in user must be **email-verified** and their address must **equal the invited
   address**. A forwarded or leaked link is useless to any other account.
3. Inside a transaction scoped to that tenant, the invitation row is locked and re-checked
   (pending, unexpired), the membership is created (or a _removed_ one is reactivated with the
   invited role; a _suspended_ one is refused), and the invitation is marked accepted, with audit
   and outbox records.

**Removal.** Sets the membership to `removed`. Access ends on the caller's next request, because
every request re-resolves membership. All active Owner rows are locked first, so the **last Owner
can never be removed**, even under concurrent removals.

**Members listing.** Member emails come from a tenant-bound `SECURITY DEFINER` function that
refuses any organization other than the current tenant context. `app_user` stays self-visible
only.

**Privacy.** Audit metadata stores masked addresses (`a***@example.com`). Outbox payloads carry
identifiers only.

## Consequences

- An invitee without an account signs up and verifies first. The front-end should keep the
  invitation token across that flow. The API needs nothing extra.
- Not yet built: changing an existing member's role, resending an invitation without revoking it,
  seat limits (plan entitlements, Phase 4), and revoking pending invitations automatically when
  the inviter is demoted. Today an invitation stays valid if its inviter later loses rights.
  It was within their authority when created, and an Owner or Admin can revoke it.
- Invitation rows are kept indefinitely until a retention policy exists (D9).
