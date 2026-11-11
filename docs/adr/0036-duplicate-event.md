# ADR-0036: Duplicate an event

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0011 (event lifecycle), ADR-0020 (microsite pages)

## Decision

Organizers can copy an event into a **new draft**. Recurring events (an annual summit, a
monthly meetup) no longer need setting up from scratch.

**API.** `POST /v1/organizations/:org/events/:event/duplicate` needs `event.create`. It is
idempotent and takes:

| Field      | Meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `name`     | The new event's name                                               |
| `slug`     | Its address; the same rules as creating an event; `409` when taken |
| `startsAt` | Its start. The end keeps the original's length                     |

**What is copied, and what is not.**

| Copied                                                                | Not copied                             |
| --------------------------------------------------------------------- | -------------------------------------- |
| Time zone, format (venue mode), primary language                      | Registrations, the waitlist, check-ins |
| All settings: visibility, sharing, contact, legal, capacity, waitlist | Published page revisions               |
| The registration window, **moved by the same amount** as the event    | Lifecycle (the copy is always a draft) |
| Each page's working **draft**, as the copy's version 1                | Audit history                          |

The window keeps its distance from the event. Registration that opened 59 days before last
year's event opens 59 days before the copy, across leap years as well.

**Rules.**

- The copy is a draft, so nothing is public until someone schedules it and publishes its page.
  The draft page is copied, not the live one, so unpublished edits carry over and nothing
  appears on a site by accident.
- Any lifecycle can be copied, including archived events: last year's event is often archived.
- The source is looked up within the organization in the URL, and RLS scopes it as well. An
  event in another organization answers `404`, even for someone who is an Owner of both.
- Audited as `event.created` with `duplicatedFrom` and `pagesCopied`, and announced like any
  new event.

**Admin.** A **Duplicate…** button on the event page, for roles with `event.create`, opens a
dialog with suggestions:

- the name with its year moved forward ("Summit 2026" becomes "Summit 2027"), or "(copy)"
  added;
- the slug likewise ("summit-2026" becomes "summit-2027"), or "-copy" added, within 64
  characters;
- the same local start time a year later.

After creating the copy, it opens the new draft with a notice to check it before publishing.

## Alternatives

- **Copy attendees too.** It would carry personal data into an event they never registered
  for. Never.
- **Copy the published page.** Unpublished draft work would be lost, and the copy's page would
  look published when it is not.
- **Event templates.** A separate concept to maintain. Copying a real event covers the common
  case; templates can come later if organizations ask for blank starting points.

## Consequences

- No migration: the copy uses the existing event and page tables and grants.
- Section content is copied as-is. Assets referenced by sections will be shared by both events
  once the asset library exists (Phase 2).
