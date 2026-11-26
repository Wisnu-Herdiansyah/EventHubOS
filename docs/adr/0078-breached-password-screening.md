# ADR-0078: Screen new passwords against breached passwords (Pwned Passwords)

- Status: accepted
- Date: 2026-11-26
- Closes: D14 (breached-password data source)

## Context

Passwords are checked for length only (ADR-0007). A password that already appears in breach
data is easy to guess, whatever its length. Decided with the product owner on 2026-11-26.

## Decision

- At **sign-up, password reset and password change**, the new password is checked against
  **Have I Been Pwned's Pwned Passwords range API**. It is free and needs no key
  ([HIBP](https://haveibeenpwned.com/API/v3)).
- **k-anonymity:** EventHub hashes the password with SHA-1 locally and sends only the **first 5
  characters** of the hash. The response lists matching suffixes, compared locally. The
  password and the full hash never leave the API. Requests ask for **padding**, so the response
  size reveals nothing
  ([Cloudflare](https://blog.cloudflare.com/pwned-passwords-padding-ft-lava-lamps-and-workers)).
- A password that appears in breach data is refused: "This password has appeared in a data
  breach. Choose a different one." How many times it appeared is not shown.
- **If the service is unreachable** (timeout of a few seconds, or an error), the password is
  **accepted on length alone** and the gap is logged with a counter. Sign-up is not blocked by
  an outside service.
- Behind a port (`BreachedPasswordChecker`) with an in-memory adapter for tests. The HIBP
  adapter must pass a shared contract. Existing passwords are not re-checked.

Set aside: an **offline list** (very large, needs manual refreshing) and **refusing while the
service is down** (an outside outage would stop sign-ups).

## Built

- **Port:** `BreachedPasswordChecker` in `packages/kernel/src/breached-passwords.ts`, answering
  `breached`, `clear` or `unknown`, and never throwing.
- **Adapters:**
  - `PwnedPasswordsChecker` (`apps/api/src/adapters`): SHA-1 locally, the 5-character prefix
    sent with `Add-Padding: true`, suffixes compared locally ignoring case, padding entries
    (count 0) never a match, 3-second timeout.
  - `InMemoryBreachedPasswordChecker`: a short built-in list, for tests.
- **Shared contract:** both adapters pass `testing/breached-password-checker.contract.ts`;
  the Pwned Passwords adapter is tested against a stand-in for the service, never the live
  API.
- **Configuration, `BREACHED_PASSWORD_CHECK`:** `pwned_passwords` by default, `in_memory` and
  `off` for local runs and tests. Staging and production refuse anything but
  `pwned_passwords`. The browser tests use `in_memory`.
- **Routes:**
  - **Sign-up:** checked before any account lookup, so the answer depends on the password only.
  - **Password reset:** checked before the link is used, so a refused password leaves the link
    working.
  - **Password change:** checked after the current password is verified, so someone without it
    learns nothing.
  - **Message:** the error is a field error on the password, shown by the existing forms.
- **Unavailable:** when the service cannot be asked, the password is accepted on length alone
  and the API logs `breached_password_check_skipped` with the reason (`timeout`, `error` or
  `status`), never the password or its hash.

### Tests

- **Contract and unit:** 13 tests, covering the prefix only, padding asked for, padding never a
  match, case, status codes, timeout, and the configured address.
- **Integration:** 6 tests:
  - each route refuses a breached password;
  - nothing is created or sent;
  - the same refusal for a registered address;
  - the reset link stays usable;
  - a wrong current password is reported first;
  - the source being unavailable, and screening off.
- **Config:** default, local values, and the refusal in staging and production.
- **Browser:** the message on the sign-up form, then a good password goes through.
- **Mutation checks:** 12 changes (each route's check, the unavailable rule, padding, case,
  status, prefix length, padding header, timeout reason, the remote refusal and the default):
  all caught.
