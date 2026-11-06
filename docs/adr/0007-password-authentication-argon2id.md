# ADR-0007: Password authentication with Argon2id

- Status: accepted
- Date: 2026-11-06
- Closes: open decision D3 for password identity. SSO (SAML/OIDC), SCIM, and MFA remain open.
- Amends: ADR-0005 (the identity boundary now has a first-party session issuer)

## Context

The product owner chose first-party email/password authentication using Argon2id with a
reviewed library, rather than a managed identity provider. The architecture forbids ad-hoc
password cryptography and requires verified email before organization creation (ORG-01).

## Decision

**Library.** `argon2` (node-argon2) `0.45.1`, which binds the Password Hashing Competition
reference implementation and emits PHC strings. Its prebuilt N-API binaries are used; install
scripts stay blocked (`ignoredBuiltDependencies`). The library sits behind the
`PasswordHasher` port (`apps/api/src/adapters/argon2id-password-hasher.ts`).

**Parameters.** Argon2id, m = 19 MiB, t = 2, p = 1 (OWASP Password Storage Cheat Sheet minimum).
Hashes made with other parameters are upgraded transparently on the next successful login
(`needsRehash`). Only `$argon2id$` hashes are accepted, enforced in code and by a CHECK constraint.

**Password policy** (NIST SP 800-63B): 12–128 Unicode code points, NFKC-normalised, no
composition rules, must not equal the email. A breached-password screen needs an approved data
source and is a follow-up.

**Storage.** `user_credential` and `email_verification_token` have no grants to runtime roles.
Every operation is a narrow `SECURITY DEFINER` function with a fixed `search_path`, each granted
to exactly one role (`eventhub_app` or `eventhub_worker`). Sessions and verification tokens are
256-bit random values stored only as SHA-256 hashes.

**Flows.**

- _Sign-up_ always answers `202` with the same body (no account enumeration). The password is
  hashed before any lookup so all outcomes cost the same.
- _Pre-hijacking defence_: signing up again with an **unverified** address replaces its password,
  bumps `credential_version`, and revokes its sessions and outstanding tokens. Verification tokens
  are bound to the credential version, and verifying revokes every existing session. A verified
  address is never modified by sign-up.
- _Verification email_: the API enqueues `identity.email_verification_requested` with
  identifiers only. The worker mints the token at send time, stores its hash, and emails a link
  carrying the token in the URL fragment (not sent to servers or in Referer headers). Delivery
  goes through the `EmailSender` port; consumers dedupe on `event_id`.
- _Login_ gives one `invalid_credentials` answer for unknown account, wrong password, or lockout,
  and verifies against a dummy hash for unknown accounts to equalise timing. After
  `LOGIN_MAX_FAILURES` (default 5) failures the account locks for `LOGIN_LOCK_SECONDS` (default
  900). Per-IP rate limit is 10/min on sign-up, login, and resend.
- _Sessions_ are bearer tokens with an absolute TTL (`SESSION_TTL_HOURS`, default 12).
  Logout revokes the current session.
- _Idempotency_: sign-up, login, verify, and logout are explicitly exempt (documented per route and
  in OpenAPI). Login in particular must not store issued tokens for replay. Resend requires a key.
- _Audit_: all identity actions are written as platform-scoped `identity.*` audit events
  (`organization_id` NULL), write-only for the runtime role. No email addresses or secrets are
  stored in audit metadata.

## Consequences

- Real users can now sign up, verify, and sign in locally. Staging and production still need an
  email provider (D4) and a durable broker (D5); the worker refuses local adapters there.
- Not yet built: password reset and change, session listing and revoke-all, MFA, breached-password
  screen, idle session timeout, cookie sessions with CSRF for the future admin web app, and a
  "someone tried to register your address" notice.
- `eventhub.resolve_session` is superseded by `auth_resolve_session` (expand step). It will be
  dropped in a later contract migration.
