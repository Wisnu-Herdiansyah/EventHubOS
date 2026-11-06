# ADR-0017: Active sessions list and sign-out

- Status: accepted
- Date: 2026-11-06
- Implements: session listing and revoke-all (ADR-0007 follow-up; threat model T5)

## Decision

People can see where they are signed in and end any of those sessions.

- **What a session records** (migration 0009, expand-only):
  - `last_seen_at`, refreshed at most every **5 minutes** by `auth_resolve_and_touch_session`.
    This supersedes `auth_resolve_session` (kept for the expand step), so an ordinary request
    adds no extra round trip and rarely a write.
  - `user_agent`, set at sign-in by a 5-argument `auth_complete_login` overload and truncated to
    256 characters.

  The user-agent is self-reported and informational only. It is never used for security
  decisions. The admin app forwards the browser's own user-agent rather than its server's.
  **No IP address is stored**: device and time are enough to recognise a session, and this keeps
  personal data minimal.

- **API**, always scoped to the caller:
  - `GET /v1/auth/sessions` lists live sessions, most recently active first, marking the current
    one. Token hashes are never returned.
  - `POST /v1/auth/sessions/:sessionId/revoke` signs out one session. Someone else's session, an
    expired one and an unknown ID all answer `404`, so the endpoint reveals nothing. Revoking the
    current session works like logout.
  - `POST /v1/auth/sessions/revoke-others` signs out everything except the current session and
    returns the count.

  Revocations are audited (`identity.session_revoked`, `identity.other_sessions_revoked`) with
  session IDs and counts only. The revoke routes are idempotency-exempt: a repeat changes nothing.

- **UI.** The Account page gains "Signed-in sessions":
  - each session shows a readable device name ("Safari on iPhone"), how long ago it was last
    active, and its sign-in date;
  - a "This device" badge marks the current session;
  - each other session has a sign-out button whose accessible name includes the device;
  - "Sign out all other sessions" ends the rest.

  Confirmations are page-level notices from allow-listed codes.

- **Guard.** A new contract test checks that route paths use Fastify's `:name` syntax and declare
  exactly their parameters. A `{sessionId}` typo made a route unreachable during development;
  the test now catches that class of bug before integration tests.

## Consequences

- Threat model T5 now has revoke-all. Idle timeout and MFA remain open.
- Session rows created before 0009 keep working. They show as "Unknown browser" until the user
  signs in again.
- A future security-events page could reuse the audit records. No new tables would be needed.
