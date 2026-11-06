import type { PoolClient } from '@eventhub/db';
import type { DomainEvent } from '@eventhub/kernel';

/**
 * An outbox event consumer. `handle` runs inside a transaction that also records the event in
 * the `processed_event` ledger, so each consumer applies each event at most once. Consumers
 * acting on tenant data must revalidate aggregate ownership before acting.
 */
export interface EventConsumer {
  /** Ledger key; must stay stable once deployed. */
  readonly name: string;
  readonly eventTypes: readonly string[];
  handle(event: DomainEvent, client: PoolClient): Promise<void>;
}
