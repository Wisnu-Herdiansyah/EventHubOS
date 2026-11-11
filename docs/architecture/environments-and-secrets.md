# Environment configuration contract and secret management

## Environments

`EVENTHUB_ENV` ∈ `local | ci | staging | production` (validated at startup).

| Rule                                                            | local     | ci                          | staging             | production          |
| --------------------------------------------------------------- | --------- | --------------------------- | ------------------- | ------------------- |
| Data                                                            | synthetic | synthetic, per-run database | synthetic           | customer            |
| DB TLS (`sslmode=require` or stricter)                          | optional  | optional                    | **required**        | **required**        |
| Local email adapters (`EMAIL_SENDER=in_memory` or `local_file`) | allowed   | allowed                     | **refused**         | **refused**         |
| `EMAIL_SENDER=resend`                                           | allowed   | allowed (live tests opt-in) | allowed, HTTPS only | allowed, HTTPS only |
| Response contract validation                                    | on        | on                          | on                  | off                 |

## Variables

| Variable                                                         | Process                    | Secret?       | Notes                                                                                                                                                          |
| ---------------------------------------------------------------- | -------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVENTHUB_ENV`                                                   | all                        | no            |                                                                                                                                                                |
| `LOG_LEVEL`                                                      | all                        | no            | default `info`                                                                                                                                                 |
| `HTTP_HOST`, `HTTP_PORT`, `TRUST_PROXY`, `RATE_LIMIT_PER_MINUTE` | api                        | no            | `TRUST_PROXY`: `false` or a list of IPs/CIDRs (`true` refused remotely)                                                                                        |
| `SESSION_TTL_HOURS`, `LOGIN_MAX_FAILURES`, `LOGIN_LOCK_SECONDS`  | api                        | no            | defaults 12 h / 5 / 900 s                                                                                                                                      |
| `SESSION_IDLE_MINUTES`                                           | api                        | no            | idle timeout (ADR-0018); default 60, range 15–1440                                                                                                             |
| `INVITATION_TTL_HOURS`                                           | api                        | no            | default 168 h (7 days)                                                                                                                                         |
| `DATABASE_APP_URL`                                               | api                        | **yes**       | `eventhub_app` role                                                                                                                                            |
| `DATABASE_WORKER_URL`                                            | worker                     | **yes**       | `eventhub_worker` role                                                                                                                                         |
| `DATABASE_MIGRATOR_URL`                                          | migration job              | **yes**       | `eventhub_migrator`; never given to runtime workloads                                                                                                          |
| `EVENT_PUBLISHER`, `OUTBOX_*`                                    | worker                     | no            | `postgres_outbox` (ADR-0009); health interval 60 s, lag warning 300 s                                                                                          |
| `EMAIL_SENDER`, `EMAIL_LOCAL_DIR`                                | worker                     | no            | `resend` (remote) or `in_memory` / `local_file` (local only)                                                                                                   |
| `RESEND_API_KEY`                                                 | worker                     | **yes**       | required when `EMAIL_SENDER=resend`                                                                                                                            |
| `EMAIL_FROM`                                                     | worker                     | no            | sender on a domain verified in Resend                                                                                                                          |
| `RESEND_BASE_URL`, `RESEND_TIMEOUT_MS`                           | worker                     | no            | defaults `https://api.resend.com`, 10 s                                                                                                                        |
| `EMAIL_TOKEN_SECRET`                                             | worker                     | **yes**       | ≥ 32 chars; derives verification tokens (ADR-0008)                                                                                                             |
| `MFA_ENCRYPTION_KEY`                                             | api                        | **yes**       | 32 bytes, base64; seals authenticator secrets (ADR-0022). Required in staging/production; changing it disables existing enrolments                             |
| `PASSKEY_ORIGIN`                                                 | api                        | no            | admin app origin; passkeys are bound to its host (ADR-0033). https outside local/ci; unset keeps passkeys off. Changing the host invalidates existing passkeys |
| `APP_BASE_URL`, `EMAIL_VERIFICATION_TTL_HOURS`                   | worker                     | no            | base for verification links; default 24 h                                                                                                                      |
| `PASSWORD_RESET_TTL_MINUTES`                                     | worker                     | no            | reset link lifetime (ADR-0015); default 60 min                                                                                                                 |
| `ADMIN_API_URL`                                                  | admin                      | no            | API base URL, server-side only                                                                                                                                 |
| `ADMIN_ORIGIN`                                                   | admin                      | no            | public https origin; enables `upgrade-insecure-requests`                                                                                                       |
| `ADMIN_TRUSTED_PROXY_HOPS`                                       | admin                      | no            | proxies in front of the admin app (ADR-0014); set ≥ 1 when deployed                                                                                            |
| `ADMIN_DESIGN_GALLERY`                                           | admin                      | no            | `1` serves the /design-system gallery; default on in dev only (ADR-0019)                                                                                       |
| `ADMIN_PUBLIC_SITE_URL`                                          | admin                      | no            | public site address template, e.g. `https://{handle}.eventhub.example` (ADR-0021)                                                                              |
| `SITE_API_URL`                                                   | site                       | yes           | core API base URL, server-side only (ADR-0021)                                                                                                                 |
| `SITE_DOMAIN`                                                    | site                       | yes           | platform domain whose subdomains are organization handles, e.g. `eventhub.example`                                                                             |
| `SITE_HTTPS`                                                     | site                       | no            | `1` (default) when served over HTTPS; `0` for local HTTP                                                                                                       |
| `SITE_TRUSTED_PROXY_HOPS`                                        | site                       | no            | proxies in front of the site; their X-Forwarded-For gives visitor IPs for rate limits (ADR-0023)                                                               |
| `PUBLIC_SITE_URL`                                                | worker                     | no            | public site template, e.g. `https://{handle}.eventhub.example`, for registration cancel links; HTTPS outside local/ci (ADR-0023)                               |
| `DATABASE_ADMIN_URL`, `EVENTHUB_{MIGRATOR,APP,WORKER}_PASSWORD`  | bootstrap (operator, once) | **yes**       |                                                                                                                                                                |
| `TEST_DATABASE_ADMIN_URL`                                        | integration tests          | local/CI only | disposable instance                                                                                                                                            |

## Secret handling rules

1. Secrets are injected at runtime from the platform's managed secret store (provider: D1),
   scoped per environment and per workload. Each workload receives only its own role's URL.
2. No secrets in the repository, fixtures, images, client bundles, or logs. `.env*` files are
   git-ignored except `.env.example`, which contains placeholders only.
3. Config errors name keys, never values (`ConfigError`), because URLs embed passwords.
4. Integration tests generate random role passwords per run; CI's database is an ephemeral
   service container.
5. Gitleaks scans full history in CI. Locally: `git ls-files -z | grep -zv pnpm-lock.yaml | xargs -0 detect-secrets scan`
   (lockfile integrity hashes are excluded as known false positives).
6. Rotation: role passwords rotate by re-running `pnpm db:bootstrap` with new values, then
   rolling the workloads.
