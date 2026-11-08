# ADR-0022: Two-step verification with an authenticator app

- Status: accepted
- Date: 2026-11-08
- Closes: the MFA-method part of open decision D3
- Threat model: T39–T41 (and T5, T32)

## Decision

People can add a second step to sign-in: a 6-digit code from an authenticator app (TOTP,
RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), with ten one-time recovery codes. It is optional
per account for now.

**Sign-in.**

- A correct password on an account with MFA returns `{ mfaRequired, challengeToken, expiresAt }`,
  not a session. The challenge is single-use, lasts 5 minutes and allows at most 5 attempts.
- `POST /v1/auth/login/mfa` takes the challenge plus an app code or a recovery code:
  - The code is accepted within ±1 step (clock drift), and each step only once per account
    (`last_used_step`), so a seen code cannot be replayed.
  - Wrong codes count toward the same lockout as wrong passwords.
  - The failure counter resets only when the second step succeeds.
  - A pending password re-hash waits in the challenge and is applied then.
- The admin keeps the challenge in its own `__Host-` HttpOnly cookie and asks for the code at
  `/login/verify`, with "use a recovery code" as the fallback.

**Enrolment and changes** (all require the current password, with the lockout applying):

- setup returns the secret and an `otpauth://` URI (the admin shows a QR code);
- confirm with a code activates MFA, returns recovery codes once, and signs out other sessions;
- new recovery codes replace the old ones;
- turning off needs the password plus a current code or a recovery code.

Every change, and every sign-in with a recovery code, is audited and emailed to the owner through
the outbox. No codes or secrets appear in emails, audit records or logs.

**Storage** (migration 0013). Three tables with forced RLS and no policies, reached only through
`SECURITY DEFINER` functions, as with the other identity tables.

- Secrets are sealed with AES-256-GCM under `MFA_ENCRYPTION_KEY`, which only the API holds. The
  user ID is bound in as associated data.
- Recovery codes and challenge tokens are stored as SHA-256 hashes. Recovery codes are 10
  characters (about 50 bits) from an unambiguous alphabet.

**Configuration.** `MFA_ENCRYPTION_KEY` (32 bytes, base64) is required in staging and production.
Without it locally, MFA reports itself unavailable rather than using a throwaway key.

## Alternatives

- **Passkeys (WebAuthn)**: stronger against phishing, but more complex. Planned as a second
  factor type later.
- **SMS or email codes**: weaker (SIM swap; the inbox is also the password-reset channel). Not
  offered.

## Consequences

- Accounts can be protected against password theft today. Requiring MFA for Owners and Admins can
  build on this as an organization setting.
- Changing `MFA_ENCRYPTION_KEY` makes existing enrolments unreadable. Rotation needs a versioned
  key list (the sealed format carries a version byte for this).
- Users who lose both their phone and their recovery codes need an account-recovery process,
  which is not built yet (support-assisted, with identity checks).
