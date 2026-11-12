# ADR-0047: Audit log export

- Status: accepted
- Date: 2026-11-12
- Builds on: ADR-0013 (audit log viewer), ADR-0027 (attendee CSV export), ADR-0045 (support
  access)
- Threat model: T4 (updated), T77 (new)

## Decision

Owners and Admins can download the audit log as a CSV file, using the filters they have on the
page.

### API

- `POST /v1/organizations/{organizationId}/audit-events/export` (`exportAuditEvents`).
- It needs `audit.read`, checked in service code (`withOrganization`) and by RLS. Other
  organizations get 404, as for the list.
- The body takes the list's filters: `action`, `actionPrefix`, `actorId`, `targetType` with
  `targetId`, `from` and `to`. They are validated by the same rules as the list. Paging fields
  (`limit`, `cursor`) and unknown fields are refused with 400.
- It returns up to **10,000 entries**, newest first, with the organization's time zone and a
  `truncated` flag. The server reads one extra row to know whether more match.
- **Every export is audited** as `audit.exported`, with the number of entries and the names of
  the filters used (never their values). The entry is written after the read, so a file never
  contains its own export.
- **Support access cannot export** (403 `support_read_only`). Support may read the log to help
  (ADR-0045) but not take a copy of it.
- The route is a POST so that it is never cached or prefetched, and so that the admin can refuse
  cross-site requests. It is a read, so it needs no idempotency key. The limit is 10 exports a
  minute per address.

### Admin

- The Activity card has a **Download CSV** button. It posts the page's current filters to a
  same-origin route handler, `orgs/[orgId]/audit/export`. The handler refuses cross-site posts
  (Sec-Fetch-Site and Origin), as the attendee export does.
- The file is `audit-log-YYYY-MM-DD.csv`, dated in the organization's time zone. Its columns:
  - **When**, in the organization's time zone;
  - **Who**;
  - **What** and **Details**: the same plain-language text as the page;
  - **Action**, **Object type** and **Object ID**: the raw values, for filtering in a
    spreadsheet;
  - **Data**: the stored metadata as JSON (already minimised, for example masked invitee
    addresses);
  - **Reference**: the correlation ID.
- Every cell goes through the shared CSV writer, which neutralizes spreadsheet formulas.
- Responses are `no-store` and `nosniff`. The button is hidden under support access, and a
  refused export returns to the page with a notice.

## Alternatives

- **A background export with an emailed, expiring link.** It is needed for very large logs, and
  needs object storage (D1, D7). The 10,000-entry cap with date filters covers the first
  release. The page says so.
- **Streaming the whole log.** It holds a transaction open for an unbounded time, and makes
  every export a possible denial of service.
- **JSON or a signed archive.** Signing and off-database archiving remain the T4 residual.
  People who ask for the log want a spreadsheet.
- **A GET link, as for the report CSV.** Report CSVs hold counts only and are not audited. A
  copy of the audit log is evidence about people, so it gets the same POST, origin check and
  audit as the attendee export.

## Consequences

- Organizations can hand their audit evidence to auditors without asking us.
- Exports appear in the log they copy, so a quiet bulk copy is visible to the other Owners and
  Admins.
- Logs above 10,000 entries for a filter need narrower date ranges until the background export
  exists.
