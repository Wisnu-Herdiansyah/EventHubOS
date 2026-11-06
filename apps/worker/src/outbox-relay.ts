import {
  claimDueEvents,
  markDead,
  markFailed,
  markPublished,
  withTransaction,
  type Pool,
} from '@eventhub/db';
import type { EventPublisher } from '@eventhub/kernel';

export interface RelayOptions {
  batchSize: number;
  maxAttempts: number;
}

export interface RelayStats {
  published: number;
  retried: number;
  deadLettered: number;
}

export interface RelayLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * A failure that no retry can fix (e.g. a provider rejecting the sender domain). Any error with
 * `retryable === false` qualifies, so adapters signal this without importing worker code.
 */
export function isPermanentFailure(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === false
  );
}

type Outcome = 'published' | 'retried' | 'dead_lettered' | 'idle';

/**
 * Relays up to `batchSize` due events, each in its own short transaction: claim one row
 * (FOR UPDATE SKIP LOCKED), publish, record the outcome, commit. Locks and the connection are
 * therefore held for one delivery at a time, never for a whole batch, and concurrent relays
 * (several worker replicas) interleave safely. Delivery is at-least-once: a crash after publish
 * but before commit re-delivers, and consumers dedupe on event ID.
 */
export async function relayOnce(
  pool: Pool,
  publisher: EventPublisher,
  options: RelayOptions,
  logger?: RelayLogger,
): Promise<RelayStats> {
  const stats: RelayStats = { published: 0, retried: 0, deadLettered: 0 };
  for (let i = 0; i < options.batchSize; i++) {
    const outcome = await relayNext(pool, publisher, options, logger);
    if (outcome === 'idle') break;
    if (outcome === 'published') stats.published += 1;
    else if (outcome === 'retried') stats.retried += 1;
    else stats.deadLettered += 1;
  }
  return stats;
}

async function relayNext(
  pool: Pool,
  publisher: EventPublisher,
  options: RelayOptions,
  logger?: RelayLogger,
): Promise<Outcome> {
  return withTransaction(pool, {}, async (client) => {
    const [claimed] = await claimDueEvents(client, 1);
    if (!claimed) return 'idle';
    const { event, attempts } = claimed;
    try {
      await publisher.publish(event);
      await markPublished(client, event.eventId);
      return 'published';
    } catch (error) {
      // Only the error class/message is stored; adapters keep secrets and payloads out of it.
      const summary = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
      const context = {
        eventId: event.eventId,
        eventType: event.eventType,
        attempts: attempts + 1,
        adapter: publisher.name,
        error: summary,
      };
      if (isPermanentFailure(error)) {
        await markDead(client, event.eventId, attempts, summary);
        logger?.error({ ...context, permanent: true }, 'outbox event dead-lettered');
        return 'dead_lettered';
      }
      const outcome = await markFailed(
        client,
        event.eventId,
        attempts,
        options.maxAttempts,
        summary,
      );
      if (outcome === 'dead') {
        logger?.error(context, 'outbox event dead-lettered');
        return 'dead_lettered';
      }
      logger?.warn(context, 'outbox publish failed; will retry');
      return 'retried';
    }
  });
}
