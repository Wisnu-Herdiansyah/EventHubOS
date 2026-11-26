# ADR-0071: Single sign-on waits for the first enterprise customer

- Status: accepted
- Date: 2026-11-26
- Closes: the remaining part of D3 (SSO with SAML or OIDC, and SCIM) for now

## Context

Sign-in today is password with optional two-step codes (ADR-0022) or passkeys (ADR-0033), and
organizations can require two-step sign-in (ADR-0024). Enterprise customers often ask for single
sign-on through their own identity provider, and for SCIM to add and remove people
automatically.

## Decision

**Build no SSO until the first enterprise customer needs it**, and build it then for that
customer's identity provider. Decided with the product owner on 2026-11-26.

- Nothing is built speculatively. Identity providers differ, and the first customer's needs
  (SAML or OIDC, which provider, SCIM or not) decide the shape.
- The ground is ready: sign-in goes through the `SessionAuthenticator` port, sessions and
  two-step rules are separate from how a person proves who they are, and organization-level
  policy already exists (required two-step sign-in).
- When the customer arrives, the choice between building OIDC or SAML in and using a managed
  provider is made then, with their requirements, as a new ADR.

## Consequences

- Enterprise plans that require SSO cannot be sold yet. The repository map keeps "SSO, SCIM"
  marked as waiting.
- No new code, configuration or secrets.
