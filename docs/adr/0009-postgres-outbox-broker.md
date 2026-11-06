# ADR-0009: PostgreSQL outbox as the broker for the first release

- Status: accepted
- Date: 2026-11-06
- Closes: open decision D5 for the first release (revisit triggers below)

## Context

Domain events are already written to `eventhub.outbox_event` in the same transaction as the
business change (ADR-0004). The worker needed a remote-capable `EventPublisher` before it could
run in staging/production. The product owner approved using the database itself as the broker
for the first release, rather than adding a separate queue service.

## Decision

**Broker.** `EVENT_PUBLISHER=postgres_outbox`. The outbox table is the durable queue. The worker
relays due rows and delivers each one to its in-process consumers
(`OutboxDispatchPublisher`). No extra infrastructure, no dual-write, and the same backups and
point-in-time recovery as the business data.

**Delivery semantics.** At-least-once. Consumers dedupe per event via `processed_event`
(`processOnce`), so a re-delivery never repeats completed work, and a retry re-runs only the
consumers that failed.

**One short transaction per event.** The relay claims one row with `FOR UPDATE SKIP LOCKED`,
delivers it, records the outcome, and commits, up to `OUTBOX_BATCH_SIZE` events per pass.
Locks and a connection are held for a single delivery (bounded by adapter timeouts, for example
10 s for email), never for a batch, so several worker replicas interleave safely. An integration
test reproduces a slow delivery and was mutation-checked against the previous whole-batch design.

**Failure handling.**

- Transient failures retry with capped exponential backoff and full jitter (≤ 15 min),
  dead-lettering after `OUTBOX_MAX_ATTEMPTS` (default 12).
- Permanent failures (any error with `retryable === false`, e.g. Resend `invalid_from_address`
  or `validation_error`) are dead-lettered **immediately**, so the alert fires at once instead of
  after hours of retries.
- `pnpm outbox:replay` returns dead events to the queue after the cause is fixed
  (runbook: `docs/operations/outbox-runbook.md`). It runs as the least-privilege worker role.

**Observability.** Every `OUTBOX_HEALTH_INTERVAL_MS` (default 60 s) the worker logs
`outbox health` with `pending`, `oldestDueAgeSeconds` and `dead`, at level `error` when anything
is dead-lettered and `warn` when lag exceeds `OUTBOX_LAG_WARN_SECONDS` (default 300 s). Alert
rules attach to these records until the observability stack is chosen.

## Consequences

- The worker can now start in staging/production. The remaining prerequisites are environment
  provisioning (cloud decision D1), secrets, and the Resend domain (ADR-0008).
- Throughput is bounded by sequential delivery per replica; scale out by running more worker
  replicas (safe by design).
- Published rows are not yet deleted. A retention job needs the retention policy (D9). Delivery
  performance is unaffected because claims use the partial index on pending rows.
- Operator replay is logged to the console but not written to `audit_event` (the worker role
  cannot write tenant audit rows). A platform-admin audit path is a Phase 5 item.
- **Revisit triggers.** Move to a dedicated broker when any of these hold: several independent
  consumer groups or services need the same events (fan-out); sustained throughput where outbox
  polling measurably loads the primary database; consumers that must scale independently of the
  worker; or cross-region delivery. The `EventPublisher` port keeps that a configuration-level
  change.
