# ADR-0035: Waitlist

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0023 (free registration), ADR-0028 (check-in), ADR-0029 (QR tickets)
- Threat model: T63, T64

## Decision

An event with a capacity can take a **waitlist**. When it is full, a public sign-up joins the
waitlist instead of being refused. Freed seats go to the people waiting, in the order they
joined, automatically. Organizers can also give someone a seat by hand.

**Setting.** `settings.registration.waitlist` (boolean). It needs a capacity, or the update is
refused (`400`, field `settings.registration.waitlist`). It is off by default, so a full event
refuses sign-ups as before.

**States.** A registration is `confirmed`, `waitlisted` or `cancelled`.

- One live entry (`confirmed` or `waitlisted`) per address per event, enforced by a unique index.
- Promotion keeps `created_at`, which is the joining time, and records `promoted_at` and
  `promoted_by`: `waitlist` (automatic) or `organizer`.

**Joining.** `public_register` takes the event row lock as before.

- When the event is full and takes a waitlist, the visitor is added with status `waitlisted`.
- An address that is already waiting counts as already registered: the waitlist email is sent
  again, at most once every 10 minutes.
- The HTTP answer is byte-identical in every case (registered, waitlisted, already either), so
  the form never reveals whether an address was known. The public page knows the event state
  (`waitlist`) and words the form accordingly.

**Promotion.** `fill_waitlist(org, event)` hands out free seats:

- **When:** it runs in the same transaction as anything that frees seats: an attendee
  cancelling with their link, an organizer cancelling, or a larger or removed capacity.
- **Order:** oldest first; with no capacity, everyone waiting gets a seat.
- **Lock:** it takes the event row lock that sign-ups take, so a new visitor and a waiting
  person can never both get the last seat. Every path that changes seats locks the event first,
  then the entry, so promotion and cancellation cannot deadlock.
- **Window:** promotion happens only while registration is running (published or live, before
  it closes). After that, people stay waiting.
- **Tenancy:** it runs as the caller under RLS, so from another organization's context it finds
  nothing.

**Organizer promotion.** `POST …/registrations/:id/promote` (registration.manage) gives a
waiting person a seat out of turn, **even beyond capacity**: the organizer's explicit choice,
for a speaker or a sponsor. The dialog says when it goes over capacity, and the audit entry
records `overCapacity`.

**Emails** (through the outbox, as before). Each is sent only while the entry is still in the
state it announces. A waitlist email whose person was promoted before it went out is skipped;
the promotion email follows.

| Email           | When                                  | Contains                                                                        |
| --------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| On the waitlist | Joining (and a repeat sign-up)        | A link to leave the waitlist; **no ticket**                                     |
| A seat opened   | Promotion (automatic or by organizer) | The ticket (ADR-0029) and a fresh cancel link, which replaces the waitlist link |
| Left / removed  | Leaving with the link, or removal     | Worded for the waitlist, not as a cancelled registration                        |

**Elsewhere.**

- **Check-in:** a waiting person cannot be checked in (`registration_waitlisted`), and a scanned
  ticket says so.
- **Reports:** they count only `confirmed` and `cancelled`.
- **Attendee export:** labels them "On the waitlist".
- **Admin:** a Waitlist filter (in joining order) with Give a seat and Remove, a Waitlist tile,
  and "Registered from waitlist" on promoted attendees.

**Expand-only migration 0021.**

- The status check is replaced by a wider one; old code still writes valid rows.
- Functions whose results changed got new names: `registration_issue_link_token` and
  `public_leave_registration`. The old ones stay until a contract migration.

## Alternatives

- **Offer a seat for a limited time** (claim within 24 hours, else the next person). It is fairer
  when people's plans change, but it needs scheduled expiry, reminder emails and a claim page.
  Free events rarely need it; revisit with paid ticketing.
- **Promotion only by organizers.** Organizers would have to watch for cancellations, and seats
  would sit empty overnight.
- **A separate waitlist table.** Joining, leaving and getting a seat would move rows between
  tables. One table with a status keeps the uniqueness rule, the cancel link and the audit trail
  in one place.

## Consequences

- A cancellation can now send two emails: the cancellation, and the next person's seat.
- The waitlist has no size limit beyond the public rate limit; a cap can be added to the setting
  if abuse appears.
- When registration closes, people still waiting are not told. A "the waitlist has closed" email
  is a follow-up.
