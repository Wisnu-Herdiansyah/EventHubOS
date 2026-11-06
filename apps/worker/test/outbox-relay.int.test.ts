import { randomUUID } from 'node:crypto';
import { createDomainEvent, InMemoryEventPublisher } from '@eventhub/kernel';
import { enqueueEvent, withTransaction } from '@eventhub/db';
import {
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
} from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relayOnce } from '../src/outbox-relay.ts';

describe('outbox relay', () => {
  const pools = createTestPools();
  let userId: string;
  let orgId: string;
  beforeAll(async () => {
    userId = (await createFixtureUser(pools.migrator)).id;
    orgId = await createFixtureOrganization(pools.migrator, userId);
  });
  afterAll(() => pools.end());

  async function enqueue(): Promise<string> {
    const e = createDomainEvent({
      eventType: 'relay.test',
      schemaVersion: 1,
      actor: { type: 'user', id: userId },
      organizationId: orgId,
      aggregateType: 'relay',
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      payload: {},
    });
    await withTransaction(pools.app, { userId, organizationId: orgId }, (c) => enqueueEvent(c, e));
    return e.eventId;
  }

  it('publishes pending events exactly once per successful pass', async () => {
    const id = await enqueue();
    const publisher = new InMemoryEventPublisher();
    await relayOnce(pools.worker, publisher, { batchSize: 500, maxAttempts: 5 });
    await relayOnce(pools.worker, publisher, { batchSize: 500, maxAttempts: 5 });
    expect(publisher.published.filter((e) => e.eventId === id)).toHaveLength(1);
    const { rows } = await pools.migrator.query(
      'SELECT status FROM eventhub.outbox_event WHERE id = $1',
      [id],
    );
    expect(rows[0].status).toBe('published');
  });

  it('schedules a retry when the broker fails, without losing the event', async () => {
    const id = await enqueue();
    const publisher = new InMemoryEventPublisher();
    publisher.failNext(1_000);
    const stats = await relayOnce(pools.worker, publisher, { batchSize: 500, maxAttempts: 5 });
    expect(stats.retried).toBeGreaterThanOrEqual(1);
    const { rows } = await pools.migrator.query(
      'SELECT status, attempts FROM eventhub.outbox_event WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ status: 'pending', attempts: 1 });
  });
});
