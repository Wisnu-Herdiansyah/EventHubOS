# Repository map against the technical architecture

Where each part of `TECHNICAL_ARCHITECTURE.md` lives, and how far it goes. ADRs explain the
decisions; `open-decisions.md` lists what blocks the rest. Updated with ADR-0052 (migrations
`0001`–`0031`).

**Status words**

- **Done:** built and tested for the first release.
- **Partial:** the core works; named pieces are still open.
- **Blocked:** waits for an open decision.
- **Not started:** planned, nothing built yet.

## Foundation

| Architecture element                                      | Location                                                                                   | Status                                                                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pnpm TypeScript monorepo                                  | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`                                | Done (ADR-0002)                                                                                                                                                                                                    |
| Typed, fail-closed configuration (§10)                    | `packages/config`                                                                          | Done for api, worker and migrator; admin and site validate their own (`apps/*/src/lib/config.ts`). Local-only adapters are refused in staging/production                                                           |
| Errors, permission catalog, domain events, provider ports | `packages/kernel` (ports and contract tests in `packages/kernel/src/testing`)              | Done. Permission catalog v2 (ADR-0045). Ports: `EventPublisher`, `EmailSender`, `ObjectStore`, `EmailFeedbackReceiver`                                                                                             |
| PostgreSQL schema, RLS, roles, migrations (§4, §5, §10)   | `packages/db/migrations` (`0001`–`0031`), `packages/db/src/{bootstrap,migrate}.ts`         | Done. Forced RLS on every tenant table; definer functions for public, worker and platform access; expand-only migrations checked in CI (`pnpm db:check`)                                                           |
| Tenant context propagation (§4)                           | `packages/db/src/transaction.ts`, `apps/api/src/modules/tenancy/access.ts`                 | Done (ADR-0003). Server-resolved membership, deny by default, two-step requirement (ADR-0024), support-access fallback (ADR-0045)                                                                                  |
| Audit, outbox, idempotency (§6)                           | `packages/db/src/{audit,outbox,idempotency}.ts`, `apps/api/src/http/idempotent-command.ts` | Done (ADR-0004)                                                                                                                                                                                                    |
| Core API, OpenAPI contract, consistent errors (§6)        | `apps/api` (Fastify), `apps/api/openapi.json`                                              | Done (ADR-0006). The contract is generated from route definitions, and CI checks that it is current; responses are validated against it outside production. Binary and raw-body routes since ADR-0042 and ADR-0043 |
| Structured logging, redaction, correlation IDs (§11)      | `apps/api/src/app.ts`, `packages/kernel/src/redaction.ts`                                  | Partial: done; W3C tracing and an observability stack are not chosen yet                                                                                                                                           |
| Worker and outbox relay (§2, §6)                          | `apps/worker`                                                                              | Done (ADR-0009): per-event transactions, dead-lettering, health log, replay CLI, waitlist-closing sweep. Runbook: `docs/operations/outbox-runbook.md`                                                              |
| CI: format, lint, types, tests, scanning, migrations      | `.github/workflows/ci.yml`                                                                 | Done: unit, integration (PostgreSQL 16), browser e2e, gitleaks and dependency audit. The e2e browser install falls back when the Ubuntu mirror is down                                                             |
| Infrastructure as code                                    | `infra/`                                                                                   | Not started: Google Cloud (ADR-0051) in Singapore (ADR-0052); needs the real project, billing and domain identifiers                                                                                               |

## Identity and access

| Element                                      | Location                                                                                                                                                      | Status                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Sign-up, verification, sign-in, lockout (§3) | `apps/api/src/modules/identity`, `apps/api/src/adapters/argon2id-password-hasher.ts`, migration `0002`                                                        | Done (ADR-0005, ADR-0007)                                                   |
| Password reset and change                    | identity module, migrations `0007`, `0008`                                                                                                                    | Done (ADR-0015, ADR-0016)                                                   |
| Sessions and idle timeout                    | `apps/api/src/modules/identity/authenticator.ts`, migrations `0009`, `0010`                                                                                   | Done (ADR-0017, ADR-0018)                                                   |
| Two-step verification                        | `apps/api/src/modules/identity/{mfa-routes,totp,mfa-crypto,passkey-routes}.ts`, `apps/api/src/adapters/simplewebauthn-passkeys.ts`, migrations `0013`, `0020` | Done: authenticator app with recovery codes (ADR-0022), passkeys (ADR-0033) |
| Organization requirement and reminders       | migrations `0015`, `0016`, `0017`, `0019`                                                                                                                     | Done (ADR-0024, ADR-0025, ADR-0026, ADR-0031)                               |
| SSO (SAML/OIDC), SCIM                        | —                                                                                                                                                             | Blocked on D3                                                               |
| Breached-password screening                  | —                                                                                                                                                             | Blocked on D14 (length-only policy today)                                   |

## Organizations and team

| Element                           | Location                                                                                          | Status                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organizations and settings        | `apps/api/src/modules/organization`, migrations `0003`, `0005`                                    | Done (ADR-0012): profile, billing contact, public handle, security settings. Retention settings wait for D9                                                                                           |
| Team: invitations, roles, removal | `apps/api/src/modules/membership`                                                                 | Done (ADR-0010, ADR-0012)                                                                                                                                                                             |
| Audit log viewer                  | `apps/api/src/modules/audit`, migration `0006`                                                    | Done: filtered, paginated, tenant-isolated (ADR-0013); CSV export up to 10,000 entries, itself audited (ADR-0047). Background export for larger logs waits for D1, D7                                 |
| Platform staff and support access | `apps/api/src/modules/{platform,support}`, `apps/api/src/cli/platform-staff.ts`, migration `0028` | Done (ADR-0045): operator-made staff, organization-granted read-only support access with per-request audit. Break-glass and write support later. Runbook: `docs/operations/platform-staff-runbook.md` |

## Events, pages and public sites

| Element                                   | Location                                                                                                              | Status                                                                                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Events, settings, lifecycle               | `apps/api/src/modules/event`, migration `0004`                                                                        | Done (ADR-0011): checklist, publish/unpublish, archive/restore, duplicate (ADR-0036), search and filters (ADR-0039)                                                            |
| Microsite builder, drafts, revisions (§7) | `apps/api/src/modules/page`, `packages/microsite`, `apps/admin/src/components/patterns/builder.tsx`, migration `0011` | Done (ADR-0020): typed, versioned sections; agenda v2 and speakers v3 (ADR-0040, ADR-0042). Rich text waits for D13                                                            |
| Public event sites                        | `apps/site`, `apps/api/src/modules/public-site`, migration `0012`                                                     | Done (ADR-0021): `{handle}.{domain}/{slug}`, published revisions only. CDN caching and edge limits: Cloud CDN and Cloud Armor (ADR-0051), configured with the staging IaC      |
| Asset library (images)                    | `apps/api/src/modules/asset`, `ObjectStore` adapters in `packages/kernel`, migration `0025`                           | Partial (ADR-0042): uploads re-encoded, speaker photos, public serving for published pages. Production store: a private Cloud Storage bucket in Singapore (ADR-0051, ADR-0052) |
| Custom domains (§8)                       | —                                                                                                                     | Not started: platform chosen (ADR-0051, Certificate Manager and the load balancer); waits for staging IaC                                                                      |
| Themes and sharing images                 | `settings.theme`, `settings.sharing.imageAssetId`, `EVENT_THEMES` in `packages/kernel`, migration `0029`              | Done (ADR-0046): tested colour presets and a library image for link previews. Custom brand colours later                                                                       |

## Registration and event day

| Element                 | Location                                                                                               | Status                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Free registration       | `apps/api/src/modules/registration`, `apps/site`, migration `0014`                                     | Done (ADR-0023): public sign-up, emailed cancel link, attendee list, CSV export (ADR-0027)             |
| Registration questions  | `apps/api/src/modules/registration/questions.ts`, migration `0024`                                     | Done (ADR-0041)                                                                                        |
| Waitlist                | migrations `0021`, `0023`, `apps/worker/src/waitlist-closer.ts`                                        | Done (ADR-0035, ADR-0038)                                                                              |
| Check-in and QR tickets | migration `0018`, `apps/admin/src/components/{check-in-desk,ticket-scanner}.tsx`                       | Done (ADR-0028, ADR-0029)                                                                              |
| Add to calendar         | `apps/site/src/lib/calendar.ts`, `apps/site/src/app/k`, `public-site` calendar route, migration `0030` | Done (ADR-0048): iCalendar file from the page, ticket and confirmation email. Subscription feeds later |
| Paid ticketing, billing | —                                                                                                      | Blocked on D2                                                                                          |

## Communication

| Element                     | Location                                                                                                                                                     | Status                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Transactional email         | `EmailSender` port, `apps/worker/src/adapters`, `apps/worker/src/consumers`                                                                                  | Done (ADR-0008): Resend plus local fakes; live contract via `pnpm test:live`                                                    |
| Announcements               | `apps/api/src/modules/announcement`, migration `0022`, worker `send-announcement`                                                                            | Done (ADR-0037)                                                                                                                 |
| Bounces and complaints      | `EmailFeedbackReceiver` port, `apps/api/src/{adapters/resend-email-feedback.ts,modules/email-feedback}`, `apps/worker/src/email-policy.ts`, migration `0026` | Done (ADR-0043). Configure the provider webhook before enabling it                                                              |
| Email notification settings | `NOTIFICATIONS` in `packages/kernel`, `apps/api/src/modules/notifications`, worker `send-data-download-email`, migration `0031`                              | Done (ADR-0049): per-person, per-organization settings; data download alerts to Owners and Admins; security notices always sent |
| SMS, WhatsApp               | —                                                                                                                                                            | Blocked on D4 (channels beyond email)                                                                                           |

## Reporting

| Element                        | Location                                                                                    | Status                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Event and organization reports | `apps/api/src/modules/report`                                                               | Done (ADR-0030, ADR-0032, ADR-0034): counts only, periods, CSV  |
| Page-view analytics            | migration `0027`, `public-site` count route, `apps/site/src/lib/{page-views,count-view}.ts` | Done (ADR-0044): daily counts per event, nothing about visitors |

## Web apps

| Element         | Location                                                                                | Status                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin web app   | `apps/admin` (ADR-0014)                                                                 | Done for every feature above: Next.js backend-for-frontend, HttpOnly session cookie, nonce CSP, API types generated from the contract, Playwright e2e and axe |
| Design system   | `apps/admin/src/styles`, `apps/admin/src/components/ui`, `docs/design/design-system.md` | Done (ADR-0019)                                                                                                                                               |
| Public site app | `apps/site`                                                                             | Done (ADR-0021): server-rendered, no cookies or browser storage, nonce CSP                                                                                    |

## Tests

| Kind                         | Location                                                                     | Notes                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Unit                         | `**/*.test.ts` (`pnpm test:unit`)                                            | No database                                                                            |
| Integration                  | `**/*.int.test.ts` in `apps/api/test`, `packages/db/src`, `apps/worker/test` | Disposable PostgreSQL 16 database per run (`pnpm test:integration`)                    |
| Cross-process (API + worker) | `tests/e2e/*.int.test.ts`                                                    | Run with integration tests                                                             |
| Browser end-to-end           | `apps/admin/e2e`                                                             | Builds admin and site, starts API, worker and both apps; accessibility checks with axe |
| Live provider contracts      | `*.live.test.ts` (`pnpm test:live`)                                          | Opt-in, needs provider credentials                                                     |
