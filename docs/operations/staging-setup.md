# Staging setup: Vercel and Google Cloud (ADR-0056)

What the product owner does by hand, in order. Secret values go straight into Secret Manager or
Vercel's settings. They are never pasted into chat, issues, commits or `.env` files.

The engineer has no credentials for the Google project, so **these commands have not been run by
the engineer**. Check each with `--help` if it is refused, and share the error text (never a
password or key).

## Status (2026-11-12)

| Item                       | State                                                                     |
| -------------------------- | ------------------------------------------------------------------------- |
| Vercel team                | Exists                                                                    |
| Google Cloud project       | `event-hub-2b58e` (the Firebase project), created by the product owner    |
| Billing (Blaze plan)       | **Not confirmed.** Cloud SQL and Cloud Run need it                        |
| Region                     | Singapore, `asia-southeast1` (ADR-0055)                                   |
| Database, bucket, registry | Not created yet (steps 2 to 4)                                            |
| Database connection method | **To decide with the engineer** before the services are deployed (step 5) |

## 1. Billing and tools

1. In the Firebase console, upgrade the project to the **Blaze** (pay-as-you-go) plan, and set a
   budget alert.
2. Install the Google Cloud CLI, then sign in and select the project:

```bash
gcloud auth login
```

```bash
gcloud config set project event-hub-2b58e
```

```bash
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com
```

## 2. Database: Cloud SQL for PostgreSQL 16

A small instance for staging. The tier can be changed later.

```bash
gcloud sql instances create eventhub-staging \
  --database-version=POSTGRES_16 --edition=enterprise --tier=db-custom-1-3840 \
  --region=asia-southeast1 --storage-auto-increase \
  --backup-start-time=18:00 --backup-location=asia-southeast1
```

```bash
gcloud sql databases create eventhub --instance=eventhub-staging
```

Set the admin password. The command asks for it, so it is not stored in your shell history. Save it
in a password manager: it is used only for the one-time bootstrap.

```bash
gcloud sql users set-password postgres --instance=eventhub-staging --prompt-for-password
```

## 3. Image bucket: Cloud Storage

Private, with public access blocked. Bucket names are global, so this one carries the project ID.

```bash
gcloud storage buckets create gs://event-hub-2b58e-images-staging \
  --location=asia-southeast1 --uniform-bucket-level-access --public-access-prevention
```

## 4. Image registry: Artifact Registry

```bash
gcloud artifacts repositories create eventhub --repository-format=docker --location=asia-southeast1
```

## 5. Stop here and tell the engineer

Say that steps 1 to 4 are done. No values are needed.

The next steps depend on one decision that is still open (ADR-0056, open point 1): how the API and
worker connect to Cloud SQL while keeping EventHub's rule that staging database connections are
encrypted and verified. After that, the engineer provides the exact commands for:

- the three database roles (bootstrap) and the migrations, as Cloud Run jobs;
- the secrets below;
- deploying the API and worker to Cloud Run;
- the Vercel projects.

## Settings, for reference

### API and worker (Secret Manager for secrets, plain settings on the Cloud Run service)

| Name                              | Used by     | Value                                                     | Secret     |
| --------------------------------- | ----------- | --------------------------------------------------------- | ---------- |
| `EVENTHUB_ENV`                    | both        | `staging`                                                 | no         |
| `DATABASE_APP_URL`                | API         | Connection as role `eventhub_app`                         | **Secret** |
| `DATABASE_WORKER_URL`             | worker      | Connection as role `eventhub_worker`                      | **Secret** |
| `DATABASE_MIGRATOR_URL`           | migrate job | Connection as role `eventhub_migrator`                    | **Secret** |
| `MFA_ENCRYPTION_KEY`              | API         | A new random 32 bytes, base64 (`openssl rand -base64 32`) | **Secret** |
| `EMAIL_TOKEN_SECRET`              | worker      | A new random string of at least 32 characters             | **Secret** |
| `RESEND_API_KEY`                  | worker      | From the email provider                                   | **Secret** |
| `OBJECT_STORE`                    | both        | `gcs`                                                     | no         |
| `GCS_BUCKET`                      | both        | `event-hub-2b58e-images-staging`                          | no         |
| `EVENT_PUBLISHER`                 | worker      | `postgres_outbox`                                         | no         |
| `EMAIL_SENDER`, `EMAIL_FROM`      | worker      | `resend`, and a sender on your verified domain            | no         |
| `APP_BASE_URL`, `PUBLIC_SITE_URL` | worker      | The admin origin; `https://{handle}.<your site domain>`   | no         |
| `PASSKEY_ORIGIN`                  | API         | The admin app's https origin                              | no         |

Images need no key: the services use their own service account (ADR-0051).

### Vercel project `eventhub-admin`

| Name                       | Value                                 | Secret |
| -------------------------- | ------------------------------------- | ------ |
| `ADMIN_API_URL`            | The API's Cloud Run https URL         | no     |
| `ADMIN_ORIGIN`             | The admin app's https origin          | no     |
| `ADMIN_TRUSTED_PROXY_HOPS` | `1`                                   | no     |
| `ADMIN_PUBLIC_SITE_URL`    | `https://{handle}.<your site domain>` | no     |

### Vercel project `eventhub-site`

| Name                      | Value                         | Secret |
| ------------------------- | ----------------------------- | ------ |
| `SITE_API_URL`            | The API's Cloud Run https URL | no     |
| `SITE_DOMAIN`             | Your site domain              | no     |
| `SITE_TRUSTED_PROXY_HOPS` | `1`                           | no     |
