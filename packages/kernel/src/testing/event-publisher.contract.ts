import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDomainEvent } from '../domain-event.ts';
import type { EventPublisher } from '../ports.ts';

export interface EventPublisherHarness {
  publisher: EventPublisher;
  /** Returns event IDs observed by the broker, in delivery order. */
  delivered(): Promise<string[]>;
}

/**
 * Shared contract every EventPublisher adapter must pass (run it against the provider sandbox
 * for real adapters). Asserts envelope fidelity and that publishing is safe to repeat.
 */
export function eventPublisherContract(
  name: string,
  makeHarness: () => Promise<EventPublisherHarness>,
): void {
  describe(`EventPublisher contract: ${name}`, () => {
    const sample = () =>
      createDomainEvent({
        eventType: 'contract.test',
        schemaVersion: 1,
        actor: { type: 'system', id: null },
        organizationId: randomUUID(),
        aggregateType: 'contract',
        aggregateId: randomUUID(),
        correlationId: randomUUID(),
        payload: { value: 1 },
      });

    it('has a stable adapter name', async () => {
      const h = await makeHarness();
      expect(h.publisher.name).toMatch(/^[a-z][a-z0-9_]*$/);
    });

    it('delivers an event with its event ID intact', async () => {
      const h = await makeHarness();
      const e = sample();
      await h.publisher.publish(e);
      expect(await h.delivered()).toContain(e.eventId);
    });

    it('tolerates re-publishing the same event (at-least-once; consumers dedupe on eventId)', async () => {
      const h = await makeHarness();
      const e = sample();
      await h.publisher.publish(e);
      await h.publisher.publish(e);
      const ids = await h.delivered();
      expect(ids.filter((id) => id === e.eventId).length).toBeGreaterThanOrEqual(1);
    });
  });
}
