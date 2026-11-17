# ADR-0066: Deciding several requests at once

- Status: accepted
- Date: 2026-11-17
- Builds on: ADR-0064 (registration approval), ADR-0050 (event cancellation)

## Context

With approval on (ADR-0064), every sign-up waits as a request. An organizer with dozens of
requests had to open a dialog and confirm each one. Most decisions come in batches ("approve
everyone from the partner list", "decline the rest").

## Decision

On the **Requests** view, organizers tick several requests and **approve or decline them in one
step**. Each person is handled exactly as a single decision would handle them: the same status
change, the same email, the same audit entry.

### The API

`POST /v1/organizations/{organizationId}/events/{eventId}/registrations/decide`
(`decideRegistrations`), with `registration.manage` and an Idempotency-Key.

```json
{ "decision": "approve", "registrationIds": ["…", "…"] }
```

- **1 to 100 distinct IDs.** Duplicates, an empty list, more than 100, or any other field: 400.
- **One transaction.** The event is locked once, then each request in the order given. Seats
  count up in that order, so with 2 seats left and 3 approvals, the **third** is recorded as
  over capacity (`registration.approved` with `overCapacity: true`), as one-at-a-time would be.
- **A cancelled event refuses the whole batch** (409 `event_cancelled`), as the single route does.
- **Per-request results, not failures.** A request already approved, declined or withdrawn
  (perhaps by a colleague a moment earlier) is reported as `not_pending`; an ID that is not a
  request at this event, in this organization, is `not_found`. The rest go ahead. The answer:

  ```json
  { "decision": "approve", "decided": 2, "results": [{ "registrationId": "…", "result": "decided" }, …] }
  ```

  `not_found` is the same answer for an ID that does not exist, belongs to another event or to
  another organization: the batch reveals nothing about other tenants.

- **Replays.** The same key and body returns the stored answer and sends no second email; the
  same key with a different body is refused (422), as everywhere.

The single `approve` and `decline` routes now share this code. One visible change: on a
cancelled event they answer `event_cancelled` before looking at the request, so a request
already decided there also gets `event_cancelled` rather than `not_pending`.

### The admin page

- A **checkbox per row** and a bar above the list (Select all, "3 requests selected", Approve
  selected…, Decline selected…), shown on the Requests view when there are at least two.
- The confirm dialog names the count and, for approvals, warns when the batch goes over
  capacity ("Only 2 of 2 seats are free, so this goes over capacity.").
- More than 100 selected: the buttons are disabled with "Select up to 100 at a time."
- Afterwards: "3 requests approved. Each person is registered and has been emailed their
  ticket.", adding "1 was already dealt with and left as is." when some were skipped.

## Tests

- **Integration (9):** approving and declining batches with emails and audits per person;
  mixed batches (already decided, withdrawn, unknown); a batch that changes nothing; seats
  counted in order; replay and key reuse; a cancelled event; validation (empty, 101, duplicate,
  malformed, unknown decision, extra field, no key); permissions and other organizations
  (their owner refused, crossed IDs `not_found`, another event's request `not_found`, a foreign
  event 404). The 18 approval tests pass unchanged on the shared code.
- **Unit:** the notice text, singular, plural, skipped and nothing changed.
- **Browser:** five requests on a two-seat event; three ticked and approved over capacity with
  the warning; the other two declined with Select all; emails for each; accessibility scans.
- **Mutation checks:** 10 changes (the per-item result, the count, the cancelled guard, the
  unknown event, the uniqueness rule, both size limits, the pending and not-found checks, the
  decision passed through): all caught.

## Limits

- **No partial undo.** A decision is final, as for one request.
- **100 per batch.** Larger lists are decided in several batches; the Requests view lists them
  oldest first.
- **No filter by answer** ("select everyone who answered X"); ticking is by hand or Select all.
