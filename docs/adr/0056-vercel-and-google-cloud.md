# ADR-0056: Vercel for the web apps, Google Cloud for the backend (replaces ADR-0054)

- Status: accepted, pending the verification in `docs/operations/hybrid-platform-verification.md`
- Date: 2026-11-12
- Decision owner: product owner (D1). Replaces ADR-0054 (Vercel, Supabase, Cloud Run worker)
- Keeps: ADR-0053 (container images), ADR-0055 (region rule: everything follows the database)
- Google Cloud project: `event-hub-2b58e` (created by the product owner as a Firebase project)

## Context

The Supabase project could not be created: the organization's free plan was at its limit of two
active projects. The product owner had already created a Firebase project and asked to use it
instead.

A Firebase project is a Google Cloud project. Firebase's own databases, Firestore and Realtime
Database, are document stores. EventHub is built on PostgreSQL: 32 SQL migrations, forced
row-level security, least-privilege roles, definer functions and transactional outbox and audit
writes. So "Firebase" here means the Google Cloud services in that project, not Firestore.

## Decision

| Piece                              | Where                                                    |
| ---------------------------------- | -------------------------------------------------------- |
| Admin app, public site (Next.js)   | **Vercel**                                               |
| Organizer subdomains and domains   | **Vercel** domains                                       |
| API (Fastify)                      | **Cloud Run**, from the `api` image (ADR-0053)           |
| Worker                             | **Cloud Run**, from the `worker` image, always on        |
| PostgreSQL                         | **Cloud SQL for PostgreSQL 16**, the version CI tests    |
| Uploaded images                    | **Cloud Storage**, a private bucket (`OBJECT_STORE=gcs`) |
| Secrets for the API and worker     | **Secret Manager**                                       |
| Images registry                    | **Artifact Registry**                                    |
| Database jobs (bootstrap, migrate) | **Cloud Run jobs**, from the `api` image                 |

**Region:** Singapore, `asia-southeast1`, for every Google Cloud resource, as the product owner
chose (ADR-0055). The Vercel Functions of the admin and site run in the Vercel region closest to
it.

### Why the API moved to Cloud Run

- **It sits next to the database.** That is the ADR-0055 rule, and Cloud Run reaches Cloud SQL
  over the project's private network. Vercel Functions would need a public database address or
  extra networking, and Cloud SQL has no public connection pooler like Supabase's.
- **Its in-process rate limiting works again** with a small, steady number of instances. D11 (a
  shared store) goes back to being needed only when the API runs many instances.
- **The image exists** and is smoke-tested in CI, including bootstrap and migrations.

### Not Firestore, and not Firebase Authentication

- **Firestore or Realtime Database** would mean rewriting the data layer, and losing
  database-enforced tenant isolation, which is a standing rule.
- **Firebase Authentication** is not used: EventHub has its own identity, sessions and two-step
  verification (ADR-0005 to ADR-0033).

### What does not change

- **No application code changes.** `CloudStorageObjectStore` (ADR-0051) is already built and
  tested, and uses the service account's own identity: no key file.
- The Supabase Storage adapter (ADR-0054) stays in the code, unused. `supabase` and `gcs` remain
  the only object stores accepted in staging and production.

## Open points, checked during verification

1. **TLS to Cloud SQL: closed by ADR-0057.** The API and worker connect through the socket Cloud
   Run mounts for the instance, and staging accepts exactly that form. To confirm on the real
   instance during verification.
2. **Client addresses.** The admin and site call the API from Vercel, which has no fixed
   addresses, so the API cannot use an address list (`TRUST_PROXY`) to decide whose forwarded
   client address to believe. Until this is settled, per-visitor limits at the API fall back to
   the caller's address.
3. **Cost.** Cloud SQL and Cloud Run need billing enabled on the project (the Blaze plan).
   Cloud SQL has no permanent free tier.

## Alternatives

- **Supabase (ADR-0054).** Blocked by the free-plan limit, and it would have been a third provider
  next to Cloud Run for the worker.
- **The API on Vercel Functions with Cloud SQL.** Covered above.
- **Everything on Google Cloud (ADR-0051).** Still possible. Vercel stays for the Next.js apps and
  organizer domains, where it needs the least set-up.
- **Firebase App Hosting for the Next.js apps.** It would make the stack one provider. Not chosen
  now: the product owner has a Vercel team, and custom domains for organizers are simpler there.

## Consequences

- Two providers: Vercel and Google Cloud.
- The product owner runs the set-up commands: the engineer has no credentials for the project, and
  secrets never pass through chat. See `docs/operations/staging-setup.md`.
