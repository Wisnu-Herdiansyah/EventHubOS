# ADR-0016: Change password while signed in

- Status: accepted
- Date: 2026-11-06
- Implements: password change (deferred in ADR-0007 and ADR-0015)

## Decision

`POST /v1/auth/password/change {currentPassword, newPassword}` requires a session.

- **Re-authentication.** The current password is verified against the stored Argon2id hash. A
  wrong attempt counts toward the same progressive lockout as login (`LOGIN_MAX_FAILURES`), so a
  stolen session cannot be used to guess the password. While locked, even the right password is
  refused here and at login, and the message points to reset by email. Failures are audited
  (`identity.password_change_failed`) and committed before the error is returned.
- **Policy.** The sign-up policy applies (12–128 characters, NFKC). The new password must not be
  the email address or the current password. Policy errors are not counted as failures.
- **Effect** (`auth_change_password`, one transaction):
  - replaces the hash and bumps `credential_version`, so every outstanding reset and
    verification link dies;
  - clears login throttling;
  - revokes **every other session**. The session making the change stays signed in, which is
    the common expectation.

  The response reports how many other sessions were signed out.

- **Notification.** It enqueues `identity.password_changed`, so the owner gets the same "your
  password was changed" email as after a reset (ADR-0015). The wording now reads "your other
  signed-in sessions were signed out", which is true for both flows.
- **Idempotency.** The route is exempt because it re-authenticates. After a success, a repeat
  fails the current-password check and changes nothing.
- **Privileges.** Migration 0008 adds two `SECURITY DEFINER` functions for `eventhub_app` only:
  `auth_credential_for_user` and `auth_change_password`. The latter refuses to act unless the
  calling session is still valid for that user.
- **UI.** `/account` is linked from the header. A change-password form shows inline errors, never
  echoes either password, and links to reset by email for a forgotten current password.

## Consequences

- A stolen session alone can no longer take over an account by changing its password.
- Not built: session listing and per-device sign-out, MFA, breached-password screen.
