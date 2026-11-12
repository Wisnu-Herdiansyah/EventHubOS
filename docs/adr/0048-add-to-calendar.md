# ADR-0048: Add to calendar

- Status: accepted
- Date: 2026-11-12
- Builds on: ADR-0021 (public sites), ADR-0023 (registration), ADR-0029 (tickets)
- Threat model: T78 (new)

## Decision

Attendees can add an event to their calendar with an iCalendar file (RFC 5545). No provider is
involved.

### Where it appears

- An **Add to calendar** link under the date on the public event page.
- The same link on the ticket page.
- An "Add it to your calendar" line in the registration confirmation email (new, repeat and
  promoted). The waitlist email has none, because a waitlisted person has no seat yet.
- Every link points to `https://{handle}.{domain}/{slug}/calendar.ics` on the event's own site.

### The file

- **One `VEVENT`**: name, start, end, the event page URL, and the sharing description if there
  is one.
- **Times** are exact instants in UTC. Calendar apps show them in the viewer's own zone, which
  is right for people travelling to the event or joining online. The description also gives the
  local start and the event's zone, e.g. "Starts 1 Mar 2027, 09:00 (Asia/Jakarta)". We do not
  ship `VTIMEZONE` definitions, which would have to track time-zone rule changes.
- **Location** is "Online" for virtual events and "In person and online" for hybrid ones. Events
  have no address field yet, so in-person events have no location.
- **UID** is a one-way digest of the event ID: `sha256("eventhub-calendar:" + id)`, 32 hex
  characters, `@eventhub`. It is stable when the event is renamed or its slug changes, and it
  does not publish the event's internal ID.
- **SEQUENCE** is the event's version minus one, so it rises with every change. A calendar that
  imports the file again updates the existing entry instead of adding a second one.
- Every text value is escaped, and lines are folded at 75 octets without splitting a character.
  Names with commas, semicolons, line breaks or non-ASCII text cannot break the file or add
  properties (unit-tested, including an injection attempt).

### Data and visibility

- A new definer function, `public_event_calendar` (migration 0030), has exactly the visibility
  rules of the public page:
  - an active organization;
  - a public or unlisted event that is published, live or ended;
  - a published page.
- Everything else is the same 404 as the page. Only the app role may execute the function.
- `GET /v1/public/sites/{handle}/events/{slug}/calendar` returns the data as JSON. The site
  writes the file (a pure, unit-tested function), so the API contract stays JSON.
- The file contains nothing about the attendee, so one public URL serves everyone. It is cached
  for 5 minutes and served with `text/calendar`, `nosniff` and a sandboxing CSP.

## Alternatives

- **A subscription feed (`webcal://`) that updates automatically.** Calendar apps poll feeds on
  their own schedule, often for days. It also turns one link into a long-lived tracker of who
  still follows the event. We can add it later behind the same function.
- **Attaching the file to the confirmation email.** That needs attachment support in the
  `EmailSender` port and in the provider adapter. Attachments also raise spam scores. A link
  gives the same result.
- **Per-attendee files with the attendee as `ATTENDEE`.** That would put personal data in a URL
  and in calendar invitations. It is not needed to add the event.
- **`TZID` with `VTIMEZONE`.** It is more faithful to the organizer's wall clock, but we would
  have to maintain the definitions. UTC instants are unambiguous.
- **Google and Outlook "add event" deep links.** They send event details to third parties from
  our pages, and would need a decision on which providers to list.

## Consequences

- Attendees get the event into any calendar app with one tap.
- A changed time reaches a calendar only when the file is imported again. Telling attendees
  about changes stays with announcements (ADR-0037).
- Cancelling an event does not remove calendar entries. A future event-cancellation feature can
  publish `STATUS:CANCELLED` under the same UID.
