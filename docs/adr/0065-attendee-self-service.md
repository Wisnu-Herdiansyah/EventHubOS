# ADR-0065: Attendee self-service

- Status: accepted
- Date: 2026-11-17
- Builds on: ADR-0023 (registration and the emailed link), ADR-0041 (registration questions),
  ADR-0064 (registration approval)

## Context

People mistype their name or change an answer (a diet, a company) after registering. Today only
the organizer can fix that, by hand, from an email the person sends them. Each registration email
already carries a personal link that can cancel the registration; holding it already means
control over the entry.

## Decision

With **the same personal link**, a person can **correct their own name and answers** on a new
page of the event site, `/manage-registration`.

### What can and cannot change

| Can change                             | Cannot change                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Their name                             | Their **email address**: it is who they are to the organizer, and moving it would bypass the one-registration-per-address rule |
| Their answers to the event's questions | Their status, seat, ticket or check-in                                                                                         |

Answers are checked against the event's **current** questions, exactly as at sign-up, and replace
the earlier answers. An answer to a question the organizer has since removed is dropped.

### When the link works

For a registration, a waitlist place or a request waiting for approval, while the event is
published or live, not cancelled and **not yet ended**. Unknown, cancelled, declined and closed
links all get the same answer. The page shows the person's name and answers, never their email.

### The email

Every registration email (confirmed, waitlisted, request received, approved, promoted) adds one
line after the cancel link:

> Need to correct your name or answers? https://{handle}.{domain}/manage-registration#token=…

The cancel link stays first and works as before. Both carry the same token, in the URL fragment,
so it never reaches a server log; the page removes it from the address bar, is `no-index`, and
sends no referrer.

### What organizers see

- The corrected details, in the list, export and check-in.
- "Details changed {date}" under the person's name (`registration.details_updated_at`).
- An audit entry, `registration.details_changed`, naming **which fields** changed, never their
  values, as for other attendee data.

Saving the same details again changes nothing and records nothing.

## Tests

- **Integration (10):** the email link and its position; details shown without the email;
  saving with trimming, emptied answers, the change time and the audit; saving unchanged details;
  validation of answers and names, and the email refused; waitlisted and pending entries;
  unknown, cancelled, declined, ended and cancelled-event links; one entry changed and not its
  neighbours or another organization; the database refusing closed entries on its own; the worker
  role refused.
- **Browser:** register, open the link, see the current details, a field error, save, then the
  organizer sees the change.
- **Mutation checks:** 17 changes to the link rules (in both functions), the change detection,
  the update's own condition, the audit and the email line; all caught after the tests were
  tightened. One survivor would have let a save overwrite **every registration in the
  organization**: the test now checks a neighbour at the same event.

## Limits

- **No email when details change.** The person made the change themselves, on a page that
  confirms it.
- **The organizer is not notified** beyond the list and the audit log.
- **No change after the event ends**, when the details no longer matter.
