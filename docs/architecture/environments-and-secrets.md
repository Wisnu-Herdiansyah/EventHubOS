# Environment configuration contract and secret management

## Environments

`EVENTHUB_ENV` ∈ `local | ci | staging | production` (validated at startup).

| Rule                                   | local     | ci                          | staging      | production   |
| -------------------------------------- | --------- | --------------------------- | ------------ | ------------ |
| Data                                   | synthetic | synthetic, per-run database | synthetic    | customer     |
| DB TLS (`sslmode=require` or stricter) | optional  | optional                    | **required** | **required** |
| `EVENT_PUBLISHER=in_memory`            | allowed   | allowed                     | **refused**  | **refused**  |
| Response contract validation           | on        | on                          | on           | off          |

## Variables

| Variable                                                         | Process                    | Secret?       | Notes                                                 |
| ---------------------------------------------------------------- | -------------------------- | ------------- | ----------------------------------------------------- |
| `EVENTHUB_ENV`                                                   | all                        | no            |                                                       |
| `LOG_LEVEL`                                                      | all                        | no            | default `info`                                        |
| `HTTP_HOST`, `HTTP_PORT`, `TRUST_PROXY`, `RATE_LIMIT_PER_MINUTE` | api                        | no            | `TRUST_PROXY=true` only behind a trusted edge         |
| `DATABASE_APP_URL`                                               | api                        | **yes**       | `eventhub_app` role                                   |
| `DATABASE_WORKER_URL`                                            | worker                     | **yes**       | `eventhub_worker` role                                |
| `DATABASE_MIGRATOR_URL`                                          | migration job              | **yes**       | `eventhub_migrator`; never given to runtime workloads |
| `EVENT_PUBLISHER`, `OUTBOX_*`                                    | worker                     | no            |                                                       |
| `DATABASE_ADMIN_URL`, `EVENTHUB_{MIGRATOR,APP,WORKER}_PASSWORD`  | bootstrap (operator, once) | **yes**       |                                                       |
| `TEST_DATABASE_ADMIN_URL`                                        | integration tests          | local/CI only | disposable instance                                   |

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
