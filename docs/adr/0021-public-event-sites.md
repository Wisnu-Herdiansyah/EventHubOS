# ADR-0021: Public event sites

- Status: accepted
- Date: 2026-11-08
- Closes: open decision D6 (public routing convention)
- Builds on: ADR-0020 (drafts and published revisions)

## Decision

**Address.** A public event page lives at `https://{org-handle}.{platform domain}/{event-slug}`.

- **Handle:** `organization.public_handle`, 3–40 lowercase letters, digits and hyphens, unique on
  the platform. Owners and Admins set it (`organization.manage`). A list of reserved names (www,
  api, admin, …) cannot be used.
- **Platform domain:** configuration only (`SITE_DOMAIN`), never in code.
- **Custom domains:** a client's own domain stays with D1 (DNS, certificates, ownership checks)
  and will map onto the same handle.

**What is public.**

- Only the latest published revision (ADR-0020), and only when:
  - the event is `published`, `live` or `ended`;
  - its visibility is `public` or `unlisted`;
  - the organization is active.
- Hidden sections are removed on the server. Drafts are never read.
- Visitors have no tenant context, so one `SECURITY DEFINER` function, `public_event_page(handle,
slug)` (migration 0012), performs the whole lookup. The anonymous API route
  `GET /v1/public/sites/:handle/events/:eventSlug` returns it.
- Every other case is the same 404.
- Unlisted pages are `noindex`.

**Lifecycle.** Publishing is now real:

- `scheduled → published` requires:
  - the required checklist items;
  - visibility not private;
  - a published page revision;
  - an organization handle.

  Each failure has its own reason, which the admin explains before the button is offered.

- `published → scheduled` ("Take offline") closes the page.
- `published → live` and `→ ended` keep the page up.
- A published or live event cannot lose a required checklist item through a settings change.

**Site app.** `apps/site` is a separate Next.js app:

- No sessions, cookies or forms. Its CSP has `form-action 'none'` and nonce-only scripts.
- Its proxy resolves the host to a handle, accepting only a single valid label directly under
  `SITE_DOMAIN`, and rewrites to internal routes, which cannot be requested directly.
- It renders with `packages/microsite`, the same renderers and styles as the editor preview, so a
  published page looks exactly like what was reviewed.
- The event name is the page's `h1`; the event's language sets `lang`.

**Admin.**

- Settings has a Public address card. Changing the handle warns that it breaks shared links.
- The event page shows a Public page card with the live link (from `ADMIN_PUBLIC_SITE_URL`), a
  readiness list before publishing, and Publish, Take offline, Mark as live and End event.

**Local and e2e.** Chromium resolves `*.localhost` to the local machine, so the harness serves
sites at `http://{handle}.localhost:{port}` with `SITE_DOMAIN=localhost`.

## Consequences

- Organizers can take an event from draft to a live public page end to end.
- Renaming a handle breaks shared links; redirects from old handles can be added later if
  needed.
- No caching yet: pages are rendered per request (`no-store`). Edge caching with revision-based
  invalidation belongs with the CDN choice (D1). Per-visitor rate limits do too (D11).
- Registration is not part of the page yet: the call-to-action buttons link within the page
  until registration (Phase 4) exists.
