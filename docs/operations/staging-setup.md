# Staging setup: Supabase and Vercel (ADR-0054, ADR-0055)

What the product owner does by hand, in order. Secret values go straight from each provider's
dashboard into Vercel's settings. They are never pasted into chat, issues, commits or `.env`
files.

## Status (2026-11-12)

| Item                  | State                                                                          |
| --------------------- | ------------------------------------------------------------------------------ |
| Vercel team           | Exists                                                                         |
| Supabase organization | Exists, free plan, two active projects (the free limit)                        |
| Supabase project      | **Blocked:** creating `eventhub-os-staging` was refused by the free-plan limit |
| Region                | Singapore (`ap-southeast-1`), chosen by the product owner (see ADR-0055)       |
| Postgres 17           | Checked locally: 408 of 408 integration tests pass on PostgreSQL 17.11         |

## 1. Make room for the project (Supabase)

Do one of these in the Supabase dashboard, then create the project:

- upgrade the organization to a paid plan; or
- pause or delete a project you no longer need.

Create a project named `eventhub-os-staging` in **Southeast Asia (Singapore)**. Save the database
password it shows in a password manager: it is the admin password, used only in steps 2 and 3.

## 2. Create the database roles (once)

Run on your own machine, from the repository, with values from the dashboard's **Connect** panel.
Use the **direct** connection for this step. Choose three new random passwords, at least 32
characters each.

```bash
DATABASE_ADMIN_URL='<direct connection string, sslmode=require>' \
EVENTHUB_MIGRATOR_PASSWORD='<new random>' \
EVENTHUB_APP_PASSWORD='<new random>' \
EVENTHUB_WORKER_PASSWORD='<new random>' \
pnpm db:bootstrap
```

```bash
EVENTHUB_ENV=staging \
DATABASE_MIGRATOR_URL='<direct connection string as eventhub_migrator, sslmode=require>' \
pnpm db:migrate
```

If the direct connection cannot be reached from your network, use the pooler string in
**session** mode for this step (not transaction mode).

Expect `bootstrap complete` and `migrations: applied [0001 … 0032]`. If bootstrap fails on a
permission, stop and share the error text (not the connection string): that is verification step 1
in `hybrid-platform-verification.md`.

## 3. Storage bucket

In **Storage**, create a **private** bucket named `eventhub-images`. Do not make it public.

## 4. Settings in Vercel

Three Vercel projects: `eventhub-api`, `eventhub-admin` and `eventhub-site`. Mark every row
labelled **Secret** as **Sensitive** in Vercel. Use the **pooler** connection string, in
transaction mode, for `DATABASE_APP_URL`.

### `eventhub-api`

| Name                      | Value                                                                      | Secret     |
| ------------------------- | -------------------------------------------------------------------------- | ---------- |
| `EVENTHUB_ENV`            | `staging`                                                                  | no         |
| `DATABASE_APP_URL`        | Pooler string as role `eventhub_app`, with its password, `sslmode=require` | **Secret** |
| `MFA_ENCRYPTION_KEY`      | A new random 32 bytes, base64 (`openssl rand -base64 32`)                  | **Secret** |
| `OBJECT_STORE`            | `supabase`                                                                 | no         |
| `SUPABASE_URL`            | The project URL, `https://<ref>.supabase.co`                               | no         |
| `SUPABASE_STORAGE_BUCKET` | `eventhub-images`                                                          | no         |
| `SUPABASE_SECRET_KEY`     | The project's secret (server-side) API key                                 | **Secret** |
| `PASSKEY_ORIGIN`          | The admin app's https origin                                               | no         |
| `TRUST_PROXY`             | Set during verification, once Vercel's proxy addresses are known           | no         |

### `eventhub-admin`

| Name                       | Value                                 | Secret |
| -------------------------- | ------------------------------------- | ------ |
| `ADMIN_API_URL`            | The API's https URL                   | no     |
| `ADMIN_ORIGIN`             | The admin app's https origin          | no     |
| `ADMIN_TRUSTED_PROXY_HOPS` | `1`                                   | no     |
| `ADMIN_PUBLIC_SITE_URL`    | `https://{handle}.<your site domain>` | no     |

### `eventhub-site`

| Name                      | Value               | Secret |
| ------------------------- | ------------------- | ------ |
| `SITE_API_URL`            | The API's https URL | no     |
| `SITE_DOMAIN`             | Your site domain    | no     |
| `SITE_TRUSTED_PROXY_HOPS` | `1`                 | no     |

### Later, for the worker (its own host's secret store, not Vercel)

`DATABASE_WORKER_URL` (role `eventhub_worker`), `EMAIL_TOKEN_SECRET`, `RESEND_API_KEY`, and
`SUPABASE_SECRET_KEY` are **Secret**. `EVENTHUB_ENV`, `EVENT_PUBLISHER=postgres_outbox`,
`EMAIL_SENDER=resend`, `EMAIL_FROM`, `APP_BASE_URL`, `PUBLIC_SITE_URL`, `OBJECT_STORE` and the
other `SUPABASE_*` names are not.

## 5. Tell the engineer

Say that steps 1 to 4 are done and give the Supabase project's name. No values are needed. The
remaining verification (Data API exposure, deployment checks, speed) continues from there.
