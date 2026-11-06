# ADR-0005: Identity provider boundary (interim)

- Status: accepted; amended by ADR-0007 (password sessions are now issued first-party)
- Date: 2026-11-06

## Context

The PRD defaults to email/password + verification + invitations, with plan-gated SSO/SCIM.
The architecture forbids ad-hoc password cryptography. The identity vendor/library is unresolved.

## Decision

- The API depends only on the `SessionAuthenticator` port (`apps/api/src/modules/identity`).
- The shipped implementation verifies opaque, high-entropy bearer tokens whose SHA-256 hashes are
  stored in `auth_session`, resolved via a `SECURITY DEFINER` function. Expired/revoked sessions
  are rejected.
- **Not implemented, blocked on decision:** sign-up, login, password storage, email verification
  delivery, MFA, session issuance/rotation/revocation endpoints, cookie sessions + CSRF, SSO/SCIM.
  Tests seed users and sessions through a fixture helper.
- Bearer tokens (not cookies) are used for the API in this slice, so CSRF does not apply yet;
  adopting cookie sessions for the admin web app requires CSRF protection per architecture §9.

## Consequences

The API is not usable end-to-end by real users until the identity adapter lands. All
authorization logic downstream of the principal is complete and tested.
