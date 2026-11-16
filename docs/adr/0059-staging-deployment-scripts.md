# ADR-0059: Staging deployment by script

- Status: accepted
- Date: 2026-11-16
- Builds on: ADR-0053 (container images), ADR-0056 (Vercel and Google Cloud), ADR-0057 (Cloud SQL
  socket), ADR-0058 (signed visitor addresses)

## Context

The product owner deploys staging by hand, because the engineer has no credentials for the Google
project or the Vercel team. A page of commands to copy has two risks: a secret pasted into a
command line or a chat, and a setting that the services then refuse at start-up.

## Decision

The Google Cloud steps are four bash scripts in `scripts/staging`, run in order. A guide
(`docs/operations/staging-deploy.md`) covers them and the Vercel dashboard steps.

| Script           | Does                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| `01-secrets.sh`  | Service accounts, secrets, and who may read which                     |
| `02-images.sh`   | Builds the four images with Cloud Build (`cloudbuild.yaml`)           |
| `03-database.sh` | Roles and migrations, as Cloud Run jobs                               |
| `04-services.sh` | The API as a Cloud Run service, the worker as a Cloud Run worker pool |

Rules the scripts keep:

- **Secrets never touch a command line, a file or the screen.** Values are generated or read
  hidden, and written only to `gcloud`'s standard input.
- **Database passwords are generated, not chosen.** One per role. The same stored value feeds the
  roles job and the service's connection URL, so they cannot drift apart.
- **One service account per service.** `api`, `worker` and `jobs`. Each may read only the secrets
  it is given; only `jobs` holds the admin and migrator credentials.
- **Every step can be run again.** Existing secrets are kept; roles are updated in place; applied
  migrations are skipped.
- **Images are tagged by commit**, and the same tag is deployed.

### The worker

The worker serves no HTTP, so it is a Cloud Run **worker pool** with one instance, not a service.
A service would need a port to listen on and would be scaled to zero between requests, which stops
the outbox.

## How it is tested

A unit test runs the scripts with `gcloud` replaced by a stand-in that records every call and
keeps secrets in a directory. It then feeds the recorded settings to the real configuration
loaders. The guide lists exactly what this proves and what it cannot. Mutation checks: 21 changes
to the scripts (printing a password, passing one as a flag, a wrong host, a missing or extra
permission, the jobs out of order, a wrong environment), all caught.

## Not decided here

- **Production.** These scripts are for staging. Production needs its own review: instance size,
  backups, a deployment gate, and who may run it.
- **Deployment from CI.** It needs a credential for the Google project in GitHub (workload
  identity). Worth doing once staging is verified.
- **Rotation of the database passwords.** Delete the stored password and run steps 1, 3 and 4.
  Not yet rehearsed.

## Alternatives

- **Terraform or similar.** The right tool once there are two environments. For one staging
  environment set up once, it adds a state store and a tool to install before anything runs.
- **A page of commands to copy.** No way to test it, and secrets end up in shell history.
