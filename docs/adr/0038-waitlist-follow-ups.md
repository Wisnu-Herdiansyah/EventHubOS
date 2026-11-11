# ADR-0038: Waitlist follow-ups: a size limit, and closing the waitlist

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0035 (waitlist)

## Decision

Two gaps left by ADR-0035 are closed.

**1. A waitlist limit.**

- `settings.registration.waitlistLimit` (1–10,000) is optional, and needs the waitlist turned
  on (`400` otherwise).
- Once that many people are waiting, the event is simply full again: the public page says so,
  and sign-ups get `409 event_full`.
- When someone leaves the waitlist or gets a seat, there is room again.
- The count is of the **open** waitlist (see below), checked by `waitlist_has_room()` under the
  same event row lock as sign-ups.

**2. Closing the waitlist.** Once registration for an event has closed, everyone still waiting
gets **one** email: "The waitlist has closed: <event>", saying no seat became free.

- **When:** registration has closed when its closing time has passed (the event's end if none
  was set), or the event has ended or been archived.
- **Taking an event offline** (back to scheduled) does not close the waitlist: that is usually
  temporary.
- **The worker's pass:** once a minute, `waitlist_closing()` locks a batch with `SKIP LOCKED`
  (so several workers never take the same person); the worker emails each person and marks them
  `waitlist_closed_at`.
- **Failure and retry:** if a send fails, the batch rolls back and is retried on the next pass.
  The message ID is fixed per person (`waitlist-closed-<registration>`), so the provider never
  delivers a second copy.
- **Their status stays `waitlisted`:** they never had a seat, so report figures are unchanged.
  They are no longer counted as waiting, do not take up a place under the limit, and are
  **never promoted** if a seat frees up later (for example, after the organizer moves the
  closing date). Organizers can still give one of them a seat by hand.
- **Admin:** they are shown as "Waitlist closed".

## Alternatives

- **Cancel them** (`status = cancelled`). It frees their address for a new sign-up, but it
  would count people who never had a seat as cancellations in reports, and their leave link
  would say "cancelled".
- **Close from lifecycle changes only** (ended, archived). Most events close registration by
  time, without anyone pressing a button, so a time-based pass is needed anyway.
- **One outbox event per person, from a scheduler.** More moving parts for a once-a-minute
  check. A locked batch with stable message IDs gives the same guarantees.

## Consequences

- The worker now does two things on its loop: relaying the outbox, and closing waitlists
  (checked once a minute, in batches of 100).
- People are told when registration closes, not the moment the event fills up.
