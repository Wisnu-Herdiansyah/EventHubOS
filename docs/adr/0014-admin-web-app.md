# ADR-0014: Admin web app (Next.js backend-for-frontend)

- Status: accepted
- Date: 2026-11-06
- Implements: Phase 1 admin UI (roadmap), first slice: sign-up, email verification, sign-in,
  invitation acceptance, organizations, events (create, settings, lifecycle)

## Decision

`apps/admin` is a Next.js 16 (App Router, React 19) app that acts as a **backend-for-frontend**.
The browser talks only to the admin app. The admin app talks to the API with the user's session
token. Nothing in the browser holds a credential.

- **Session:** the API's bearer token is stored only in the `__Host-eventhub_session` cookie:
  `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`, expiring with the API session.
  Page scripts cannot read it, and it is sent only to this exact host. Browsers treat
  `http://localhost` as a secure context, so local and e2e runs need no TLS.
- **Mutations are Server Actions.** Next.js rejects any action whose `Origin` does not match the
  host. Together with `SameSite=Lax`, this is the CSRF defense. The e2e suite forges a
  cross-origin action and checks that it fails and the session survives.
- **API calls** go through `openapi-fetch` typed from the generated `apps/api/openapi.json`
  (`pnpm --filter @eventhub/admin generate:api-types`). Contract drift breaks `typecheck`. Each
  call gets an `admin-<uuid>` correlation ID, which is shown to the user as a reference on errors.
  Unexpected errors are never echoed to the browser.
- **Authorization stays in the API.** The UI hides actions a role cannot take, as a convenience
  only. Another tenant's organization or event renders 404, the same as the API.
- **Content Security Policy:** a per-request nonce set in `src/proxy.ts`:
  `script-src 'nonce-…' 'strict-dynamic'` and `style-src 'nonce-…'`, with no `unsafe-inline` and
  no `unsafe-eval` outside `next dev`. It also sets `object-src 'none'`, `base-uri 'none'`,
  `form-action 'self'` and `frame-ancestors 'none'`. Every page renders dynamically so the nonce
  is fresh. Static headers (`nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Permissions-Policy`, COOP) live in `next.config.ts`.
- **Single-use tokens** (verification, invitation) arrive in the URL fragment, which servers and
  Referer headers never see. The page removes them from the address bar before submitting. An
  invitation token waits in `sessionStorage` (this tab only) while the visitor signs in, and is
  cleared once used.
- **Redirects after sign-in** accept only same-site paths (`safeNext`). Absolute URLs,
  protocol-relative paths, backslashes and control characters are rejected.
- **Client IP:** Next.js passes a client-sent `X-Forwarded-For` through unchanged, so the admin
  app never forwards it as-is. With `ADMIN_TRUSTED_PROXY_HOPS=N`, it forwards only the address
  that the outermost trusted proxy appended (the N-th entry from the right). With 0, it forwards
  nothing. The API trusts only the admin app's address (`TRUST_PROXY` accepts a list of
  IPs/CIDRs; `true` is refused in staging/production).
- **Times** are entered and shown in the event's time zone and converted to UTC instants on the
  server.
- **Accessibility:** labelled inputs, with errors tied to their fields through
  `aria-describedby`/`aria-invalid`. Form errors are announced (`role=alert`) and successes are
  polite (`role=status`). Focus is visible, a skip link is provided, targets are at least
  2.75rem, and reduced motion is respected. axe (WCAG 2.2 A/AA) runs in e2e on every journey page.
  Failed forms keep what the user typed, except passwords and tokens.
- **Visual identity:** navy, beige, gold and rose-gold tokens, a serif display face with a
  sans-serif body, and no web fonts or inline styles (keeps the CSP strict).

## Team management (second slice)

`/orgs/{id}/team` is for Owners and Admins (`membership.read`/`membership.manage`). It lists
members, sends invitations, shows pending invitations (with revoke) and recent history, changes
roles, and removes members (or lets you leave).

- **One permission catalog.** The UI imports `roleHasPermission`/`canAssignRole` from
  `@eventhub/kernel`, the same code the API enforces, instead of keeping a copy. Role pickers
  offer only roles the viewer may grant, and rows the viewer may not affect have no controls. The
  API remains the authority, and its errors (last Owner, role ceiling) are shown inline.
- **Destructive actions take two steps:** a disclosure, then a button naming the person.
- **Page-level confirmations:** when a row disappears (removed, revoked), the confirmation is
  shown at page level from an allow-listed `notice` code. URL text is never echoed.
- **Leaving:** removing yourself returns you to the organization list.

## OpenAPI fix shipped with this slice

Generating client types exposed `$ref`s to nested `$defs` that did not resolve from the document
root. `openapi.ts` now hoists `$defs` into `components.schemas` and fails on conflicting
definitions. A test asserts that every `$ref` resolves.

## Testing

- Unit (Vitest): redirect safety, CSP builder, error mapping, time-zone conversion, client-IP
  selection, form-data helpers.
- End-to-end (`pnpm --filter @eventhub/admin e2e`): creates a disposable database with the
  production role model, runs the real API and worker (emails to a temp folder) and the
  production build, then runs Playwright/Chromium against them. It covers:
  - the full organizer journey and the invitation journey;
  - cookie flags, the CSP nonce on every script, and security headers;
  - sign-in return paths and open-redirect attempts;
  - cross-tenant 404s;
  - forged cross-origin Server Actions;
  - axe accessibility scans.

  Mutation checks confirmed the suite fails when `HttpOnly` is dropped or `safeNext` is
  bypassed. Each test browses from its own simulated client IP, which also exercises
  `ADMIN_TRUSTED_PROXY_HOPS`.

## Consequences

- Deployed environments must set `ADMIN_TRUSTED_PROXY_HOPS` to the number of proxies in front of
  the admin app. They must also list the admin app's egress addresses in the API's `TRUST_PROXY`.
  Without both, every user shares the admin server's per-IP auth limit (10/min).
- How the app is packaged and hosted (standalone output, container, edge) waits on the cloud
  decision (D1). Today it runs with `next build && next start`.
- The UI still lacks organization settings and the audit log viewer (API ready), plus
  resend-verification and password reset. Those are the next UI slices.
- Session idle timeout and revoke-all remain open (threat model T5).
