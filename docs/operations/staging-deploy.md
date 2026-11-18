# Staging deployment: commands (ADR-0059)

What the product owner runs after `staging-setup.md` steps 1 to 4. Four scripts for Google Cloud,
then two projects on Vercel.

**Not yet run against Google or Vercel.** The engineer has no credentials for either. The scripts
are tested against a stand-in for `gcloud` (see "What is and is not proven"), and every flag was
checked against the CLI's own help (Google Cloud SDK 570). If a command is refused, stop and share
the error text. **Never share a password or key.**

## Before you start

| You need                                          | Why                                                         |
| ------------------------------------------------- | ----------------------------------------------------------- |
| Steps 1 to 4 of `staging-setup.md` done           | The database, bucket and registry must exist                |
| A domain you control                              | An address for the admin app, and a wildcard for sites      |
| An account with the email provider (Resend)       | A verified sending domain and an API key                    |
| The Cloud SQL `postgres` password you set earlier | Asked for once, typed hidden                                |
| Git Bash, WSL, macOS or Linux                     | The scripts are bash; they also need `openssl` and `gcloud` |

Decide three values now. None is a secret:

| Value          | Example                                | Meaning                                |
| -------------- | -------------------------------------- | -------------------------------------- |
| `ADMIN_ORIGIN` | `https://admin.example.com`            | The admin app's address                |
| `SITE_DOMAIN`  | `events.example.com`                   | Sites live at `{handle}.<this domain>` |
| `EMAIL_FROM`   | `EventHub <no-reply@mail.example.com>` | A sender on your verified email domain |

## 1. Secrets and permissions

```bash
scripts/staging/01-secrets.sh
```

- It asks for the `postgres` password and the email API key. Typing is hidden.
- Everything else (three database passwords, the sign-in encryption key, the email link key, the
  visitor address key) is generated and stored in Secret Manager. Nothing is printed.
- It creates three service accounts. Each may read only its own secrets.
- Safe to run again: existing secrets are kept.

## 2. Images

From a clean checkout of the commit to deploy:

```bash
scripts/staging/02-images.sh
```

Cloud Build builds the four images and pushes them to Artifact Registry, tagged with the commit.
About 10 minutes.

## 3. Database roles and migrations

```bash
scripts/staging/03-database.sh
```

Two Cloud Run jobs: the first creates the three roles, the second applies the 37 migrations.
Expect the second to end with `migrations: applied [...]`. This is verification step 1: a
permission error here is the first thing to report.

## 4. API and worker

```bash
ADMIN_ORIGIN=https://admin.example.com SITE_DOMAIN=events.example.com EMAIL_FROM='EventHub <no-reply@mail.example.com>' scripts/staging/04-services.sh
```

Use your own three values. The last line printed is the API's address, for example
`https://eventhub-api-….a.run.app`. It is not a secret. Open `<that address>/health/ready` in a
browser: expect `200`.

## 5. Vercel

These are dashboard steps, written from Vercel's general model and **not yet tried on this
repository**. Create two projects from the same GitHub repository.

| Setting          | Project `eventhub-admin`   | Project `eventhub-site`                                                 |
| ---------------- | -------------------------- | ----------------------------------------------------------------------- |
| Root Directory   | `apps/admin`               | `apps/site`                                                             |
| Framework        | Next.js                    | Next.js                                                                 |
| Node.js version  | 22.x                       | 22.x                                                                    |
| Functions region | Singapore (`sin1`)         | Singapore (`sin1`)                                                      |
| Domain           | The host in `ADMIN_ORIGIN` | `*.<SITE_DOMAIN>` (a wildcard needs the domain's nameservers at Vercel) |

Environment variables, for the Production environment:

| Project | Name                        | Value                                 | Sensitive |
| ------- | --------------------------- | ------------------------------------- | --------- |
| admin   | `ADMIN_API_URL`             | The API's address from step 4         | no        |
| admin   | `ADMIN_ORIGIN`              | Your `ADMIN_ORIGIN`                   | no        |
| admin   | `ADMIN_TRUSTED_PROXY_HOPS`  | `1` (to confirm, verification step 7) | no        |
| admin   | `ADMIN_PUBLIC_SITE_URL`     | `https://{handle}.<SITE_DOMAIN>`      | no        |
| admin   | `ADMIN_VISITOR_ADDRESS_KEY` | The visitor address key (below)       | **yes**   |
| site    | `SITE_API_URL`              | The API's address from step 4         | no        |
| site    | `SITE_DOMAIN`               | Your `SITE_DOMAIN`                    | no        |
| site    | `SITE_TRUSTED_PROXY_HOPS`   | `1` (to confirm, verification step 7) | no        |
| site    | `SITE_VISITOR_ADDRESS_KEY`  | The visitor address key (below)       | **yes**   |

The visitor address key (ADR-0058) must be the same in Secret Manager and both Vercel projects.
Copy it to your clipboard without showing it, then paste it into Vercel and mark it Sensitive.

macOS:

```bash
gcloud secrets versions access latest --secret=visitor-address-key --project event-hub-2b58e | pbcopy
```

Windows (Git Bash):

```bash
gcloud secrets versions access latest --secret=visitor-address-key --project event-hub-2b58e | clip
```

Redeploy both projects after setting the variables.

## 6. Then

Tell the engineer that steps 1 to 5 are done, with the two public addresses (not secrets). The
checks in `hybrid-platform-verification.md` follow.

## Running a step again

| Change                              | Run                                                  |
| ----------------------------------- | ---------------------------------------------------- |
| New code                            | Steps 2, 3 and 4, in that order                      |
| A new email API key                 | Add a version to `resend-api-key`, then step 4       |
| A different admin address or domain | Step 4 with the new values, then the Vercel settings |

## What is and is not proven

**Proven** (`packages/config/src/staging-deploy.test.ts`, with `gcloud` replaced by a stand-in
that records every call):

- no secret value appears on a command line or in the scripts' output;
- the three database URLs are the accepted socket form (ADR-0057), each with its own password;
- a typed password with special characters reaches the database URL intact;
- running step 1 again changes no secret;
- the settings given to the API, the worker and the migration job are accepted by each one's own
  configuration loader in staging mode;
- each service account may read exactly the secrets its service is given, and no more;
- the roles job runs before the migrations job;
- step 4 refuses a non-https admin address, and refuses to run without the email key.

**Not proven**, because it needs the real platforms:

- that Google accepts each command with these exact values (flags exist; behaviour is untested);
- Cloud Build's permissions on a new project, and its support for the Dockerfile's build features;
- the storage role name `roles/storage.objectUser`;
- Cloud Run worker pools for the worker;
- the Vercel settings above, including the proxy hop count.

Each of these fails loudly at the step concerned, not silently later.
