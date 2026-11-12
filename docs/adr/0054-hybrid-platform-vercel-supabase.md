# ADR-0054: Hybrid platform: Vercel, Supabase and Cloud Run (replaces ADR-0051)

- Status: accepted, pending the verification check below
- Date: 2026-11-12
- Decision owner: product owner (D1). Replaces ADR-0051 (Google Cloud for everything)
- Keeps: ADR-0052 (Singapore), ADR-0053 (container images)
- Leaves open: D8 (RPO and RTO), D10 (legal artefacts), D11 (shared cache and rate-limit store)

## Decision

| Piece                            | Where                                                                   | Region (ADR-0052)               |
| -------------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| Admin app, public site (Next.js) | **Vercel**                                                              | Functions in `sin1` (Singapore) |
| Organizer subdomains and domains | **Vercel** domains (wildcard `{handle}` subdomains, custom domains)     | Edge network                    |
| API (Fastify)                    | **Vercel** Functions                                                    | `sin1`                          |
| PostgreSQL 16                    | **Supabase** Postgres, connected through its pooler                     | Southeast Asia (Singapore)      |
| Uploaded images                  | **Supabase Storage**, a private bucket (built in this change)           | Same Supabase project           |
| Worker (outbox relay and emails) | **Cloud Run** container (the `worker` image, ADR-0053), always on       | `asia-southeast1`               |
| Secrets                          | Vercel and Supabase environment settings; Secret Manager for the worker | Per provider                    |

### Choices made inside the decision

- **The worker stays a container.** Its loop polls the outbox every second, and Vercel Functions
  do not run continuously. Vercel Cron would delay emails by up to a minute, and Vercel Queues is
  in public beta. The worker image is already built and smoke-tested, and Cloud Run in Singapore
  needs no new provider.
- **The API runs on Vercel** next to the apps that call it. Its in-process rate limiting becomes
  per function instance, which is weaker, so D11 (a shared store, for example Redis from the
  Vercel Marketplace) is now needed before production.
- **Images go to Supabase Storage,** in the same project and region as the database, under the
  existing `ObjectStore` port. The Cloud Storage adapter (ADR-0051) stays available, but staging
  and production use `supabase`.

### Built in this change

- **`SupabaseStorageObjectStore`** (`@eventhub/kernel/supabase-object-store`) behind the
  `ObjectStore` port:
  - the official SDK (`@supabase/storage-js` 2.118.0, pinned) sits behind the same `BucketClient`
    as the Cloud Storage adapter, and the shared rules live in one `BucketObjectStore`;
  - uploads overwrite and are sent with `Cache-Control: no-store`;
  - a missing object reads as `null` and deletes as success, in both forms Storage reports it
    (404, or 400 with `statusCode` "404");
  - errors carry only the operation and status: never the key, URL or request details.
- **Configuration:**
  - `OBJECT_STORE=supabase` needs `SUPABASE_URL` (https only), `SUPABASE_STORAGE_BUCKET` and
    `SUPABASE_SECRET_KEY` (from the secret store);
  - `supabase` and `gcs` are the only stores accepted in staging and production;
  - log redaction now also covers `secretKey` and `apiKey` up to three levels deep, and the
    `apikey` header. pino's `*` matches only one level, so each depth is listed; a test logs a
    nested configuration object and checks the key never appears.
- **Tests:**
  - the shared `ObjectStore` contract against the adapter with an in-memory bucket;
  - the SDK glue against a stand-in client, including that errors never contain the key;
  - the configuration rules;
  - an opt-in live contract (`pnpm test:live`, `SUPABASE_CONTRACT_*`), which also proves the bucket
    refuses public reads.

## Verification before staging (needs the product owner's projects)

These are assumptions until checked against a real Supabase project and Vercel team in
Singapore. The checklist is in `docs/operations/hybrid-platform-verification.md`.

1. Our bootstrap creates the three least-privilege roles on Supabase, whose `postgres` role is not
   a full superuser, and forced row-level security holds for them.
2. Supabase's Data API does not expose the `eventhub` schema.
3. Per-transaction tenant settings (`set_config(..., true)`) and advisory locks work through the
   pooler in transaction mode, which serverless functions need. The integration suite passes
   against it.
4. The Fastify API runs on Vercel Functions in `sin1`, and the admin and site reach it.
5. Where Vercel keeps logs and build output, recorded against ADR-0052 (Singapore). Until this is
   checked, no claim is made that every copy of the data stays in Singapore.

## Alternatives

- **Everything on Google Cloud (ADR-0051).** Simpler permissions and one region guarantee, but more
  set-up for domains and certificates. Replaced at the product owner's request.
- **The worker on Vercel Cron or Vercel Queues.** Covered above: up to a minute of email delay, or a
  beta dependency for production email.
- **Supabase Auth.** Not used: EventHub has its own identity, sessions and two-step verification
  (ADR-0005 to ADR-0033).

## Consequences

- Three providers: Vercel, Supabase, and Google Cloud for the worker only.
- D11 (shared rate-limit store) moves up: it is needed before the API serves production traffic
  on Vercel.
- The container images keep their value: the worker runs from one, and CI keeps smoke-testing all
  four.
