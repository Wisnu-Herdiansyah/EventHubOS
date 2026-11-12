# Hybrid platform verification (ADR-0054)

A one-day check before staging, run against real projects the product owner creates. Nothing here
may use production data. Record each step's result in ADR-0054.

## What the product owner provides

- A Supabase project in **Southeast Asia (Singapore)**, its database connection strings (direct
  and pooler) and its server-side secret key, all held in a secret store.
- A Vercel team, with Functions region `sin1`.
- A private Storage bucket in that project for the contract test.

## Steps

1. **Roles and RLS.** Run `pnpm db:bootstrap` with the project's admin connection, then
   `pnpm db:migrate`. Expect all migrations to apply and the three roles to exist without
   `BYPASSRLS`.
2. **Data API.** In the project's API settings, confirm `eventhub` is not an exposed schema. A
   request for an `eventhub` table through the Data API must fail.
3. **Pooler.** Run `pnpm test:integration` with `TEST_DATABASE_ADMIN_URL` pointing at a disposable
   database on the project, through the pooler in transaction mode. Expect every test to pass,
   including tenant isolation and the idempotency tests.
4. **Storage.** Run `pnpm test:live` with `SUPABASE_CONTRACT_URL`, `SUPABASE_CONTRACT_BUCKET` and
   `SUPABASE_CONTRACT_SECRET_KEY`. Expect the contract and the "bucket is private" test to pass.
5. **API on Vercel.** Deploy the API to a preview in `sin1` and check `/health/ready` against the
   project's pooler.
6. **Admin and site on Vercel.** Deploy both to previews pointing at that API. Sign in, publish an
   event, and open its public page on a wildcard preview domain.
7. **Residency.** Record where Vercel stores runtime logs and build output for the team, against
   ADR-0052.

If a step fails, stop and record why. Steps 1 to 3 decide whether Supabase can hold the database
as designed.
