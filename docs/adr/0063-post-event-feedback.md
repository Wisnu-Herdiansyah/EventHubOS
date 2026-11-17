# ADR-0063: Post-event feedback

- Status: accepted
- Date: 2026-11-17
- Builds on: ADR-0023 (registration and emailed links), ADR-0028 (check-in), ADR-0030 (event
  reports), ADR-0062 (reminder sweep)

## Context

Organizers want to know how an event went. Check-in tells them who came; nothing tells them what
people thought. A short rating with an optional comment, asked once after the event, is the
smallest useful answer.

## Decision

When an organizer switches it on, people who attended get **one email after the event ends**
with a **personal link** to a short form: a **rating from 1 to 5** and an **optional comment**.
Organizers see the answers in the event report, **without names**.

### Who is asked

- Feedback is switched on for the event (`settings.feedback.enabled`). **Off by default**: unlike
  a reminder, a request for opinions is something the organizer chooses to send.
- The event has ended, **within the last 7 days**, was published (or live or ended), and was not
  cancelled. The organization has a public site address, since the email is only a link.
- The person **attended**: they were checked in. If the event never used check-in (nobody was
  checked in), everyone with a confirmed seat is asked instead.
- Cancelled and waitlisted people are never asked.

### The link

As with other emailed links (ADR-0008, ADR-0023), the token is derived from the registration
and a secret, so a retried email is byte-identical, and only its **SHA-256 hash** is stored. It
lives in the URL fragment, so it never reaches a server log, and the page removes it from the
address bar at once. The page is `no-index` and sends no referrer.

The link works for **30 days after the event**, while the registration stays confirmed and the
event is not cancelled. Unknown, expired, foreign and cancelled links all get the same answer.
Opening it again shows that the person already answered; **sending again replaces** their answer.

### What organizers see

| Who                                        | Sees                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| Anyone with `report.read` (incl. Analysts) | People asked, answers, average, how many gave each 1–5 |
| Those with `registration.manage`           | Also the comments, newest first, with rating and date  |

No answer is ever returned with a name, email or registration ID. Comments are shown to the
smaller group because people may write personal details in them; the form asks them not to.

### How it runs

The same pattern as reminders (ADR-0062): a worker sweep locks a batch of due people, emails each
one and marks them; a failed send rolls the batch back. Answers are written only through one
`SECURITY DEFINER` function; the API role can read answers under tenant RLS but cannot insert
them directly, and the worker role cannot read them at all.

The timed jobs (waitlist closing, reminders, feedback) now share one setting,
`SWEEP_INTERVAL_MS`, default one minute. The browser tests set one second.

## Tests

- **Integration (19):** the email and its stored hash; the switch; the 7-day window; lifecycles,
  cancellation and a missing site address; checked-in versus everyone; a failed send then exactly
  once with byte-identical retries; no site address; locked batches skipped; the organization
  check on marking; lookup and answers; replacing an answer; input validation; unknown, foreign,
  wrong-purpose, wrong-secret, expired, cancelled-registration and cancelled-event links; the
  summary and comments with both permission levels; no names in responses; other organizations;
  the setting through the API; direct inserts refused; each role limited to its own functions.
- **Unit:** the setting, the email class, the site path, the report helpers, the sweep interval.
- **Browser:** the whole journey: switch on, sign-up, event ends, email, answer, answer again,
  incomplete and invalid links, the report for an owner and for an analyst.
- **Mutation checks:** 28 changes to the due rules, the link rules, the answer storage, the
  permissions and the worker; 27 caught. The survivor changes only the route's documented
  permission, which the API contract test catches; the enforced check was caught.

## Limits

- **One question.** No custom questions or multiple-choice items yet.
- **English only**, like the other emails.
- **Small events.** With very few answers, an organizer may be able to guess who wrote what. The
  report says answers are anonymous, not that they are untraceable.
- **No reminder to answer**, and no export of comments yet.
