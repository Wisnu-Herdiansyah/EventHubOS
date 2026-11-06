# ADR-0015: Password reset

- Status: accepted
- Date: 2026-11-06
- Implements: password reset (deferred in ADR-0007), API and admin UI
- Builds on: ADR-0007 (password identity), ADR-0008 (deterministic email tokens), ADR-0009
  (outbox broker)

## Decision

**Request.** `POST /v1/auth/password-reset/request {email}` is public and always answers `202`
with the same body, whether or not the address has an account. A known account gets a reset
email, capped at **3 per 15 minutes per account**. The cap is counted under the credential row
lock in `auth_request_password_reset`, so a burst spread across many IP addresses still cannot
flood an inbox. The per-IP auth limit (10/min) applies on top. The API enqueues only identifiers
(`identity.password_reset_requested {userId, credentialVersion}`).

**Email.** The worker derives the token per event (`password-reset` purpose, domain-separated
from verification and invitation tokens), so retries are byte-identical (ADR-0008). It stores
only the SHA-256 hash, bound to the credential version the request saw, with a TTL of
`PASSWORD_RESET_TTL_MINUTES` (default 60). If the password changed in the meantime, nothing is
sent. The link carries the token in the URL fragment (`/reset-password#token=…`).

**Completion.** `POST /v1/auth/password-reset/complete {token, password}` applies the sign-up
password policy, including "not your email". In one transaction,
`auth_complete_password_reset`:

- consumes the token;
- replaces the hash and bumps `credential_version`, so every other reset and verification link
  dies;
- marks the address verified, since mailbox control is proven;
- clears login lockout and the reset throttle;
- revokes **every session**.

A policy failure rolls the transaction back, so the link stays usable. Invalid, used, expired and
stale tokens all get one answer (`invalid_or_expired_token`).

**Notification.** A completed reset enqueues `identity.password_changed`. The worker emails the
owner that their password changed and every session was signed out, with a link to start a
reset if it wasn't them. The email contains no token.

**Data and privileges.** `password_reset_token` has RLS forced and no grants. Each function is
`SECURITY DEFINER` with a fixed `search_path` and is granted to one role:

| Function                       | Role   |
| ------------------------------ | ------ |
| `auth_request_password_reset`  | app    |
| `auth_complete_password_reset` | app    |
| `auth_issue_password_reset`    | worker |
| `auth_notification_email`      | worker |

Audit records (`identity.password_reset_requested` with outcome `sent`, `throttled` or
`unknown_account`; `identity.password_reset_completed`) and outbox payloads carry no addresses,
passwords or tokens.

**UI.**

- Sign-in links to `/forgot-password`, which always confirms with the same neutral message.
- `/reset-password` reads the fragment token, removes it from the address bar, and shows policy
  errors inline (a password is never echoed back).
- A used or expired link leads to a new one. After a reset, the browser's session cookie is
  cleared and the user signs in again.

## Consequences

- Unverified accounts can reset too, and become verified by doing so. A reset also defeats a
  pre-hijacking attacker: the victim's reset replaces the attacker's password and ends their
  sessions.
- Up to three reset links can be outstanding at once until one is used, and each expires within
  the TTL.
- Not built: changing the password while signed in (needs re-authentication), session listing and
  revoke-all, MFA, and a breached-password screen (ADR-0007 follow-ups).
- Migration 0007 is expand-only. An upgrade from 0006 with existing accounts was verified.
