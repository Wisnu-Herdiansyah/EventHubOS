# ADR-0034: Report periods and CSV download

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0032 (organization reports), ADR-0027 (CSV handling)
- Threat model: T57, T62

## Decision

The organization Reports page can show a **period**, and its events table can be **downloaded
as CSV**. Both show counts only, as before.

**Period.** A period is a range of calendar days in the organization's time zone, inclusive at
both ends:

| Choice       | Days                                                    |
| ------------ | ------------------------------------------------------- |
| All time     | No range (the default, and the previous behavior)       |
| Last 30 days | Today and the 29 days before it                         |
| This year    | 1 January to 31 December of the current year            |
| Last year    | The previous calendar year                              |
| Custom       | Any `from` and `to` from 2000 to 2099, with `from ≤ to` |

"Today" is taken in the organization's time zone, not the server's or the browser's.

**API.** `GET /v1/organizations/:org/report?from=YYYY-MM-DD&to=YYYY-MM-DD`:

- Both or neither. A missing end, a reversed range, an impossible date (30 February) or an
  unknown parameter is a `400 validation_failed`; nothing is guessed.
- The **events and totals** are those of events that **start** on the period's days in the
  organization's time zone. An event at 23:30 on 1 March in Jakarta belongs to 1 March, even
  though it is 16:30 UTC.
- **Sign-ups by month** cover the months of the period. They count sign-ups **made** during the
  period, for any event, so the chart answers "when did people sign up". A period longer than
  24 months shows its latest 24, with `monthsTruncated`. Without a period the chart is the last
  12 months, as before.
- The response echoes `period` (`null` for all time).
- Each figure is still one aggregate query under the tenant guard and RLS.

**Admin.**

- Preset links, plus a custom form with two date fields. These are plain GET links and a GET
  form, so a period can be bookmarked and shared.
- An invalid period in a link shows a warning and all time; it is never quietly narrowed.
- **Download CSV** is a plain link to `/orgs/:org/reports/export` with the same period. It is not
  a `next/link`, because prefetching would fetch the file. The route handler calls the same API,
  so `report.read` and tenancy are checked there. A refused request goes back to the page, and a
  lapsed session goes to sign-in. An invalid period is refused, not widened to all time.
- **Columns:** Event, Starts (organization time), Status, Registered, Capacity, Cancelled,
  Checked in, Attendance %. Attendance is blank until an event has ended.
- **File:** `events-report-<from>-to-<to>.csv`, or `events-report-all-time-<today>.csv`, sent
  with `Cache-Control: no-store` and `nosniff`.
- **Cell handling:** the same as the attendee export (ADR-0027): formula neutralizing, quoting,
  a byte order mark and CRLF line endings. Event names are typed by staff, but a cell must still
  never run as a formula.

**No audit entry.** The attendee export is audited because it holds personal data. This file
holds the same counts the page shows, to the same people, so a download is a read like any page
view. It is a GET because it changes nothing.

## Alternatives

- **Filter by registration date instead of event start.** Totals would then mix events across
  periods, and "attendance in Q1" would not mean the Q1 events. Event start is how organizers
  think about a period; the month chart covers the sign-up view.
- **Generate the CSV in the API.** It would be a second representation of the same data. The
  admin app already owns CSV formatting and its tests.
- **Include a totals row in the CSV.** Spreadsheets sum the columns themselves, and a non-data
  row breaks sorting and filtering.

## Consequences

- The list and the CSV are still capped at 500 events per period. A shorter period shows fewer
  rows, so the cap matters less.
- A period with no events shows an empty state, and no download is offered.
