# ADR-0037: Event announcements

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0008 (email), ADR-0009 (outbox), ADR-0023 (registration), ADR-0035 (waitlist)
- Threat model: T65, T66

## Decision

Organizers can email everyone signed up for an event, for example about a new venue or start
time. It is one plain-text message per announcement, sent through the outbox like every other
email.

**Who can send.** `communication.send`: Owners, Admins and Event managers. Registration managers
see attendees but cannot email them all.

**Audience.**

- Everyone registered, or everyone registered and on the waitlist.
- Cancelled people are never emailed.
- Recipients are **captured when it is sent** (`announcement_recipient`): one row per person.
  Someone who cancels before their email goes out is skipped, not emailed.

**Content.**

| Part    | Rule                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject | One line, 1–150 characters, no control characters, so it can't inject email headers. Sent as "<event name>: <subject>", so people see at once where it comes from |
| Message | Plain text, 1–5,000 characters; line breaks kept (normalized to LF); no other control characters; no HTML                                                         |

Each email starts with "Hello <name>," and ends with who sent it, why the person received it,
and a link to the event page.

**Limits.**

- At most **3 announcements per event in any 24 hours**, counted under the event row lock so
  the limit cannot be raced.
- At most **5,000 recipients**; larger events need batched sending first.
- Not for archived events.

**Delivery.**

- The API stores the announcement and its recipients, audits `event.announcement_sent`
  (announcement ID, audience, count; never people), and enqueues an outbox event holding only
  the announcement ID.
- The worker reads pending recipients through a worker-only definer function, scoped by
  organization, and sends one email each, with message ID `<outbox event>-<registration>`.
- It marks each recipient delivered or skipped in the consumer's transaction. If sending fails
  partway, the marks roll back and the retry walks the list again. The provider's idempotency
  key (the message ID) keeps people who were already emailed from getting it twice.
- Delivered recipients are never pending again.

**Admin.**

- An **Announcements** page per event: the audience with live counts, subject and message, and
  a confirmation dialog ("An email can't be taken back").
- A history with sender, audience and delivery progress ("Sending: 3 of 40", "Delivered to 40",
  skipped counts).

## Alternatives

- **Rich text or HTML.** It waits on the rich-text format and sanitizer decision (D13), and
  plain text cannot carry tenant markup or scripts.
- **Reply-to the organizer's contact email.** Useful, but it lets any organizer set where
  replies go from the platform's sending domain. It needs a verified contact address first.
- **Marketing and newsletters.** Out of scope. These are service messages about an event the
  person signed up for. Marketing email needs explicit consent and an unsubscribe flow; that is
  a legal and product decision not made here.
- **One outbox event per recipient.** Simpler retries, but thousands of events for one action,
  and no single place to see progress.

## Consequences

- Organizers can reach attendees without exporting their emails, which keeps personal data
  inside the platform (ADR-0027).
- Large events (over 5,000) need batched sending, with a consumer per batch, before the cap can
  rise.
- Delivery status means "handed to the provider", not "opened" or "bounced". Bounce webhooks
  are a follow-up.
