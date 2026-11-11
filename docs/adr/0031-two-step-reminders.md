# ADR-0031: Remind members to turn on two-step verification

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0024 (requiring it), ADR-0025 (showing who uses it)
- Threat model: T58

## Decision

People with `membership.manage` (Owners and Admins) can email a member asking them to turn on
two-step verification. On the Team page, a "Remind" button sits beside each "Off" or "Needed"
badge.

**Who can be reminded.** Any active member without an active factor, whatever their role. An
Admin may remind an Owner: a reminder changes nothing about the other person's account, and an
Owner without two-step verification is the largest risk. The API refuses:

- yourself (409 `self`);
- someone who already uses it (409 `already_enabled`);
- a second reminder to the same member within 24 hours (409 `recently_reminded`).

**How often.** At most once a day per member. Migration 0019 adds
`membership.two_step_reminded_at` for this; the member list shows managers when each member was
last reminded, and the Team page shows "Reminded today" instead of the button.

**Delivery.** The reminder is audited as `membership.two_step_reminder_sent` on the membership.
The record holds the role, never the email address. It is delivered through the outbox:

- The worker resolves the recipient with a definer function, `two_step_reminder_details`, granted
  to the worker only. It returns nothing once the person is no longer an active member or has
  turned two-step verification on, so a reminder still in the outbox never reaches someone who
  has already done it.
- The email names who asked and links to the two-step section of the Account page.
- It says what is at stake only when it applies: an Owner or Admin in an organization that
  requires two-step verification is told they cannot open the organization until it is on.
  Everyone else is told why it helps.

## Alternatives

- **Remind everyone at once**: convenient, but it could become bulk email from one click. The
  per-member button with a daily limit keeps every email deliberate. A bulk action can come with
  notification preferences.
- **Automatic reminders on a schedule**: needs opt-out handling, so it belongs with notification
  preferences.

## Consequences

- The "Needed" badge now comes with something to do about it.
- Reminder emails are rate-limited per member, so the feature cannot be used to flood someone's
  inbox from inside the organization.
