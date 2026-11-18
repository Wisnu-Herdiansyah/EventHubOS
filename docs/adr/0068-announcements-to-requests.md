# ADR-0068: Announcements to requests waiting for approval

- Status: accepted
- Date: 2026-11-18
- Builds on: ADR-0037 (announcements), ADR-0050 (event cancellation), ADR-0064 (registration
  approval)

## Context

With approval on, people can wait days for a decision. Announcements (ADR-0037) reached people
with a seat, optionally the waitlist, but never requests: ADR-0064 kept requests out on purpose,
because "doors open at 08:00" is wrong for someone without a place. Organizers still need to
tell the people waiting something like "we will decide on every request by Friday".

## Decision

A third announcement audience, **`requests`**: only the people whose request is **still
waiting** for a decision.

| Audience                  | Who is captured when it is sent | Who is emailed when the worker sends                                      |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `registered`              | registered                      | still registered                                                          |
| `registered_and_waitlist` | registered and waitlist         | still registered or waiting                                               |
| `requests` (new)          | requests waiting for a decision | **still waiting**: approved, declined or withdrawn in between are skipped |

The cancellation notice (ADR-0050) is unchanged: it still reaches everyone who asked to come.

- **Skipped once decided.** A request approved, declined or withdrawn between sending and
  delivery is skipped, not emailed: the message was about a decision they no longer wait for.
  The sent list counts them as skipped ("decided or withdrawn meanwhile").
- **Same rules as every announcement:** `communication.send`, plain text, at most 3 per event
  in 24 hours (the limit counts all audiences together), 5,000 recipients, suppressed addresses
  skipped, the audit records the audience and the count, never the people.
- **Nobody waiting:** refused with "Nobody is waiting for approval." (`no_recipients`).
- **The email** is the ordinary announcement email; its footer ("to people who signed up for
  …") fits requests too, so the worker is unchanged.

### Admin

On the Announcements page, a third choice, "Only people waiting for your approval (N people)",
shown while any request is waiting. The page offers the form when anyone at all can be written
to, and the default choice is the first group with anyone in it. The sent list labels these
"Waiting for approval".

### Database (migration `0038`)

Expand-only: the audience check is widened (new constraint added, old one dropped; old code's
values are still accepted) and `announcement_pending` gains the `requests` rule.

## Tests

- **Integration (7):** only waiting requests are emailed (not approved, declined or withdrawn);
  the audit and list show the audience; the other audiences still leave requests out;
  approved, declined and withdrawn between sending and delivery are skipped and counted;
  nobody waiting is refused and records nothing; an unknown audience is refused; the daily
  limit counts these; `communication.send` (registration managers and viewers refused, event
  managers allowed); another organization's owner refused and each organization reaches only its
  own requests; the database accepts the three audiences and refuses others. The existing
  announcement, cancellation and approval suites (38 tests) pass unchanged.
- **Browser:** approve one of two requests, send to "Only people waiting for your approval (1
  person)", the email arrives, the sent list shows the group and "Delivered to 1".
- **Mutation checks:** 8 changes (the skip rule in the database function, both ways; the
  widened check; the captured statuses, both ways; the accepted audiences; the route's count;
  the message): all caught.

## Limits

- **No combined audience** ("everyone, requests included"): send two announcements.
- **No per-person message**; the decision emails themselves are unchanged.
