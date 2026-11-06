import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  createDomainEvent,
  InMemoryEventPublisher,
  type DomainEvent,
  type EventPublisher,
} from '@eventhub/kernel';
import {
  claimDueEvents,
  enqueueEvent,
  outboxHealth,
  replayDeadEvents,
  withTransaction,
} from '@eventhub/db';
import {
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
  testDatabaseUrls,
} from '@eventhub/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { relayOnce } from '../src/outbox-relay.ts';

const run = promisify(execFile);

/** PostgreSQL outbox as the production broker (ADR-0009). */
describe('postgres outbox broker', () => {
  const pools = createTestPools();
  let userId: string;
  let orgId: string;
  beforeAll(async () => {
    userId = (await createFixtureUser(pools.migrator)).id;
    orgId = await createFixtureOrganization(pools.migrator, userId);
  });
  afterAll(() => pools.end());

  // Other suites leave pending events in the shared database; drain them so ordering is ours.
  beforeEach(async () => {
    const sink = new InMemoryEventPublisher();
    while ((await relayOnce(pools.worker, sink, { batchSize: 500, maxAttempts: 5 })).published > 0);
  });

  async function enqueue(): Promise<string> {
    const e = createDomainEvent({
      eventType: 'broker.test',
      schemaVersion: 1,
      actor: { type: 'user', id: userId },
      organizationId: orgId,
      aggregateType: 'broker',
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      payload: {},
    });
    await withTransaction(pools.app, { userId, organizationId: orgId }, (c) => enqueueEvent(c, e));
    return e.eventId;
  }

  const status = async (id: string) =>
    (
      await pools.migrator.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM eventhub.outbox_event WHERE id = $1',
        [id],
      )
    ).rows[0];

  it('locks one event at a time, so another replica can claim the next event during a slow delivery', async () => {
    const a = await enqueue();
    const b = await enqueue();
    let release!: () => void;
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    const slow: EventPublisher = {
      name: 'slow',
      async publish(e: DomainEvent) {
        if (e.eventId === a) {
          entered();
          await gate;
        }
      },
    };
    // A batch of 2: the old whole-batch transaction would lock A and B together.
    const relay = relayOnce(pools.worker, slow, { batchSize: 2, maxAttempts: 5 });
    await inFlight; // relay holds event A mid-delivery

    const other = await pools.worker.connect();
    try {
      await other.query('BEGIN');
      const claimed = (await claimDueEvents(other, 10)).map((c) => c.event.eventId);
      expect(claimed).toContain(b); // B is free for a second replica
      expect(claimed).not.toContain(a); // A is locked by the first
      await other.query('ROLLBACK');
    } finally {
      other.release();
    }
    release();
    expect(await relay).toEqual({ published: 2, retried: 0, deadLettered: 0 });
  });

  it('dead-letters a permanent failure immediately and retries a transient one', async () => {
    const permanent = await enqueue();
    const transient = await enqueue();
    const publisher: EventPublisher = {
      name: 'classifying',
      publish(e) {
        const err = Object.assign(
          new Error(e.eventId === permanent ? 'invalid_from_address' : 'timeout'),
          {
            retryable: e.eventId !== permanent,
          },
        );
        return Promise.reject(err);
      },
    };
    const stats = await relayOnce(pools.worker, publisher, { batchSize: 10, maxAttempts: 12 });
    expect(stats).toEqual({ published: 0, retried: 1, deadLettered: 1 });
    expect(await status(permanent)).toEqual({ status: 'dead', attempts: 1 });
    expect(await status(transient)).toEqual({ status: 'pending', attempts: 1 });
  });

  it('reports health: pending backlog, lag, and dead letters', async () => {
    const before = await outboxHealth(pools.worker);
    const id = await enqueue();
    await pools.migrator.query(
      `UPDATE eventhub.outbox_event SET available_at = now() - interval '10 minutes' WHERE id = $1`,
      [id],
    );
    const after = await outboxHealth(pools.worker);
    expect(after.pending).toBe(before.pending + 1);
    expect(after.oldestDueAgeSeconds).toBeGreaterThanOrEqual(600);
    expect(after.dead).toBeGreaterThanOrEqual(0);
  });

  it('replays a dead-lettered event with a fresh budget, then delivers it', async () => {
    const id = await enqueue();
    const failing: EventPublisher = {
      name: 'failing',
      publish: () =>
        Promise.reject(Object.assign(new Error('invalid_from_address'), { retryable: false })),
    };
    await relayOnce(pools.worker, failing, { batchSize: 10, maxAttempts: 5 });
    expect((await status(id))?.status).toBe('dead');

    const live = await enqueue(); // not dead: must be left alone by replay
    expect(await withTransaction(pools.worker, {}, (c) => replayDeadEvents(c, [id, live]))).toEqual(
      [id],
    );
    expect(await status(id)).toEqual({ status: 'pending', attempts: 0 });

    const ok = new InMemoryEventPublisher();
    await relayOnce(pools.worker, ok, { batchSize: 10, maxAttempts: 5 });
    expect(ok.published.map((e) => e.eventId)).toEqual(expect.arrayContaining([id, live]));
    expect((await status(id))?.status).toBe('published');
  });

  it('replay CLI: validates arguments and replays by event ID as the worker role', async () => {
    const cli = new URL('../src/cli/replay-dead-events.ts', import.meta.url).pathname;
    const env = { ...process.env, DATABASE_WORKER_URL: testDatabaseUrls().workerUrl };

    await expect(run(process.execPath, [cli, '--all-dead'], { env })).rejects.toMatchObject({
      code: 2,
    });
    await expect(
      run(process.execPath, [cli, '--event', 'not-a-uuid'], { env }),
    ).rejects.toMatchObject({ code: 2 });

    const id = await enqueue();
    await pools.migrator.query(
      `UPDATE eventhub.outbox_event SET status = 'dead', attempts = 12 WHERE id = $1`,
      [id],
    );
    const { stdout } = await run(process.execPath, [cli, '--event', id], { env });
    expect(stdout).toContain(`replayed 1 event(s): ${id}`);
    expect(await status(id)).toEqual({ status: 'pending', attempts: 0 });
  });
});
