# ADR-0027: Download the attendee list as CSV

- Status: accepted
- Date: 2026-11-10
- Builds on: ADR-0023 (free registration)
- Threat model: T50–T51

## Decision

People with `registration.export_pii` can download an event's attendee list as a CSV file. Today
that is Owners, Admins and Registration managers. Event managers can see and cancel registrations
(`registration.manage`) but cannot take a copy away.

**API.** `POST /v1/organizations/:org/events/:event/registrations/export` takes an optional
`status` filter and returns the registrations oldest first.

- **Size.** At most 10,000 rows. `truncated` says when more exist; larger events will need a
  background export.
- **Method.** It is a POST because it writes an audit record, `registration.exported`, on the
  event. The record holds who exported, the row count, the filter and whether the list was cut
  off. It never names attendees.
- **No replay storage.** It takes no idempotency key (`idempotencyExempt`). The response is
  personal data and must not be stored in the idempotency table. A retry is simply another
  audited export.

**Admin.** The Attendees card has a "Download CSV" button. It is a plain form POST to a route
handler, so the browser downloads the file and stays on the page. The current filter (All,
Registered, Cancelled) applies. The handler:

- refuses cross-site requests. Browsers send `Sec-Fetch-Site`, and it must be `same-origin`.
  Clients without it must send an `Origin` matching the host. `Origin` alone is not enough,
  because under this app's `Referrer-Policy: no-referrer` browsers send `Origin: null` on form
  posts;
- formats the file:
  - CSV per RFC 4180 (CRLF, quoting) with a UTF-8 BOM so spreadsheets read non-ASCII names;
  - times in the event's time zone, which is named in the column headers;
- neutralises formulas. Any cell starting with `= + - @`, tab or carriage return gets a leading
  apostrophe, so a name like `=HYPERLINK(...)` shows as text instead of running;
- returns `Content-Disposition: attachment`, `Cache-Control: no-store` and `nosniff`.

The audit log shows "Downloaded the attendee list of …" with the count.

## Alternatives

- **Build the CSV in the API**: the route layer is JSON-first, and the format is a presentation
  concern. The API stays the single place for permission and audit.
- **A GET link**: simpler, but a GET that writes an audit record could be triggered from other
  sites, for example through an image tag.
- **Excel (.xlsx)**: heavier, and CSV opens everywhere.

## Consequences

- Copies of attendee data can now leave the platform. Who took one, and when, is in the audit
  log; retention of exported files is the organizer's responsibility (policy D9).
- Large events need a background export with an emailed, expiring link later.
