# ADR-0032: Organization-wide reports

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0030 (event reports)
- Threat model: T57

## Decision

A **Reports** section in the sidebar, for roles with `report.read`, shows sign-ups and attendance
across all of an organization's events. As with event reports, it shows counts only, never
attendees.

**API.** `GET /v1/organizations/:org/report` returns:

| Field            | What it holds                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Totals           | Events, registered, cancelled and checked in, across every event.                                                                                                                                                             |
| Attendance       | Checked-in out of registered, counted only for events that have ended. Upcoming events would otherwise pull the rate down.                                                                                                    |
| `signUpsByMonth` | Sign-ups per calendar month for the last 12 months, this month included, in the organization's time zone. A sign-up at 01:00 on the 1st in Jakarta counts in the new month, even while it is still the previous month in UTC. |
| `events`         | One row per event (registered, cancelled, checked in, capacity, ended), newest start first.                                                                                                                                   |

- **Size.** At most 500 event rows, with `truncated`. The totals still cover every event.
- **Queries.** Each figure is one aggregate query under the usual tenant guard and RLS. There are
  no per-event round trips.

**Admin.** The Reports page shows:

- four tiles: events (and how many ended), registered (and cancelled), checked in, and attendance
  at ended events;
- sign-ups by month, in the design system's bar-table chart;
- an events table with registered (out of capacity), checked in and attendance. Attendance shows
  "–" until an event ends. Each event links to its own report (ADR-0030).

## Alternatives

- **Date-range filters**: useful once organizations have years of events. The fixed 12-month
  window answers "how are we doing lately" without filter UI. (Added later: ADR-0034.)
- **Revenue and other figures**: none exist yet. Ticketing and payments are out of scope until
  the payments decision is made.

## Consequences

- Analysts get an organization-level view without access to attendee data.
- Totals and the rate stay correct for any number of events; only the list is capped.
