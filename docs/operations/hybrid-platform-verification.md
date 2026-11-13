# Platform verification (ADR-0056)

A check before staging takes real use, run against the product owner's Google Cloud project
(`event-hub-2b58e`) and Vercel team. Nothing here may use production data. Record each result in
ADR-0056, and the regions and speed in ADR-0055.

Setup steps for the product owner are in `staging-setup.md`.

## Steps

1. **Roles and RLS.** Run the bootstrap and migration jobs from the `api` image. Expect all 32
   migrations to apply and the three roles to exist without `BYPASSRLS`. Cloud SQL's `postgres`
   user is not a full superuser, so a permission error here is the first thing to look for.
2. **Database connections (ADR-0057).** The API, worker and jobs connect through the Cloud SQL
   socket Cloud Run mounts, with the instance attached to each service. Confirm the instance has
   no public address open to the internet, and that a service without the instance attached
   cannot connect.
3. **Integration suite.** Run `pnpm test:integration` against a disposable database on the
   instance. Expect every test to pass, including tenant isolation and idempotency.
4. **Images.** Run `pnpm test:live` with `GCS_CONTRACT_BUCKET` set to a private test bucket.
   Expect the contract and the "private and uncached" test to pass.
5. **API and worker on Cloud Run.** Deploy both from the images CI builds. Check
   `/health/ready`, and that the worker delivers a verification email.
6. **Admin and site on Vercel.** Deploy both pointing at the API. Sign in, publish an event, and
   open its public page on a wildcard preview domain.
7. **Client addresses (ADR-0056 open point 2).** Decide how the API learns the visitor's address
   when called from Vercel, and confirm the per-visitor limits behave as intended.
8. **Regions and speed.** Record the Vercel Functions region chosen for the admin and site, and
   the API-to-database round trip (for example, the median `/health/ready` time over 20 calls).
   Copy them into ADR-0055.

If a step fails, stop and record why. Steps 1 to 3 decide whether Cloud SQL can hold the database
as designed.
