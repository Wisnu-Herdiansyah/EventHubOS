# ADR-0074: Data retention: organizers choose how long attendee data is kept

- Status: accepted (periods to be confirmed by a lawyer before general availability)
- Date: 2026-11-26
- Closes: D9 (retention schedules)

## Context

EventHub keeps attendee personal data (names, email addresses, answers, staff notes), records
needed to run the system (outbox, idempotency), invitations, and an audit log. Nothing is
deleted on a schedule today. Indonesia's PDP law is in force, and its implementing regulation
(GR 33/2026) takes effect on 16 January 2027. Among other things, it asks for a written
retention policy and for personal data to be kept only as long as needed
([RSM](https://www.rsm.global/indonesia/en/node/439),
[DFDL](https://www.dfdl.com/insights/content-hub/articles/indonesia-personal-data-protection-law-gr-33-2026/)).
This ADR is a product decision, **not legal advice**. A lawyer confirms the periods before
general availability. Decided with the product owner on 2026-11-26.

## Decision

### Attendee personal data: the organizer chooses

Each organization chooses how long attendee personal data is kept after an event ends: **3, 6,
12 or 24 months**. The default for an organization that has not chosen is **12 months**.

- When the period passes, a sweep removes names, email addresses, answers, staff notes and
  link tokens from that event's registrations. It keeps only what reports need: status, the
  times, and checked in or not. Anonymous counts stay.
- Changing the setting applies to every event from then on, including past ones.
- Cancelled events and archived events follow the same rule, counted from the event's end.

### Platform records: fixed periods

| Record                                | Kept                    |
| ------------------------------------- | ----------------------- |
| Audit log                             | 24 months, then deleted |
| Outbox events, once processed         | 30 days                 |
| Idempotency records                   | 30 days                 |
| Invitations, once expired or accepted | 30 days                 |

The audit log has no tenant foreign key (ADR-0004), so it can outlive an organization's purge
within these 24 months. Audit entries already hold no attendee details (ADR-0067, ADR-0069).

## To build (later slices)

- The organization setting and its admin control.
- The sweeps, as worker jobs with their own audit entries (counts only).
- A written retention policy page for organizers and attendees, once the lawyer has confirmed it.

## Consequences

- Organizers who run a yearly event and want last year's list choose 24 months.
- Deleted personal data cannot be restored from EventHub, apart from backups within 7 days
  (ADR-0073).
