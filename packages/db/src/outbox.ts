import type { DomainEvent } from '@eventhub/kernel';
import type { PoolClient, Queryable } from './pool.ts';

/** Writes a domain event to the outbox inside the caller's (business) transaction. */
export async function enqueueEvent(client: Queryable, event: DomainEvent): Promise<void> {
  await client.query(
    `INSERT INTO eventhub.outbox_event
       (id, organization_id, event_type, schema_version, aggregate_type, aggregate_id,
        actor_type, actor_id, correlation_id, causation_id, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      event.eventId,
      event.organizationId,
      event.eventType,
      event.schemaVersion,
      event.aggregateType,
      event.aggregateId,
      event.actor.type,
      event.actor.id,
      event.correlationId,
      event.causationId,
      JSON.stringify(event.payload),
      event.occurredAt,
    ],
  );
}

interface OutboxRow {
  id: string;
  organization_id: string | null;
  event_type: string;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  actor_type: DomainEvent['actor']['type'];
  actor_id: string | null;
  correlation_id: string;
  causation_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
}

export interface ClaimedEvent {
  event: DomainEvent;
  attempts: number;
}

/**
 * Claims due events with row locks (SKIP LOCKED) so multiple relays can run concurrently
 * without double-claiming. Must run inside a transaction held until results are recorded.
 */
export async function claimDueEvents(client: PoolClient, limit: number): Promise<ClaimedEvent[]> {
  const { rows } = await client.query<OutboxRow>(
    `SELECT id, organization_id, event_type, schema_version, aggregate_type, aggregate_id,
            actor_type, actor_id, correlation_id, causation_id, payload, occurred_at, attempts
       FROM eventhub.outbox_event
      WHERE status = 'pending' AND available_at <= now()
      ORDER BY available_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows.map((r) => ({
    attempts: r.attempts,
    event: {
      eventId: r.id,
      eventType: r.event_type,
      schemaVersion: r.schema_version,
      occurredAt: r.occurred_at,
      actor: { type: r.actor_type, id: r.actor_id },
      organizationId: r.organization_id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      correlationId: r.correlation_id,
      causationId: r.causation_id,
      payload: r.payload,
    },
  }));
}

export async function markPublished(client: Queryable, eventId: string): Promise<void> {
  await client.query(
    `UPDATE eventhub.outbox_event
        SET status = 'published', published_at = now(), attempts = attempts + 1, last_error = NULL
      WHERE id = $1`,
    [eventId],
  );
}

/** Exponential backoff with full jitter, capped at 15 minutes. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const cap = 15 * 60_000;
  const base = Math.min(cap, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * base);
}

/**
 * Records a failed delivery. After `maxAttempts` the event is dead-lettered (status `dead`) for
 * alerting and operator replay. `errorSummary` must be a short, non-sensitive description.
 */
export async function markFailed(
  client: Queryable,
  eventId: string,
  attemptsSoFar: number,
  maxAttempts: number,
  errorSummary: string,
): Promise<'retry' | 'dead'> {
  const attempts = attemptsSoFar + 1;
  const outcome = attempts >= maxAttempts ? 'dead' : 'retry';
  await client.query(
    `UPDATE eventhub.outbox_event
        SET attempts = $2,
            status = $3,
            available_at = now() + ($4::double precision * interval '1 millisecond'),
            last_error = left($5, 500)
      WHERE id = $1`,
    [
      eventId,
      attempts,
      outcome === 'dead' ? 'dead' : 'pending',
      retryDelayMs(attempts),
      errorSummary,
    ],
  );
  return outcome;
}

/**
 * Consumer-side idempotency: runs `fn` only the first time `consumer` sees `eventId`. Must be
 * called inside a transaction so the ledger row and the side effect commit together.
 */
export async function processOnce(
  client: Queryable,
  consumer: string,
  eventId: string,
  fn: () => Promise<void>,
): Promise<'processed' | 'duplicate'> {
  const { rowCount } = await client.query(
    `INSERT INTO eventhub.processed_event (consumer, event_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [consumer, eventId],
  );
  if (rowCount === 0) return 'duplicate';
  await fn();
  return 'processed';
}

/**
 * Dead-letters an event immediately (permanent failure, e.g. a provider rejecting the sender
 * domain). Retrying such failures only delays the alert.
 */
export async function markDead(
  client: Queryable,
  eventId: string,
  attemptsSoFar: number,
  errorSummary: string,
): Promise<void> {
  await client.query(
    `UPDATE eventhub.outbox_event
        SET attempts = $2, status = 'dead', last_error = left($3, 500)
      WHERE id = $1`,
    [eventId, attemptsSoFar + 1, errorSummary],
  );
}

export interface OutboxHealth {
  pending: number;
  /** Seconds since the oldest due pending event became available (0 when none are due). */
  oldestDueAgeSeconds: number;
  dead: number;
}

/** Cheap health snapshot for lag and dead-letter alerting (uses the partial pending index). */
export async function outboxHealth(client: Queryable): Promise<OutboxHealth> {
  const { rows } = await client.query<{ pending: string; oldest: string | null; dead: string }>(
    `SELECT (SELECT count(*) FROM eventhub.outbox_event WHERE status = 'pending')::text AS pending,
            (SELECT extract(epoch FROM now() - min(available_at))::text
               FROM eventhub.outbox_event WHERE status = 'pending' AND available_at <= now()) AS oldest,
            (SELECT count(*) FROM eventhub.outbox_event WHERE status = 'dead')::text AS dead`,
  );
  const r = rows[0]!;
  return {
    pending: Number(r.pending),
    oldestDueAgeSeconds: r.oldest === null ? 0 : Math.max(0, Math.floor(Number(r.oldest))),
    dead: Number(r.dead),
  };
}

/**
 * Operator replay (runbook: docs/operations/outbox-runbook.md). Returns dead-lettered events to
 * the queue with a fresh attempt budget. Consumers that already succeeded for an event are
 * skipped by the `processed_event` ledger, so only the failed work re-runs.
 * `eventIds = null` replays every dead event.
 */
export async function replayDeadEvents(
  client: Queryable,
  eventIds: string[] | null,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE eventhub.outbox_event
        SET status = 'pending', attempts = 0, available_at = now(), last_error = NULL
      WHERE status = 'dead' AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
      RETURNING id`,
    [eventIds],
  );
  return rows.map((r) => r.id);
}
