# ADR-0058: Signed visitor addresses

- Status: accepted
- Date: 2026-11-16
- Closes: ADR-0056 open point 2 (client addresses)
- Builds on: ADR-0014 (admin web app), ADR-0023 (registration), ADR-0056 (Vercel and Google Cloud)

## Context

The API limits requests per visitor: sign-in attempts, sign-ups, registrations, page-view counts.
Visitors do not call the API themselves. The admin and site apps call it for them, so the API sees
the app's address, not the visitor's.

Until now the app forwarded the visitor's address in `X-Forwarded-For`, and the API believed that
header only from a listed address (`TRUST_PROXY`). On Vercel the apps have no fixed addresses, so
there is nothing to list. Without a fix, every visitor would share one limit: one person guessing
passwords could lock everyone out of signing in.

## Decision

The apps **sign** the visitor's address, and the API believes the signature instead of the caller's
address.

- **Header:** `X-EventHub-Visitor: v1,<time>,<address>,<signature>`.
- **Signature:** HMAC-SHA256 over the version, time and address, with a key shared by the API and
  the two apps.
- **Verification:** the API uses the address for rate limits only when the signature is valid and
  at most 120 seconds old (in either clock direction). Anything else — missing, malformed, forged,
  stale — falls back to the caller's own address, exactly as before.
- **One implementation:** signing and verification live together in
  `packages/kernel/src/visitor-address.ts`, used by the API, both apps and the test fixtures.

### Settings

| Setting                     | Where | Secret |
| --------------------------- | ----- | ------ |
| `VISITOR_ADDRESS_KEY`       | API   | yes    |
| `ADMIN_VISITOR_ADDRESS_KEY` | admin | yes    |
| `SITE_VISITOR_ADDRESS_KEY`  | site  | yes    |

All three hold the same value, at least 32 characters (for example `openssl rand -hex 32`). All are
optional: without a key, nothing changes from ADR-0014.

`ADMIN_TRUSTED_PROXY_HOPS` and `SITE_TRUSTED_PROXY_HOPS` keep their meaning. They decide which
address the app believes from its own platform; the app signs only that address, never one the
visitor wrote.

### What the address is used for

Rate limits only. It is not stored, not used for authorization, and not logged: the header is on
the log redaction list, because a captured header could be replayed for two minutes.

## Security notes

- **A visitor cannot forge an address.** They do not hold the key, and the app never signs their
  own claim.
- **A direct caller gains nothing.** Without a valid signature they are limited by their own
  address.
- **Replay is bounded.** The header travels only between our apps and the API, over TLS. A copy
  works for 120 seconds, and only to be counted as that visitor.
- **A leaked key** lets its holder pick which visitor a request is counted as, and so dodge
  per-visitor limits. It grants no access to data. Rotation: set a new value in all three places;
  during the changeover, calls signed with the other key fall back to the caller's address.
- **The apps are trusted with the key**, as they already are with session tokens.

## How it is tested

- **Unit (kernel):** round trip for IPv4 and IPv6; refusal of another key, a changed address or
  time, another version, a truncated signature, a stale or future time, other spellings of the
  time, a signed value that is not an address, and malformed input.
- **API:** each signed visitor has their own limit; forged, stale and unsigned requests share the
  caller's limit; without a key, signed headers are ignored.
- **Apps:** only the address reported by the trusted proxy is signed; nothing is signed without
  one.
- **End to end:** the browser suite now runs with **no proxy trusted by address**
  (`TRUST_PROXY=false`) and a per-run key. With verification disabled in the API, 70 of 78 tests
  fail on rate limits, so the suite depends on this path.
- **Mutation checks:** 19 of 20 mutations are caught. The survivor is the header length cap, which
  only bounds work on oversized input; no valid header is that long.

## Not settled here

- **Direct callers on Cloud Run.** Requests that reach the API without our apps (the email
  provider's webhook, or anyone on the internet) are limited by "the caller's address". On Cloud
  Run that may be Google's front end rather than the real caller, which would put all direct
  callers in one bucket. What the API sees must be measured on the real service (verification
  step 7) before choosing a fix. A bare hop count is not an option: the server framework refuses
  it on purpose, because it cannot check who the immediate caller is.
- **Limits are per API instance** until a shared store is approved (D11). Unchanged.

## Alternatives

- **Fixed egress addresses on Vercel**, listed in `TRUST_PROXY`. A paid add-on, and the list must
  be kept in step with the platform.
- **Private API with platform identity tokens** (the apps call Cloud Run with a Google-signed
  token). Stronger separation, but the email webhook and public images need the API reachable, and
  it ties both apps to one cloud's identity system. Can be added later; it does not replace
  telling the API who the visitor is.
- **Trust `X-Forwarded-For` from anyone.** Lets any visitor choose their own address.
