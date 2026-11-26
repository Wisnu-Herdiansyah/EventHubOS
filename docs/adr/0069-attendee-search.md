# ADR-0069: Searching the attendee list

- Status: accepted
- Date: 2026-11-26
- Builds on: ADR-0023 (registration list), ADR-0027 (export), ADR-0043 (undeliverable email),
  ADR-0067 (staff notes)

## Context

The Registrations page lists up to 1,000 people with status filters. Finding one person meant
scrolling or using the browser's find, which misses staff notes and the rows beyond the first
page. Check-in already has a door search (ADR-0028), but it shows only registered people and
needs `attendee.checkin`.

## Decision

The attendee list and its download take an optional **search**, `q`.

- **What it matches:** part of the **name**, the **email address** or the **staff note**,
  ignoring case. Not the answers to registration questions (ADR-0041), which are free-form and
  often personal.
- **Plain text:** 1 to 100 characters of one line, trimmed. `%`, `_` and `\` match themselves,
  never as wildcards.
- **Together with the status filter**, in the list and the download.
- **Same permissions:** the list needs `registration.manage`, the download
  `registration.export_pii`. The organization and event come from the server, so a search
  never reaches another organization or event.
- **The audit for a download** records `searched: true` or `false`, **never the search
  text**, which could itself be personal data (a name or an address).

### Admin

- A "Find an attendee" box above the filters ("Name, email or staff note"), a plain `GET`
  form, so a search can be bookmarked and the back button works.
- The filters keep the search, the search keeps the filter, and "Clear search" removes only the
  search.
- "2 people match “ada”." above the list. At the list's cap of 1,000, "1000 or more people
  match …", since the list does not know how many more there are.
- "No one matches “…”" when nothing is found.
- **Download CSV holds exactly what is shown:** the filter and the search.

### Fixed on the way: downloads from the Waitlist, Requests and Declined views

The download handler passed on only the Registered and Cancelled filters. From the Waitlist,
Requests or Declined view, "Download CSV" silently gave **everyone**. It now passes every
filter. The browser test covers it, and fails against the old handler.

### No index

Lists are per event and capped at 1,000 (10,000 for a download); the scan runs inside one
event's rows, as the door search does. An index for `ILIKE '%…%'` would need `pg_trgm`, which
is not worth it at this size.

## Tests

- **Integration (6):**
  - matches by name, email and staff note, ignoring case;
  - combined with the status filter;
  - `%`, `_` and `\` match themselves;
  - validation (empty, blank, 101 characters, line breaks, tabs);
  - the download holds exactly the matches, and its audit says only `searched`;
  - permissions, other organizations and other events.
- **Unit:** URL parsing, links that keep the filter and search together, and the result count.
- **Browser:** search, see the count, switch filter keeping the search, download only what was
  found, nothing found, clear the search, and a Waitlist download holding only the waitlist.
- **Mutation checks:** 11 changes (escaping, each matched field, case, the list and download
  parameters, the audit flag, each validation rule): all caught.

## Limits

- **No search in answers** to registration questions.
- **No fuzzy matching** ("Wisnu" does not find "Wisnoe").
- **Actions return to the list without the search.** After cancelling, approving or saving a
  note, the page shows the filter but not the search.
