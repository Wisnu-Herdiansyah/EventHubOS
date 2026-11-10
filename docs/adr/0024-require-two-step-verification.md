# ADR-0024: Require two-step verification for Owners and Admins

- Status: accepted
- Date: 2026-11-09
- Builds on: ADR-0022 (two-step verification), ADR-0012 (organization settings)
- Threat model: T46–T47

## Decision

An organization can require two-step verification for its **Owners and Admins**. These are the
roles that can change membership, settings and the organization's security posture. The setting
`requireMfaForAdmins` is off by default.

**Changing it.**

- It is part of `PATCH /v1/organizations/:id` and needs `organization.manage`.
- Turning it on is refused (409 `actor_mfa_required`) unless the caller has two-step verification
  active. A started but unconfirmed enrolment does not count. This stops someone locking
  themselves out in the same request.
- The change is audited as `organization.updated` with `{ fields, requireMfaForAdmins }`. The
  audit log shows it as a sentence ("Required two-step verification for Owners and Admins").

**Enforcing it.** The check is in `withOrganization`, the shared guard that every tenant route
already uses to resolve membership, so no route can forget it:

1. Look up the caller's active membership and the organization's setting in one query.
2. Deny by permission as before.
3. If the role is Owner or Admin (`roleRequiresMfa` in the kernel) and the setting is on, check
   `auth_mfa_required(user)`. If the caller has no active factor, refuse with 403 `mfa_required`.

The only exception is `GET /v1/organizations/:id`. It still answers, with
`mfaSetupRequired: true`, so the admin can explain the block. It opts in explicitly with
`allowMfaBlocked`. Writes, including `PATCH` of the same organization, stay closed.

The check runs on every request. Turning two-step verification on lifts the block straight away.
Turning it off, or the organization dropping the requirement, takes effect the same way.

**Admin.**

- Settings has a Security card with the checkbox. If the person editing has not set up two-step
  verification, the card says so and links to their account.
- Any page that gets `mfa_required` redirects to `/two-step-required?org=…`. That page explains
  the requirement and links to the account page's two-step section. Once the person is set up,
  it sends them back into the organization.

Other roles (Billing admin, Event manager, Content editor, Registration manager, Analyst,
Viewer) are not affected.

## Alternatives

- **Check at sign-in**: blocks the whole account, including organizations that do not require
  it, and misses sessions that already exist. Checking per organization, per request, is exact.
- **Grace period before enforcing**: kinder to people who are mid-setup, but leaves the riskiest
  accounts unprotected for an unknown time. Not needed while setup takes a minute; it can be added
  as a deadline column later.
- **Require it for every role**: heavier for occasional helpers such as Viewers. It could become
  a second option later.

## Consequences

- An Owner or Admin who turns their own two-step verification off loses access to organizations
  that require it until they turn it on again. They can always do that from their account, so
  nobody is locked out for good, including the last Owner.
- Organizations are not told which Owners and Admins still need to set it up. Showing that on
  the Team page needs a membership-scoped view of factor status, planned separately.
- Changes to the setting are audited, and Owners are emailed about them (ADR-0026).
