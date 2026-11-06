import { processOnce, withTransaction, type Pool } from '@eventhub/db';
import type { DomainEvent, EventPublisher } from '@eventhub/kernel';
import type { EventConsumer } from './consumers/consumer.ts';

/**
 * Local/CI broker stand-in: delivers each event straight to this process's consumers. A failing
 * consumer rejects `publish`, so the relay retries with backoff; consumers that already
 * succeeded are skipped on retry by the dedupe ledger. Refused by config in staging/production.
 */
export class LocalDispatchPublisher implements EventPublisher {
  readonly name = 'local_dispatch';
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
