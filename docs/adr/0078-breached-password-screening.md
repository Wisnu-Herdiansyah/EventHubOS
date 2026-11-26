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

## To build (next slice)

The port, the adapter, wiring into the three password routes, and the error message in the
admin forms.
