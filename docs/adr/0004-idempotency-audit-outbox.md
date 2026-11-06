# ADR-0004: Idempotency keys, append-only audit, and transactional outbox

- Status: accepted
- Date: 2026-11-06

## Context

Architecture §6 and roadmap rule 5 require idempotent commands, auditable state changes, and
background side effects driven only through an outbox.

## Decision

- **Idempotency:** every mutating route is declared `idempotent: true` and _requires_ an
  `Idempotency-Key` header (8–255 chars `[A-Za-z0-9_.:-]`). The key is claimed in the _same_
  transaction as the business change, scoped to (actor, operation + validated params). Outcomes:
  first request executes; a concurrent duplicate blocks and then replays the committed response
  (`Idempotent-Replayed: true`); a different payload under the same key gets `422`; a failed
  command rolls back and releases the key. Keys expire after 24 hours.
- **Audit:** `audit_event` is append-only for every role (triggers reject UPDATE/DELETE/TRUNCATE,
  even for the owner). Metadata must not contain PII or secrets. No FK to `organization` so
  evidence can outlive tenant purge per retention policy.
- **Outbox:** domain events (`event_id`, `event_type`, `schema_version`, `occurred_at`, actor,
  `organization_id`, aggregate, correlation/causation IDs) are written in the business
  transaction. The relay claims rows with `FOR UPDATE SKIP LOCKED`, publishes through the
  `EventPublisher` port, retries with capped exponential backoff + jitter, and dead-letters after
  `OUTBOX_MAX_ATTEMPTS`. Delivery is at-least-once; consumers use `processOnce()` (ledger table
  `processed_event`) to dedupe on `event_id`.

## Consequences

- No durable broker exists yet: only the in-memory adapter, refused by config in
  staging/production. The broker selection is an open decision.
- An outbox cleanup/retention job and a dead-letter replay tool are required before GA.
