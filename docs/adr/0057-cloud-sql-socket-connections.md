# ADR-0057: Database connections through the Cloud SQL socket

- Status: accepted
- Date: 2026-11-13
- Closes: ADR-0056 open point 1 (TLS to Cloud SQL)
- Builds on: ADR-0053 (container images), ADR-0056 (API and worker on Cloud Run)

## Context

In staging and production, EventHub refuses to start unless every database URL demands
verified TLS (`sslmode=require` or stricter). The rule exists so that credentials and tenant data
never cross a network in the clear.

Cloud Run reaches Cloud SQL differently. For an attached instance, Cloud Run mounts a Unix socket
in the container at `/cloudsql/<project>:<region>:<instance>`. Google's Cloud SQL proxy sits
behind that socket. It encrypts the connection to the database with mutual TLS, and it checks that
the service's own identity may connect. The application opens no network connection to the
database at all, so there is no `sslmode` to set: asking for TLS on the socket would make the
driver attempt TLS inside it, and the connection would fail.

## Decision

A database URL is acceptable in staging and production when it is one of:

1. **Verified TLS to a network address**, as before: `sslmode=require`, `verify-ca` or
   `verify-full`.
2. **The Cloud SQL socket, in exactly this form:**

   ```
   postgres://<role>:<password>@localhost/<database>?host=/cloudsql/<project>:<region>:<instance>
   ```

Everything else is refused, with an error that names the setting and never the URL.

### Why "exactly this form"

The check (`databaseTransport` in `packages/config`) judges a URL the way the driver reads it:

- **The driver uses a `host` parameter instead of the URL's own host,** for any host. So the
  parameter decides, not the host in the URL.
- **Several spellings reach a socket:** the `host` parameter, a percent-encoded path in the host
  position, and an empty host. Only the first, with `localhost` as the URL host, is accepted.
  Having one spelling keeps the rule easy to review.
- **Refused:**
  - any socket path outside `/cloudsql/`;
  - a malformed instance name, or a trailing path;
  - a socket address that also sets `sslmode`, `ssl` or a port;
  - two `host` parameters.
- **Local and CI are unchanged:** any transport is allowed there, as before.

### How it is tested

- **Unit:** the accepted form, 17 refused variants, all three database roles (API, worker,
  migrator) in staging and production, and that errors never contain the URL.
- **Driver parity** (`packages/db`): each URL is given to the real driver, and the test checks
  that the driver's interpretation matches the configuration's. A change in the driver's URL
  parsing fails this test.
- **End to end, in CI:** the container smoke test mounts a real PostgreSQL socket directory at
  a `/cloudsql/…` path, as Cloud Run does, and with **no network** to the database:
  - the migration job runs through the socket in staging mode;
  - the API image starts in staging mode and reports ready;
  - the same socket mounted at another path is refused before the service starts, without
    printing the URL.

## What this does not prove

The smoke test uses a plain PostgreSQL socket. It proves that EventHub's images work through a
socket at that path, and that the staging rules accept only that. It does not exercise Google's
proxy, its encryption or its identity check: those are Google's, and the verification checklist
confirms them on the real instance (step 2).

## Alternatives

- **Private IP with `sslmode=verify-full` and Cloud SQL's CA file.** It keeps the old rule
  unchanged, but it needs a VPC connection for Cloud Run, private services access, and the
  instance's CA certificate shipped to every service and rotated with it. More to set up and more
  to get wrong.
- **Google's connector library inside the application.** It builds the encrypted connection in
  process. That puts a Google SDK inside the database layer, which is otherwise provider-neutral,
  for the same security the platform's socket already gives.
- **Relaxing the rule to "any Unix socket".** A socket is only as safe as what is behind it. Only
  the Cloud SQL socket has the proxy behind it.

## Follow-up

The driver warns that its next major version will weaken what `sslmode=require` means, to match
libpq. Before upgrading the driver, the TLS rule should demand `verify-full`. Not part of this
change.
