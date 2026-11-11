# ADR-0043: Email bounces and complaints

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0008 (Resend), ADR-0009 (outbox), ADR-0037 (announcements)
- Threat model: T71, T72

## Context

The worker had no feedback from the email provider. Announcements and reminders kept going to
mailboxes that do not exist and to people who had marked our email as spam. That hurts the
platform's sending reputation (and with it every organization's mail), and organizers could not
tell why an attendee never heard from them.

## Decision

The email provider reports delivery outcomes by **signed webhook**. Bounced and complaining
addresses go on a **suppression list**. The worker checks that list before every email and
decides by the kind of email.

### Webhook, behind a port

`POST /v1/webhooks/email-feedback` is public (no session) and authenticated by its signature.
It goes through the `EmailFeedbackReceiver` port, so the domain never sees provider formats.

- **Adapter** `resend`. It implements the Standard Webhooks scheme that Resend uses (Svix):
  - The signature is base64 HMAC-SHA256 of `{id}.{timestamp}.{raw body}` under the `whsec_`
    secret.
  - It accepts `v1,<signature>` values; several may be listed while a secret is rotated.
  - The timestamp must be within 5 minutes of now.
  - It reads the `svix-*` or the `webhook-*` header names.
  - The signature is checked over the exact bytes received: the route keeps JSON bodies as raw
    strings, and only accepts JSON.
- **Mapping:** `email.bounced` → bounce, `email.complained` → complaint, `email.delivered` →
  delivered. Other event types are acknowledged (204) and ignored. Addresses are lowercased.
- **Responses:**
  - A bad, missing or stale signature answers `401` (`webhook_signature`, `webhook_timestamp`).
  - A correctly signed but unrecognised payload answers `400`.
  - The route answers `404` until `RESEND_WEBHOOK_SECRET` is configured.
- **Evidence:**
  - The payload shapes and the scheme were checked against the official `resend` SDK 6.34.1
    (`EmailBouncedEvent` and friends; `webhooks.verify` delegates to `standardwebhooks` 1.1.1).
  - The tests check that this verifier accepts exactly what the reference library signs.
  - A shared contract test (`emailFeedbackContract`) binds any future provider adapter to the
    same behaviour.
- **Not yet checked against a live delivery.** Before turning it on, send a test event from the
  provider's dashboard and confirm a `204` (see Operating it).

### Suppression list

Migration 0026 adds two tables, with no grants to the runtime roles; only definer functions
reach them.

- `email_suppression`: one row per address.
  - The reason is `bounce` or `complaint`. A complaint always wins: a later bounce does not
    replace it, and a delivery never lifts it.
  - A delivery that happened after the last bounce lifts that bounce.
- `email_feedback_event`: one row per provider event.
  - It holds the kind, message ID, recipient count and times, and **no addresses**.
  - A retried webhook for the same event changes nothing.

The list applies across the whole platform, not per organization. A missing mailbox is missing
for everyone, and complaints count against the platform's sending domain as a whole.

### What still gets sent

| Kind of email                                                                                                                                     | After a bounce | After a complaint |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------- |
| **Requested** by the person just now: verify address, password reset, registration confirmations                                                  | sent           | sent              |
| **Transactional**, about their own account or booking: password or two-step changes, organization security, seat opened, cancelled, waitlist news | skipped        | sent              |
| **Organizer** mail: announcements, invitations, two-step reminders, and any template not listed                                                   | skipped        | skipped           |

- Requested emails always go: the person is asking for them right now. If one is delivered, it
  lifts the old bounce.
- Unknown templates count as organizer mail, the strictest class.
- `SuppressingEmailSender` wraps the real sender in the worker.
  - A skipped email counts as handled, so the outbox does not retry it.
  - If the lookup fails, the email is not sent: the error goes back to the outbox to retry.
  - It logs the template and the reason, never the address.
  - Lookups use their own small connection pool. A lookup on the outbox pool could wait forever
    for a connection held by the very consumer that is sending (found by the tests).
- Announcements skip suppressed recipients inside `announcement_pending`, so they show as
  skipped in the organizer's announcement counts.

### What organizers see

- The attendee list (`registration.manage`) marks each address that email does not reach
  (`emailUndeliverable`), with a note that announcements skip those attendees.
- **Why** (bounce or complaint) is never shown.
- Only the addresses of the event being viewed are looked up.

### Operating it

1. In the provider's dashboard, add a webhook to
   `https://<api host>/v1/webhooks/email-feedback` for `email.bounced`, `email.complained` and
   `email.delivered`.
2. Put its signing secret in `RESEND_WEBHOOK_SECRET` (a secret store, never source control).
3. Send a test event and check the API answers `204`.

Rotating the secret: the provider signs with the old and new secrets during rotation, and
either one verifies here.

## Alternatives

- **Poll the provider's suppression API** instead of webhooks. Simpler to receive, but delayed,
  rate-limited, and it gives no per-event deliveries. The webhook is the documented push path.
- **Suppress per organization.** A bounce would be re-learned once per organization, and
  complaints would still harm everyone's reputation.
- **Suppress everything for a suppressed address.** That would lock people out of password
  resets after one bad day of their mail server. Requested emails are the person's own action.
- **Store addresses on each feedback event.** It adds personal data for no use: the suppression
  list already has what is needed.

## Consequences

- Undo is limited for now. There is no screen yet to lift a suppression by hand: a delivery
  lifts a bounce, and complaints stay. Platform support tooling will add that.
- Retention of the suppression list waits for D9. It holds email addresses (personal data).
- One more public route, rate-limited (600 per minute) and off until configured.
