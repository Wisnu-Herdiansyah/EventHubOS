# ADR-0018: Idle session timeout

- Status: accepted
- Date: 2026-11-06
- Implements: idle timeout (threat model T5 follow-up), building on ADR-0017's `last_seen_at`

## Decision

A session ends after **`SESSION_IDLE_MINUTES`** without activity (default **60**, allowed
**15–1440**), in addition to its absolute lifetime (`SESSION_TTL_HOURS`, default 12).

- **Enforcement** happens on every authenticated request, in the database.
  `auth_resolve_and_touch_session(token_hash, idle_seconds)` is a new overload; the one-argument
  version is kept for the expand step. When the last recorded activity is older than the timeout,
  the session is **revoked on the spot**, so it can never be revived, and the request gets the
  ordinary `401`. The response does not say why: idle, expired and signed-out sessions look the
  same.
- **Precision.** Activity is recorded at most every 5 minutes (ADR-0017), so the effective timeout
  is within 5 minutes of the setting. That is the reason for the 15-minute floor.
- **No mass sign-out on deploy.** Sessions with no recorded activity, created before migration
  0009, start their idle clock at their next request instead of counting from sign-in.
- **Listing.** `auth_list_sessions(user, idle_seconds)` hides sessions that have gone idle but not
  yet been touched. `GET /v1/auth/sessions` also returns
  `policy: {idleMinutes, maxHours}`.
- **UX.** When a page finds the session no longer accepted, it sends the user to
  `/login?next=…&ended=1`. The sign-in page explains that the session ended ("for example after
  a period of inactivity") and returns them to where they were. The Account page states the
  policy in words.
- **Contract guard.** Building this exposed that a response could carry a field missing from its
  schema, because Zod strips unknown keys and the tests stayed green. With response validation on
  (local, CI, tests), the API now fails such a response and names the undocumented paths. Every
  existing route already complied.

## Consequences

- An unattended signed-in browser is useless to a passer-by after at most about an hour, or the
  configured timeout.
- There is no client-side countdown or "stay signed in?" prompt. If users ask for one, it can use
  the `policy` above.
- MFA remains the main open account-security item.
