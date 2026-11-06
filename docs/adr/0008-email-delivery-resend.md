# ADR-0008: Transactional email through Resend

- Status: accepted
- Date: 2026-11-06
- Closes: open decision D4 for transactional email (SMS/WhatsApp channels remain open)

## Context

Verification emails (ADR-0007) need a production provider. The product owner chose Resend.
The worker already delivers email through the `EmailSender` port from an outbox consumer that
dedupes per event (`processed_event`).

## Decision

**Adapter.** `apps/worker/src/adapters/resend-email-sender.ts` calls Resend's HTTP API directly
with `fetch`, rather than through the `resend` SDK, because:

- the SDK writes raw API error objects with `console.error` whenever `NODE_ENV` is not
  `production`, which bypasses our log redaction;
- a direct call gives an explicit timeout (`RESEND_TIMEOUT_MS`, default 10 s), our own error
  classification, and no new runtime dependencies.

The SDK remains blocked outside adapters by ESLint.

**API contract used** (verified against the official `resend` SDK 6.34.1 source; Resend's
documentation host was unreachable from the build environment): `POST {base}/emails`,
`Authorization: Bearer <key>`, JSON `{from, to[], subject, text, tags[{name,value}]}`, optional
`Idempotency-Key` header, success `{id}`, errors `{statusCode, name, message}`.

**Idempotency.** `Idempotency-Key` = the domain event ID, so a retried delivery of the same event
is deduplicated by Resend.

**Deterministic verification tokens.** Provider idempotency only works if every retry sends an
identical payload, and the payload contains the token. A random token per attempt would break in
the "accepted, then our transaction rolled back" case (response timeout): the user holds a link
whose token was never stored, and the retry reuses the key with a different body, which Resend
rejects (`invalid_idempotent_request`), dead-lettering the event. Tokens are therefore
`HMAC-SHA256(EMAIL_TOKEN_SECRET, "eventhub:verify-email:v1:" + eventId)`: stable across retries,
unguessable without the secret, single-use, and stored only as SHA-256 hashes. A worker
integration test reproduces the timeout-after-accept case and was mutation-checked.

**Error handling.** Failures raise `EmailDeliveryError` with only the provider code, HTTP status,
and a retryable flag, never the provider's free text (it can echo addresses), the request, or
the key. Retryable: network errors, timeouts, 429 (`rate_limit_exceeded`, `daily_quota_exceeded`),
5xx, `concurrent_idempotent_requests`. All failures go back through outbox backoff and
dead-lettering. Non-retryable codes (`validation_error`, `invalid_from_address`,
`invalid_api_key`) still retry until dead-lettered; fast-failing them is a follow-up.

**Configuration.** `EMAIL_SENDER=resend` requires `RESEND_API_KEY` (secret) and `EMAIL_FROM`
(a sender on a domain verified in Resend). `EMAIL_TOKEN_SECRET` (secret, at least 32 characters)
is required for every sender. Resend is the only email adapter allowed in staging/production;
the remote endpoint and `APP_BASE_URL` must be HTTPS there.

**Testing.** Unit contract tests run against a local fake modelled on the SDK contract (request
shape, dedupe, every error class, timeout, no secret leakage). `pnpm test:live` runs an opt-in
live contract against the real API when `RESEND_API_KEY`, `RESEND_CONTRACT_FROM` and
`RESEND_CONTRACT_TO` are present. It never runs in CI by default.

## Consequences

- Before the first real send: create a Resend project, verify the sending domain (DNS records in
  Resend's dashboard), store `RESEND_API_KEY` and `EMAIL_TOKEN_SECRET` in the secret manager,
  allow egress to `api.resend.com`, and run `pnpm test:live` once against that project.
- The email HTTP call happens inside the consumer's database transaction, holding one
  connection for up to `RESEND_TIMEOUT_MS`.
- **The worker still cannot start in staging/production** because `EVENT_PUBLISHER` has no remote
  adapter (D5). Note for that decision: `local_dispatch` delivers from the durable PostgreSQL
  outbox with row locking, retries, dead-lettering, and per-consumer dedupe, so it may be an
  acceptable initial production broker for a single consumer group. That is a decision to
  record, not an assumption.
- Not yet built: bounce/complaint webhooks (needs webhook signature verification), suppression
  handling, HTML templates, and per-recipient send-rate limiting.
