# Runbook: outbox delivery (PostgreSQL broker)

Applies to the worker (`apps/worker`) with `EVENT_PUBLISHER=postgres_outbox` (ADR-0009).

## Signals

The worker logs an `outbox health` record every `OUTBOX_HEALTH_INTERVAL_MS`:

| Field                 | Meaning                                                                                |
| --------------------- | -------------------------------------------------------------------------------------- |
| `pending`             | Events waiting for delivery, including those in backoff                                |
| `oldestDueAgeSeconds` | How long the oldest _due_ event has waited. Rising means delivery is stuck or too slow |
| `dead`                | Dead-lettered events. **Any value above 0 needs a human**                              |

| Alert        | Condition                                                                          | Severity                                                  |
| ------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Dead letters | `outbox health` at level `error` (`dead > 0`)                                      | Page in business hours; immediately if verification email |
| Delivery lag | `outbox health` at level `warn` (`oldestDueAgeSeconds >= OUTBOX_LAG_WARN_SECONDS`) | Page if sustained 15 min                                  |
| Worker down  | No `outbox health` record for 3 × interval                                         | Page                                                      |

Per-event failures are logged as `outbox publish failed; will retry` (warn) or
`outbox event dead-lettered` (error, `permanent: true` when no retry could help). Each carries
`eventId`, `eventType`, `attempts`, and a redacted `error` summary (provider code and HTTP status
only).

## Inspect

Read-only, as the worker role:

```sql
SELECT id, event_type, attempts, last_error, occurred_at
  FROM eventhub.outbox_event
 WHERE status = 'dead'
 ORDER BY occurred_at;
```

## Common causes

| `last_error` contains                                  | Cause                                                            | Fix                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `invalid_from_address`, `validation_error` (permanent) | `EMAIL_FROM` domain not verified in Resend, or bad sender format | Verify the domain in Resend or correct `EMAIL_FROM`, then replay                                                       |
| `invalid_api_key`, `http_401`, `http_403`              | Resend key revoked or wrong                                      | Rotate `RESEND_API_KEY` in the secret manager, restart the worker, replay                                              |
| `rate_limit_exceeded`, `daily_quota_exceeded`          | Provider limits                                                  | Raise the plan or wait for the quota to reset. These retry automatically and only dead-letter after the attempt budget |
| `timeout`, `network_error`                             | Provider or egress outage                                        | Check the Resend status page and egress to `api.resend.com`. These retry automatically                                 |

## Replay

After fixing the cause, return dead events to the queue (fresh attempt budget). Consumers that
already succeeded for an event are skipped automatically.

```bash
DATABASE_WORKER_URL=... pnpm outbox:replay --event <event-uuid>
```

```bash
DATABASE_WORKER_URL=... pnpm outbox:replay --all-dead --confirm
```

The command prints the replayed IDs and skips any ID that is not dead-lettered. Record what you
replayed and why in the incident ticket. Replay is not yet written to `audit_event` (ADR-0009).

## Scaling

Delivery is sequential per replica, with one short transaction per event. To raise throughput,
run more worker replicas: `SKIP LOCKED` keeps them from colliding. Keep each replica's pool size
at 4 or more (relay plus consumer transactions).
