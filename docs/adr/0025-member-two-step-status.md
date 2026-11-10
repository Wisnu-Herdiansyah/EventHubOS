# ADR-0025: Show who uses two-step verification

- Status: accepted
- Date: 2026-11-09
- Builds on: ADR-0022 (two-step verification), ADR-0024 (requiring it for Owners and Admins)
- Threat model: T48

## Context

ADR-0024 lets an organization require two-step verification for Owners and Admins. Without
knowing who has set it up, turning the requirement on could hold out colleagues by surprise.

## Decision

**API.** `GET /v1/organizations/:id/members` adds `twoStepEnabled: boolean` to each member. It
appears only for callers with `membership.manage`, who decide whether to require it. Everyone
else gets the list without the field (deny by default).

- **Only a boolean**: active factor or not. No enrolment dates, recovery code counts or secrets.
  A started but unconfirmed setup counts as off.
- **Storage access** (migration 0016). `auth_mfa_factor` keeps forced RLS with no policies. A new
  `SECURITY DEFINER` function, `organization_member_mfa(org)`, returns `(user_id, boolean)` for
  that organization's members. Like `organization_members`, it returns nothing unless its
  argument equals the tenant context set by the access guard, so it cannot be pointed at
  another organization.

**Admin.**

- **Team page.** A "Two-step" column shows On, Off, or Needed (red: an Owner or Admin held out
  by the requirement).
- **Team page notice.** It names the Owners and Admins without two-step verification. Before
  the requirement is on, it links to it; after, it warns that those people can't open the
  organization.
- **Settings.** The Security card shows the same count, with a link to the Team page.

## Alternatives

- **Remind those people by email**: useful, but needs notification preferences. Planned with the
  security-change emails noted in ADR-0024.
- **Show it to every member**: colleagues' security posture is not needed for their work.

## Consequences

- Owners can see the effect of the requirement before turning it on and act on stragglers after.
- Admins can see whether Owners use two-step verification. That is intended: both roles are
  covered by the requirement and both manage membership.
