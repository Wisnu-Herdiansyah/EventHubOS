# ADR-0062: Event reminder emails

- Status: accepted
- Date: 2026-11-16
- Builds on: ADR-0023 (registration), ADR-0038 (waitlist closing sweep), ADR-0043 (bounces and
  complaints), ADR-0050 (event cancellation)

## Context

People register weeks ahead and forget. Organizers could send an announcement by hand
(ADR-0036), but a reminder the day before is the one message nearly every event wants, and it
should not depend on someone remembering to send it.

## Decision

Everyone with a **confirmed seat** gets **one reminder email in the 24 hours before the event
starts**. It is on by default; an organizer can switch it off per event.

### Who is reminded

A person is due when all of these hold:

- their registration is confirmed (not cancelled, not on the waitlist) and not yet reminded;
- the event is published or live, and **not cancelled**;
- the event starts within the next 24 hours and has not started;
- they registered **before** the 24-hour window opened. Someone who signs up inside it has just
  received a confirmation, and a second email minutes later would be noise;
- the event's reminder switch is not off.

If an event is moved closer, or the switch is turned back on, people become due at the next pass.
If the worker was down, the reminder goes out late rather than not at all, until the event starts.

### The email

Name, event name, start time in the event's own time zone, a link to the public event page, and
the organization's name. **No personal link.** The ticket and cancel links live in the
confirmation email, and only their hash is stored (ADR-0023): issuing new ones here would stop the
confirmation's links from working. The reminder says where to find them.

### The switch

`settings.registration.reminder`, a boolean. **Unset means on**; only "off" is stored. The admin
form shows a checked box, "Email a reminder the day before", with a note on who receives it.

### How it runs

As the waitlist-closing sweep does (ADR-0038), once a minute in the worker:

1. `event_reminders_due(limit)` returns a batch of people who are due and locks them. Rows locked
   by another worker are skipped, so a second worker never waits and never duplicates.
2. Each person is emailed, then marked with `event_reminder_mark` (`registration.reminded_at`).
3. If a send fails, the whole batch rolls back and is retried on the next pass. The message ID is
   fixed per registration, so the provider does not deliver a second copy of one that went out.

Both functions are for the worker role only, which still cannot read the registration table
directly. Marking requires the registration's own organization.

### Bounces and complaints

The reminder is organizer mail (ADR-0043): it is not sent to an address that bounced or
complained. That person is still marked, so the sweep does not retry them every minute.

## Tests

- **Integration (13):** content and time zone; the 24-hour window on both sides and an event moved
  closer; sign-ups inside the window; confirmed seats only; every lifecycle and a cancelled event;
  the switch off, on, unset and turned back on; a failed send (nobody marked, then exactly once);
  two workers at once; a held batch is skipped without waiting; no site address; the
  organization check on marking; both functions refused to the API role.
- **Unit:** the setting accepts only a boolean, in the registration section; the email class.
- **Browser:** the switch is on by default, saves off and on again, and keeps the other
  registration settings.
- **Mutation checks:** 19 changes to the due rules, the marking and the worker, all caught.

## Limits

- **One reminder, 24 hours.** No choice of lead time and no second reminder yet. Both fit the same
  mechanism if wanted.
- **English only**, like the other emails.
- **No per-person opt-out** beyond cancelling or the provider's complaint handling. A reminder
  about a booking the person made is expected mail; an unsubscribe link for organizer mail is a
  separate, wider decision.
- **Very large events** are sent 100 people per worker pass, once a minute per worker: about
  6,000 an hour. Enough for now; the batch size is a parameter.
