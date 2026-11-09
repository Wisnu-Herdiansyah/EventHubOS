# ADR-0023: Free event registration

- Status: accepted
- Date: 2026-11-09
- Builds on: ADR-0021 (public event sites)
- Threat model: T42–T45

## Decision

Visitors register for a published event from its public page, free of charge. Paid tickets wait for
the payment-provider decision (D2).

**What visitors do.**

- **Form:** a short form in the page's registration section asks for name, email and consent to the
  event's privacy policy. If the page has no registration section, one is added at the end.
- **Response:** the same "check your email" answer whether the address is new or already
  registered, so the form never reveals who is registered. A repeat sign-up re-sends the
  confirmation to that address, at most once per 10 minutes.
- **Email:** the confirmation contains a single-use cancel link,
  `{site}/cancel-registration#token=…`. The token sits in the URL fragment, is derived per email so
  retries are identical (ADR-0008), and is stored as a SHA-256 hash.
- **Cancelling:** the cancel page asks before cancelling; the seat is freed and an email confirms.

**Rules** (enforced in the database, in `public_register`):

- registration is possible only while the event is published or live, its visibility is public or
  unlisted, and the organization is active;
- opening time: `settings.registration.opensAt`, or as soon as the event is published;
- closing time: `closesAt`, or the end of the event;
- capacity: `capacity`, or unlimited;
- one active registration per email per event (partial unique index);
- the event row is locked during sign-up, so concurrent sign-ups can never exceed capacity (tested
  with two overlapping transactions);
- a privacy policy is required for consent, and the policy URL shown is stored with the
  registration as evidence.

**Organizers.**

- **Registrations page per event:** shows counts, capacity, the open/closed state and the attendee
  list (name, email, date, status), with an "Organizer cancels" action that emails the attendee.
- **Who sees what:** attendee details need `registration.manage` (Owner, Admin, Event manager,
  Registration manager). Everyone with `event.read` sees counts and state.
- **History:** sign-ups and cancellations appear in the audit log under "Registrations", without
  names or emails.

**Abuse.**

- **Rate limits:** per-IP on the API (5 sign-ups and 10 cancellations per minute). The public site
  forwards the visitor IP from its trusted proxies (`SITE_TRUSTED_PROXY_HOPS`).
- **Honeypot:** a hidden field; when filled, the submission is quietly dropped.
- **CAPTCHA:** none yet; it needs a provider choice.

**Personal data.**

- **Minimal:** the only attendee data kept is name and email, with consent evidence.
- **Out of records:** neither appears in audit records, outbox payloads or logs.
- **Isolation:** the table has forced RLS.
- **Retention:** how long attendee data is kept after an event is policy decision D9.

## Consequences

- "Register now" works end to end. Attendees need no account.
- The site's CSP now allows forms to post to the site itself only (`form-action 'self'`).
- Not yet: custom questions, exports (`registration.export_pii` exists for this), waitlists,
  check-in, reminders, and a CAPTCHA.
