# ADR-0030: Event reports

- Status: accepted
- Date: 2026-11-10
- Builds on: ADR-0023 (registration), ADR-0028 (check-in)
- Threat model: T57

## Decision

Each event has a Report page for anyone with `report.read`: Owners, Admins, Event managers,
Registration managers and Analysts. It shows counts only, never attendees, so Analysts can see how
an event went without access to personal data. Viewers, Content editors and Billing admins do not
see it.

**API.** `GET /v1/organizations/:org/events/:event/report` returns:

| Field            | What it holds                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Totals           | Sign-ups ever made, registered, cancelled, checked in, and no-shows (registered but not checked in). A registration cancelled after check-in does not count as attending. |
| `byDay`          | Every calendar day from the first sign-up to the last sign-up or cancellation, with sign-ups and cancellations per day. Empty days are filled with zeros.                 |
| `checkInsByHour` | Each hour with at least one check-in.                                                                                                                                     |

- **Time zone.** Days and hours use the event's own time zone, computed in PostgreSQL, so a
  sign-up at 01:30 Jakarta time counts on the Jakarta day, not the UTC one.
- **Size.** At most 366 days; `truncated` says when earlier days were left out.
- **Same reads as every tenant route.** Organization, event, RLS and the deny-by-default
  permission are checked as usual.

**Admin.** The Report page, linked from the event page, has:

- four stat tiles: registered (of capacity), checked in with the attendance rate, no-shows, and
  cancelled. No-shows show "–" until the event has ended, because before then "not checked in" is
  not a no-show;
- sign-ups by day, switching to weekly sums after 31 days so the list stays readable;
- check-ins by hour, with the day added when check-ins span several days.

Charts use the design system's bar-table chart: a real table with exact values and bars drawn
beside them. That makes it accessible by construction, with one series in the validated chart
colour, so no legend is needed. The time zone is stated under each chart.

## Alternatives

- **A line or column chart over time**: better for long trends, but it needs a hover layer and
  axis work. The bar table answers "how many, when" exactly for typical event sizes; a richer
  chart can come with multi-event reporting.
- **Hourly sign-ups**: too fine for most events and closer to identifying individuals.

## Consequences

- With very few attendees, an hourly check-in count can hint at when a known person arrived. It
  is visible only to roles that can already manage the event or read reports. Small-number
  suppression can be added if reports are ever shared more widely.
- This is the base for organization-wide reporting (across events), which would reuse the same
  queries per event.
- Page views of the public page were added in ADR-0044.
