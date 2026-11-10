# ADR-0028: Event-day check-in

- Status: accepted
- Date: 2026-11-10
- Builds on: ADR-0023 (free registration), ADR-0027 (attendee export)
- Threat model: T52–T53

## Decision

Staff with `attendee.checkin` check attendees in at the door. Today that is Owners, Admins and
Registration managers; Event managers do not have it.

**Data** (migration 0018). `registration` gains `checked_in_at` and `checked_in_by`, set
together or not at all. A partial index on confirmed registrations by lowercased name serves the
door list.

**API.**

- `GET …/events/:event/check-in?q=` returns up to 25 confirmed attendees, sorted by name, with
  the confirmed and checked-in counts.
  - `q` matches part of a name or the start of an email. `%`, `_` and `\` are matched literally.
  - Control characters are refused.
- `POST …/registrations/:id/check-in` and `…/undo-check-in` change the state.
  - Both take an idempotency key, so a retried tap replays instead of failing.
  - Both lock the row before reading it, so two doors scanning the same person at the same moment
    check them in exactly once; the other gets 409 `already_checked_in`.
  - Cancelled registrations are refused (409 `registration_cancelled`). Undoing without a check-in
    is refused (409 `not_checked_in`).
  - The response holds only id, status and time, so no attendee details are stored for replay.
  - Each change is audited as `registration.checked_in` or `registration.check_in_undone`, with
    the event ID only.
- The registration summary gains `checkedIn`. Registrations, including the CSV export, gain
  `checkedInAt`.

**Admin.** The Check-in page is linked from the event and from Registrations. It is a desk built
for a busy door:

- the search box has focus when the page opens;
- a tap checks someone in, and the row updates in place, with "Checked in 09:12" in the event's
  time zone;
- a polite live region announces each change for screen readers;
- an Undo button corrects mistakes;
- the "X of Y" count updates as people arrive.

Search runs through a server action, not the address bar. Names typed at the door therefore never
reach URLs, browser history or access logs. If another door got there first, the desk says so and
refreshes the row.

## Alternatives

- **QR codes in the confirmation email**: faster at large events, but it needs a token in the
  email and a scanner. It can build on this API later.
- **Offline mode**: doors with bad signal need it eventually. It needs conflict handling, and the
  row lock and 409 responses are the server half of that.

## Consequences

- Attendance is recorded, with who checked each person in. Reports can use it later.
- Undo keeps the audit history, so a mistaken check-in is visible but correctable.
