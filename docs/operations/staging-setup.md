# Staging setup: Vercel and Google Cloud (ADR-0056)

What the product owner does by hand, in order. Secret values go straight into Secret Manager or
Vercel's settings. They are never pasted into chat, issues, commits or `.env` files.

The engineer has no credentials for the Google project, so **these commands have not been run by
the engineer**. Check each with `--help` if it is refused, and share the error text (never a
password or key).

## Status (2026-11-12)

| Item                       | State                                                                  |
| -------------------------- | ---------------------------------------------------------------------- |
| Vercel team                | Exists                                                                 |
| Google Cloud project       | `event-hub-2b58e` (the Firebase project), created by the product owner |
| Billing (Blaze plan)       | **Not confirmed.** Cloud SQL and Cloud Run need it                     |
| Region                     | Singapore, `asia-southeast1` (ADR-0055)                                |
| Database, bucket, registry | Not created yet (steps 2 to 4)                                         |
| Database connection method | The Cloud SQL socket (ADR-0057); the URL form is under Settings        |

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
  --backup-start-time=18:00 --backup-location=asia-southeast1 \
  --enable-point-in-time-recovery --retained-transaction-log-days=7 --retained-backups-count=8
```

Point-in-time recovery with 7 days of logs and 8 daily backups is the recovery setting for
staging and production (ADR-0073). If the instance already exists, turn it on with:

```bash
gcloud sql instances patch eventhub-staging \
  --enable-point-in-time-recovery --retained-transaction-log-days=7 --retained-backups-count=8
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

## 5. Continue with the deployment guide

The next steps are in `staging-deploy.md`: four scripts for Google Cloud, then the two Vercel
projects.

## Settings, for reference

Each database URL uses the Cloud SQL socket form (ADR-0057), with the instance attached to the
Cloud Run service or job:

```
postgres://<role>:<password>@localhost/eventhub?host=/cloudsql/event-hub-2b58e:asia-southeast1:eventhub-staging
```

### API and worker (Secret Manager for secrets, plain settings on the Cloud Run service)

| Name                              | Used by     | Value                                                                                | Secret     |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------ | ---------- |
| `EVENTHUB_ENV`                    | both        | `staging`                                                                            | no         |
| `DATABASE_APP_URL`                | API         | Connection as role `eventhub_app`                                                    | **Secret** |
| `DATABASE_WORKER_URL`             | worker      | Connection as role `eventhub_worker`                                                 | **Secret** |
| `DATABASE_MIGRATOR_URL`           | migrate job | Connection as role `eventhub_migrator`                                               | **Secret** |
| `MFA_ENCRYPTION_KEY`              | API         | A new random 32 bytes, base64 (`openssl rand -base64 32`)                            | **Secret** |
| `EMAIL_TOKEN_SECRET`              | worker      | A new random string of at least 32 characters                                        | **Secret** |
| `RESEND_API_KEY`                  | worker      | From the email provider                                                              | **Secret** |
| `VISITOR_ADDRESS_KEY`             | API         | A new random string (`openssl rand -hex 32`); the same value in both Vercel projects | **Secret** |
| `OBJECT_STORE`                    | both        | `gcs`                                                                                | no         |
| `GCS_BUCKET`                      | both        | `event-hub-2b58e-images-staging`                                                     | no         |
| `EVENT_PUBLISHER`                 | worker      | `postgres_outbox`                                                                    | no         |
| `EMAIL_SENDER`, `EMAIL_FROM`      | worker      | `resend`, and a sender on your verified domain                                       | no         |
| `APP_BASE_URL`, `PUBLIC_SITE_URL` | worker      | The admin origin; `https://{handle}.<your site domain>`                              | no         |
| `PASSKEY_ORIGIN`                  | API         | The admin app's https origin                                                         | no         |

Images need no key: the services use their own service account (ADR-0051).

### Vercel project `eventhub-admin`

| Name                        | Value                                                        | Secret     |
| --------------------------- | ------------------------------------------------------------ | ---------- |
| `ADMIN_API_URL`             | The API's Cloud Run https URL                                | no         |
| `ADMIN_ORIGIN`              | The admin app's https origin                                 | no         |
| `ADMIN_TRUSTED_PROXY_HOPS`  | `1`                                                          | no         |
| `ADMIN_VISITOR_ADDRESS_KEY` | The same value as the API's `VISITOR_ADDRESS_KEY` (ADR-0058) | **Secret** |
| `ADMIN_PUBLIC_SITE_URL`     | `https://{handle}.<your site domain>`                        | no         |

### Vercel project `eventhub-site`

| Name                       | Value                                                        | Secret     |
| -------------------------- | ------------------------------------------------------------ | ---------- |
| `SITE_API_URL`             | The API's Cloud Run https URL                                | no         |
| `SITE_DOMAIN`              | Your site domain                                             | no         |
| `SITE_TRUSTED_PROXY_HOPS`  | `1`                                                          | no         |
| `SITE_VISITOR_ADDRESS_KEY` | The same value as the API's `VISITOR_ADDRESS_KEY` (ADR-0058) | **Secret** |
