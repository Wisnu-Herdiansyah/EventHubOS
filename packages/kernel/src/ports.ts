import type { DomainEvent } from './domain-event.ts';

/**
 * Provider ports. Domain code depends only on these interfaces; concrete providers live in
 * adapter modules selected by configuration and are verified with shared contract tests
 * (see `@eventhub/kernel/testing`).
 */

/** Durable message broker used by the outbox relay. Must be at-least-once. */
export interface EventPublisher {
  readonly name: string;
  publish(event: DomainEvent): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** In-memory publisher: a local/test fake only. Refused by config in staging/production. */
export class InMemoryEventPublisher implements EventPublisher {
  readonly name = 'in_memory';
  readonly published: DomainEvent[] = [];
  #failNext = 0;

  /** Test hook: make the next `count` publishes reject (simulates broker outage). */
  failNext(count: number): void {
    this.#failNext = count;
  }

  publish(event: DomainEvent): Promise<void> {
    if (this.#failNext > 0) {
      this.#failNext -= 1;
      return Promise.reject(new Error('in-memory publisher: simulated outage'));
    }
    this.published.push(structuredClone(event));
    return Promise.resolve();
  }
}
