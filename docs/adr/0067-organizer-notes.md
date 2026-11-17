# ADR-0067: Organizer notes on registrations

- Status: accepted
- Date: 2026-11-17
- Builds on: ADR-0023 (registration), ADR-0027 (export), ADR-0028 (check-in), ADR-0041
  (registration questions), ADR-0065 (attendee self-service)

## Context

Organizers keep side notes about attendees ("VIP", "needs step-free access", "paid by
invoice") in spreadsheets, which drift from the attendee list and leave the door team without
them. Registration questions (ADR-0041) hold what the **person** tells the organizer; nothing
held what **staff** know.

## Decision

Each registration can carry **one private staff note**.

### The note

- Plain text, **up to 500 characters**, line breaks kept. Other control characters are refused.
  Line breaks sent as CRLF (as browsers send them from a text box) are stored as plain line
  breaks; the browser test found this.
- Trimmed; an **empty note clears it** (stored as NULL, never an empty string).
- On **any entry**: registered, waitlisted, waiting for approval, declined or cancelled.
- Who last changed it, and when, is kept (`staff_note_updated_by`, `staff_note_updated_at`).

### Who sees it

| Staff (`registration.manage`)                                                    | Door staff (`attendee.checkin`)              | The person and the public |
| -------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------- |
| Attendee list, with an Add/Edit note dialog                                      | Next to the name in check-in search and scan | **Never**                 |
| CSV download (`registration.export_pii`), "Staff note" column before the answers |                                              |                           |

Showing the note at the door is deliberate: access needs and VIP handling are door business.
The answers to the registration questions stay off the door list as before (ADR-0041). The
dialog says so: "Only staff see this: in this list, the download and at check-in. Never the
attendee." Staff should write only what the door may see.

The person's own page (ADR-0065), every email and the public site never include the note; the
public database functions do not select it.

### The API

`PATCH /v1/organizations/{organizationId}/events/{eventId}/registrations/{registrationId}/note`
(`setRegistrationNote`), `registration.manage`, Idempotency-Key, body `{ "note": "…" }`.

- The entry is looked up by the server-resolved organization **and** this event, under RLS;
  another organization's or another event's entry is 404.
- The same note again changes nothing and records nothing.
- Audit `registration.note_changed` with `{ eventId, cleared }`: **that** the note changed,
  never **what** it says, as for other attendee data.
- No email, no outbox event: nothing leaves the system.

### The database (migration `0037`)

Expand-only: three nullable columns on `eventhub.registration`, column-level `UPDATE` for the
API role only, and checks that a note is 1–500 characters or NULL and that the change time and
author are set together.

## Tests

- **Integration (9):** note shown in list, export and at the door, not its answers; audit
  without the text; the same note records nothing; empty and blank clear; neighbours untouched;
  cancelled and pending entries; validation (500 vs 501, CRLF and CR kept as line breaks, tab
  and other control characters, wrong type, extra field, no key); replay and key reuse;
  permissions and other organizations and events; never on the person's own page or in their
  emails, and a self-service save leaves it alone; the worker role refused, the API role
  without the tenant changes nothing, and the database checks.
- **Unit:** the CSV column, including formula protection for a note starting with `=`.
- **Browser:** add a note with a line break, see it in the list and at check-in, edit it to
  empty to remove it; accessibility scans.
- **Mutation checks:** 12 changes (clearing, the unchanged case, the audit leaking the text or
  the wrong `cleared`, trimming, the length, the control-character rule, line-break handling,
  the DTO, the update's own condition, the author): all caught.

## Limits

- **One note per entry**, not a thread or history. The audit log shows when it changed and by
  whom.
- **Not searchable** at the door or in the list; search stays by name and email.
- **No notes on people across events**: a note belongs to one registration.
