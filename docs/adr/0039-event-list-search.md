# ADR-0039: Event list search and filters

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0011 (event lifecycle), ADR-0036 (duplicating events)

## Decision

The organization's events list can be searched and filtered, and pages through results. As
organizations duplicate events year after year, the list quickly outgrows one screen.

**API.** `GET /v1/organizations/:org/events` gains two query parameters next to `lifecycle`:

| Parameter | Meaning                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `q`       | Name **or** slug contains this, case-insensitive. 1–100 characters of plain text, trimmed. `%`, `_` and `\` are literal, not patterns |
| `when`    | `upcoming` (not over yet) or `past` (over), by the event's **end** time, whatever its lifecycle                                       |

- Filters combine with each other and with the existing keyset cursor (newest created first),
  so paging through a filtered list never skips or repeats an event.
- Anything else is `400 validation_failed`, as before.
- Rows stay scoped to the organization in the URL by `withOrganization` and RLS.

**Admin.** The organization overview's Events card gets:

- a search box, a status menu and an Upcoming/Past menu, as a GET form, so a filtered view can
  be bookmarked or shared with the team;
- 25 events per page, with **Next page** and **First page** links;
- "No events match" instead of an empty table, and a Clear link;
- a notice when a hand-edited link held invalid filters: the valid ones still apply.

The figures above the table (event count, upcoming, by status) still describe the whole
organization, not the filtered view.

The Clear and paging links are plain links rather than client-side navigation. Like the form,
they load the page afresh, and the `#events-heading` anchor brings the reader back to the table.

## Alternatives

- **Full-text search (tsvector) or trigram indexes.** One organization's events number in the
  hundreds at most, and the search runs inside the organization's own rows. A substring match
  is enough until a large tenant shows otherwise.
- **Date-range filters.** Upcoming and past answer the common question; a period like Reports'
  (ADR-0034) can follow if asked for.

## Consequences

- No migration.
- The overview makes two list requests: one for the figures, and one for the filtered page.
