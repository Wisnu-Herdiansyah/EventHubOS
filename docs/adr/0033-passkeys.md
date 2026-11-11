# ADR-0033: Passkeys as a second step of sign-in

- Status: accepted
- Date: 2026-11-11
- Builds on: ADR-0022 (two-step verification), ADR-0024 (requiring it)
- Threat model: T59–T61

## Decision

People can use a **passkey** (Face ID, Touch ID, Windows Hello, Android, or a security key)
instead of typing a code at the second step of sign-in. Two decisions came from the product owner:

- passkeys are a second step only, not password-free sign-in;
- the cryptography is done by **SimpleWebAuthn** (`@simplewebauthn/server` 14.0.3 and
  `@simplewebauthn/browser` 14.0.0, MIT), pinned and kept behind a `PasskeyRelyingParty` port in
  `apps/api/src/adapters/simplewebauthn-passkeys.ts`.

**Scope of this first version.** A passkey can be added once two-step verification with an
authenticator app is on. This keeps one model of "two-step is on": recovery codes, the lockout,
the sign-in challenge and the organization requirement (ADR-0024) all keep working unchanged.

- Turning two-step verification off removes the account's passkeys too, in the same transaction,
  and the audit record says how many were removed.
- Passkey-only accounts (no app) are a follow-up. They need recovery codes issued with the first
  passkey and a sign-in challenge that does not depend on the app factor.

**Adding a passkey.**

1. Re-enter the password: `POST /v1/auth/passkeys/options`, with the lockout applying.
2. The browser runs `navigator.credentials.create()`.
3. Send the result to `POST /v1/auth/passkeys`, with a name.

The options exclude passkeys already registered and ask for no attestation. User verification
(PIN or biometric) is preferred, not required: the password is already the first factor, and a
plain security key still proves possession. There are at most 10 passkeys per account. Adding or
removing one (removal also needs the password) is audited and emailed, like other two-step
changes.

**Signing in with a passkey.** After a correct password, the challenge response says
`passkey: true` when the account has one, and the admin offers "Use your passkey" first.

1. `POST /v1/auth/login/mfa/passkey-options`, with the sign-in challenge, returns options limited
   to the account's own passkeys.
2. The browser runs `navigator.credentials.get()`.
3. The assertion goes to `POST /v1/auth/login/mfa` as `passkey`, alongside `code` and
   `recoveryCode` (exactly one of the three).

What is checked:

- The library checks the origin (the admin app), the relying party ID (its host name), the
  challenge and the signature.
- The WebAuthn challenge is single-use and tied to that sign-in challenge: a replayed assertion
  fails.
- The signature counter must move forward. It is checked by the library and again in the
  database, under the row lock, so two simultaneous uses of one assertion counter cannot both
  succeed (cloned-authenticator detection).
- Failures count toward the same account lockout as wrong codes.

**Storage** (migration 0020). Two tables, `auth_passkey` and `auth_webauthn_challenge`, with
forced RLS and no grants to the app role. They are reached only through `SECURITY DEFINER`
functions, as with the other identity tables. A passkey's public key, ID and counter are stored;
nothing secret is.

**Configuration.** `PASSKEY_ORIGIN` is the admin app's origin, and passkeys are bound to its host
name. It must use https outside local and CI. When it is unset, passkeys report themselves as
unavailable and the Account page hides them. Changing the host later invalidates existing
passkeys, because browsers bind them to the host.

## Testing

- **Integration tests** use a software authenticator (`tests/support/soft-authenticator.ts`). It
  makes real P-256 keys and real signatures, so verification runs exactly as it does for devices.
- **Browser tests** use Chromium's virtual authenticator for the real ceremony: add a passkey,
  sign in with it, and remove it.

## Alternatives

- **Password-free sign-in (discoverable credentials)**: faster, but it needs account discovery,
  a new unauthenticated entry point, and recovery without a password. It is planned for after
  passkey-only accounts.
- **Our own WebAuthn verification**: no dependency, but CBOR, COSE and signature formats are easy
  to get subtly wrong. Not for security code.
