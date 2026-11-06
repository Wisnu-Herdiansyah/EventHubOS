import {
  claimDueEvents,
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
 * One relay pass: claim due outbox rows (SKIP LOCKED), publish each through the configured
 * broker adapter, and record the outcome in the same transaction. Delivery is at-least-once:
 * a crash after publish but before commit re-delivers, so consumers dedupe on event ID.
 */
export async function relayOnce(
  pool: Pool,
  publisher: EventPublisher,
  options: RelayOptions,
  logger?: RelayLogger,
): Promise<RelayStats> {
  return withTransaction(pool, {}, async (client) => {
    const stats: RelayStats = { published: 0, retried: 0, deadLettered: 0 };
    for (const { event, attempts } of await claimDueEvents(client, options.batchSize)) {
      try {
        await publisher.publish(event);
        await markPublished(client, event.eventId);
        stats.published += 1;
      } catch (error) {
        // Only the error class/message is stored; never payloads or credentials.
        const summary =
          error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
        const outcome = await markFailed(
          client,
          event.eventId,
          attempts,
          options.maxAttempts,
          summary,
        );
        const context = {
          eventId: event.eventId,
          eventType: event.eventType,
          attempts: attempts + 1,
          adapter: publisher.name,
        };
        if (outcome === 'dead') {
          stats.deadLettered += 1;
          logger?.error(context, 'outbox event dead-lettered');
        } else {
          stats.retried += 1;
          logger?.warn(context, 'outbox publish failed; will retry');
        }
      }
    }
    return stats;
  });
}
