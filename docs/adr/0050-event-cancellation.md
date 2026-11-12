# ADR-0050: Event cancellation

- Status: accepted
- Date: 2026-11-12
- Builds on: ADR-0011 (lifecycle), ADR-0023 and ADR-0035 (registration and waitlist), ADR-0037
  (announcements), ADR-0038 (waitlist closing), ADR-0048 (calendar files)
- Threat model: T80 (new)

## Decision

Organizers can cancel an event that is **scheduled, published or live**. Cancellation is
**final**: there is no undo. To run the event again, organizers duplicate it (ADR-0036).

### What cancelling does

All of this happens in one transaction:

1. The event records `cancelled_at`, `cancelled_by` and a required reason of up to 2,000
   characters (migration `0032`). The **lifecycle does not change**, so the public page stays
   reachable and can say the event is cancelled.
2. **Registration closes for good.** `registration_state` returns `cancelled` before any other
   rule. Every sign-up path goes through it: both public sign-up functions, the public state, and
   waitlist promotion (`fill_waitlist` accepts only `open` and `full`). Nobody can sign up, and
   nobody is promoted from the waitlist.
3. **Waitlisted people are marked as told.** The waitlist sweep (ADR-0038) then does not send them
   a second, different email.
4. **The attendees are emailed, if the organizer chooses.**
   - Everyone registered or on the waitlist gets the reason and "Please don't come to the venue."
   - The email is an announcement (ADR-0037), sent through the same function as organizer
     announcements. Recipients are captured at once; people who cancelled are skipped; each person
     has a stable message ID; it appears in the event's announcement history.
   - It is **not counted against the daily announcement limit**, because people must hear of it.
   - The 5,000-recipient limit still applies, and over it the cancellation is refused with
     `too_many_recipients`.
5. **Audit.** `event.cancelled` records the earlier lifecycle and how many people were emailed.
   `event.announcement_sent` records the email, marked `purpose: cancellation`.
6. **Edits are refused** with 409 `event_cancelled`, and so is a second cancellation. The
   microsite can still be edited, so organizers can explain on the page.

### What people see

- **Public page:** a banner, "This event is cancelled", with the reason, and the form replaced by
  "This event is cancelled, so registration is closed."
- **Ticket page:** the same notice.
- **Calendar file** (ADR-0048): same UID, higher `SEQUENCE`, `STATUS:CANCELLED`,
  `TRANSP:TRANSPARENT`, and "Cancelled: " in the title. A calendar that imports the file again
  marks or removes the entry.
- These come from a new definer function, `public_event_cancellation`, with the public page's
  visibility rules. The page and calendar functions keep their shape.
- **Admin:**
  - a **Cancel event** card opens a dialog with a required reason and an "Email the N people"
    checkbox, on by default;
  - after cancelling, the event shows a Cancelled badge and a notice with the reason, and the
    settings forms are hidden;
  - the audit log shows "Cancelled …" with how many people were emailed.

### Permissions

- Cancelling needs `event.publish`, like the other lifecycle changes.
- Emailing needs `communication.send` as well. No role in catalog v2 has `event.publish` without
  `communication.send`, so this second check is a deny-by-default guard for future roles.
- The app role may update only the three new event columns and `registration.waitlist_closed_at`,
  under tenant RLS.

## Alternatives

- **A `cancelled` lifecycle value.** Every public function filters on lifecycle. A new value would
  hide the page, unless each of them were rewritten. Cancellation is also not a step in the
  lifecycle: a cancelled event can still be unpublished or ended.
- **Cancelling every registration.** That loses the record of who had signed up, and it sends one
  "registration cancelled" email per person on top of the notice.
- **Undo.** Attendees will already have been told. A reopened event would confuse them and their
  calendars. Duplicating the event gives a clean start.
- **A separate cancellation email pipeline.** It would duplicate announcements: batching, skipping,
  idempotency and history.

## Consequences

- Organizers can stop an event cleanly, and attendees hear of it by email, on the page and in
  their calendars.
- Events with more than 5,000 people still waiting for news need batched announcements first. This
  is the same limit as ADR-0037.
