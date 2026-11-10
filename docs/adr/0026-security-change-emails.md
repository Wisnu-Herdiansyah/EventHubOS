# ADR-0026: Email Owners when security settings change

- Status: accepted
- Date: 2026-11-10
- Builds on: ADR-0024 (requiring two-step verification), ADR-0008 (outbox email delivery)
- Threat model: T49

## Context

An Admin can turn the two-step verification requirement on or off (ADR-0024). Before this ADR,
the change was only recorded in the audit log. A misused Admin account, or a stolen one, could
weaken the organization's protection without the Owners noticing.

## Decision

**Event.** When `PATCH /v1/organizations/:id` really changes `requireMfaForAdmins`, the same
transaction enqueues `organization.security_changed`, with payload
`{ organizationId, setting: 'requireMfaForAdmins', value }`.

- The current value is read under the row lock, so sending the same value again announces
  nothing.
- The event sits alongside the existing `organization.updated` event and audit record.

**Consumer** (`organization.send_security_changed_email`). It emails every active Owner with a
verified email address.

- **Content.** The email says who made the change, what it means for Owners and Admins, and
  links to Settings and the audit log. It contains nothing secret.
- **Organization check.** The organization comes from the event envelope. A payload that names a
  different organization is ignored.
- **Delivery.** There is one message per recipient (`messageId = eventId-userId`), so each is
  deduplicated on its own. The consumer ledger prevents a second run from sending again.

**Storage access** (migration 0017). The worker has no tenant context. A new `SECURITY DEFINER`
function, `organization_security_contacts(org)`, returns only the organization's name and its
active, verified Owners. It is granted to the worker role only.

## Alternatives

- **Email Admins too**: the people most likely to make the change would mostly be told about
  their own action. Owners are the accountable role.
- **Email every settings change**: noisy. Only security settings are announced. The event
  carries a `setting` field so future security settings can use the same email.
- **Digest instead of immediate email**: a takeover should be noticed quickly.

## Consequences

- Owners learn about the change within one worker cycle and can reverse it from Settings.
- Owners cannot opt out yet. Notification preferences can add that later; security notices are a
  likely candidate to stay mandatory.
