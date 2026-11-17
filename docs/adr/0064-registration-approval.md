# ADR-0064: Registration approval

- Status: accepted
- Date: 2026-11-17
- Builds on: ADR-0023 (registration), ADR-0035 (waitlist), ADR-0050 (event cancellation)

## Context

Some events are by invitation or need a mix of people: an organizer wants to see who asked
before anyone gets a ticket. Today every sign-up is confirmed at once.

## Decision

An organizer can switch on **approval** for an event (`settings.registration.approval`, off by
default). A sign-up then becomes a **request** (`pending`) until staff **approve** it (it becomes
`confirmed`) or **decline** it (it becomes `declined`).

### The rules

| Question                          | Answer                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| Does a request hold a seat?       | No. Capacity counts confirmed registrations only                                        |
| What if the event is full?        | New requests are refused, as sign-ups are                                               |
| Can approval go over capacity?    | Yes, as a choice the organizer makes (like promoting from the waitlist); it is recorded |
| Approval and a waitlist together? | No. Refused in the settings, with a message                                             |
| Who decides?                      | `registration.manage`                                                                   |
| Can a decision be changed?        | No. A request is decided once. An approved person can later be cancelled as usual       |
| Can a declined person ask again?  | No, not for that event. The answer looks the same as any sign-up and sends nothing      |
| Can a person withdraw?            | Yes, with the link in their email, as they would cancel                                 |
| Can a request be checked in?      | No                                                                                      |
| What if the event is cancelled?   | People still waiting get the cancellation email; requests can then no longer be decided |

The public sign-up answer is **identical** whether approval is on or off, and whatever the
address's history, so the response reveals nothing about who asked before. The sign-up form
says, before anyone submits, that the organizer reviews each request.

### Emails

| When              | Email                                                               | Class         |
| ----------------- | ------------------------------------------------------------------- | ------------- |
| Someone asks      | Request received: not registered yet, no ticket; a link to withdraw | requested     |
| They ask again    | The same, saying they already asked                                 | requested     |
| Approved          | The usual confirmation, with ticket, calendar file and cancel link  | transactional |
| Declined          | The organizer can't offer a place this time; **no reason given**    | transactional |
| Withdrawn by them | Confirmation that the request is withdrawn                          | transactional |

The decline email gives no reason on purpose: free-text reasons sent to members of the public
are a source of mistakes and complaints. Organizers who want to explain can write to the person.

### Data

- Two new statuses on `registration`, added by widening its check constraint (expand-only, as
  ADR-0035 did).
- `decided_at` and `decided_by` record who approved or declined, and when.
- Sign-up, withdrawal, the link token and the cancellation notice are updated database functions;
  a new one tells the public page whether approval is on.

## Tests

- **Integration (18):** sign-up as a request with an identical answer; asking again; requests
  hold no seat and a full event refuses; the old sign-up function; approve (with email, ticket,
  audit and decider); approval beyond capacity, exactly at capacity; decline (email, no new
  request, link revoked); one decision only; idempotent decisions; permissions and other
  organizations; requests cannot be cancelled or checked in; withdrawal; ordering and filters;
  approval refused with a waitlist; event cancellation reaches requests and blocks decisions;
  ordinary announcements do not reach requests; the worker cannot change registrations.
- **Existing tests:** registration, waitlist, questions, announcements and cancellation all
  unchanged and passing.
- **Browser:** settings with the waitlist conflict; two people ask; the organizer approves one and
  declines the other; emails; lists and counts; a person withdraws with their link.
- **Mutation checks:** 21 changes to the sign-up rules, link rules, decisions, check-in, counts,
  ordering, emails and the cancellation reach; all caught after two tests were tightened and one
  unreachable check removed.

## Limits

- **No message to the person** on decline, and no bulk approve.
- **Requests never expire.** After the event they simply stay undecided.
- **No approval for the waitlist.** The two are exclusive for now.
