import { processOnce, withTransaction, type Pool } from '@eventhub/db';
import type { DomainEvent, EventPublisher } from '@eventhub/kernel';
import type { EventConsumer } from './consumers/consumer.ts';

/**
 * PostgreSQL outbox broker (ADR-0009): the durable queue is the `outbox_event` table; this
 * publisher delivers each claimed event to the worker's in-process consumers. A failing consumer
 * rejects `publish`, so the relay retries with backoff (or dead-letters a permanent failure);
 * consumers that already succeeded are skipped on retry by the `processed_event` ledger.
 */
export class OutboxDispatchPublisher implements EventPublisher {
  readonly name = 'postgres_outbox';
  readonly #pool: Pool;
  readonly #consumers: readonly EventConsumer[];

  constructor(pool: Pool, consumers: readonly EventConsumer[]) {
    this.#pool = pool;
    this.#consumers = consumers;
  }

  async publish(event: DomainEvent): Promise<void> {
    for (const consumer of this.#consumers) {
      if (!consumer.eventTypes.includes(event.eventType)) continue;
      await withTransaction(this.#pool, {}, (client) =>
        processOnce(client, consumer.name, event.eventId, () => consumer.handle(event, client)),
      );
    }
  }
}
