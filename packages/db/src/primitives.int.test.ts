import { randomUUID } from 'node:crypto';
import { AppError, createDomainEvent } from '@eventhub/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAudit } from './audit.ts';
import { claimIdempotencyKey, recordIdempotentResponse, requestHash } from './idempotency.ts';
import { loadMigrations, migrate } from './migrate.ts';
import { claimDueEvents, enqueueEvent, markFailed, markPublished, processOnce } from './outbox.ts';
import {
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
  testDatabaseUrls,
} from './testing/index.ts';
import { withTransaction } from './transaction.ts';
import pg from 'pg';

describe('audit + outbox + business record atomicity', () => {
  const pools = createTestPools();
  let userId: string;
  let orgId: string;
  beforeAll(async () => {
    userId = (await createFixtureUser(pools.migrator)).id;
    orgId = await createFixtureOrganization(pools.migrator, userId);
  });
  afterAll(() => pools.end());

  async function writeAll(
    slug: string,
    failAfterAudit: boolean,
  ): Promise<{ eventId: string; correlationId: string }> {
    const correlationId = randomUUID();
    let domainEventId = '';
    await withTransaction(pools.app, { userId, organizationId: orgId }, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO eventhub.event (organization_id, name, slug, timezone, starts_at, ends_at, venue_mode, primary_language, created_by)
         VALUES ($1, 'Atomic', $2, 'UTC', now(), now() + interval '1 day', 'virtual', 'en', $3) RETURNING id`,
        [orgId, slug, userId],
      );
      const id = rows[0]!.id;
      await writeAudit(c, {
        organizationId: orgId,
        actor: { type: 'user', id: userId },
        action: 'event.created',
        targetType: 'event',
        targetId: id,
        correlationId,
      });
      if (failAfterAudit) throw new Error('injected failure');
      const evt = createDomainEvent({
        eventType: 'event.created',
        schemaVersion: 1,
        actor: { type: 'user', id: userId },
        organizationId: orgId,
        aggregateType: 'event',
        aggregateId: id,
        correlationId,
        payload: { slug },
      });
      domainEventId = evt.eventId;
      await enqueueEvent(c, evt);
    });
    return { eventId: domainEventId, correlationId };
  }

  it('commits business record, audit event, and outbox event together', async () => {
    const { correlationId } = await writeAll('atomic-ok', false);
    const counts = await pools.migrator.query<{ e: string; a: string; o: string }>(
      `SELECT (SELECT count(*) FROM eventhub.event WHERE slug = 'atomic-ok' AND organization_id = $1)::text AS e,
              (SELECT count(*) FROM eventhub.audit_event WHERE correlation_id = $2)::text AS a,
              (SELECT count(*) FROM eventhub.outbox_event WHERE correlation_id = $2)::text AS o`,
      [orgId, correlationId],
    );
    expect(counts.rows[0]).toEqual({ e: '1', a: '1', o: '1' });
  });

  it('rolls back all three when any step fails', async () => {
    await expect(writeAll('atomic-fail', true)).rejects.toThrow('injected failure');
    const { rows } = await pools.migrator.query(
      `SELECT 1 FROM eventhub.event WHERE slug = 'atomic-fail'`,
    );
    expect(rows).toEqual([]);
    const audit = await pools.migrator.query(
      `SELECT 1 FROM eventhub.audit_event a JOIN eventhub.event e ON e.id = a.target_id WHERE e.slug = 'atomic-fail'`,
    );
    expect(audit.rows).toEqual([]);
  });

  it('audit events are append-only even for the schema owner', async () => {
    const { rows } = await pools.migrator.query<{ id: string }>(
      'SELECT id FROM eventhub.audit_event LIMIT 1',
    );
    const id = rows[0]!.id;
    await expect(
      pools.migrator.query(`UPDATE eventhub.audit_event SET action = 'x.y' WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pools.migrator.query('DELETE FROM eventhub.audit_event WHERE id = $1', [id]),
    ).rejects.toThrow(/append-only/);
    await expect(pools.migrator.query('TRUNCATE eventhub.audit_event')).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('idempotency keys', () => {
  const pools = createTestPools();
  let userId: string;
  let otherUser: string;
  beforeAll(async () => {
    userId = (await createFixtureUser(pools.migrator)).id;
    otherUser = (await createFixtureUser(pools.migrator)).id;
  });
  afterAll(() => pools.end());

  const claim = (actorId: string, key: string, body: unknown) => ({
    actorId,
    scope: 'test.scope',
    key,
    requestHash: requestHash('test.scope', body),
  });

  it('executes once and replays the stored response', async () => {
    const key = `k-${randomUUID()}`;
    const first = await withTransaction(pools.app, { userId }, async (c) => {
      const outcome = await claimIdempotencyKey(c, claim(userId, key, { a: 1 }));
      await recordIdempotentResponse(c, claim(userId, key, { a: 1 }), 201, { id: 'x' });
      return outcome;
    });
    expect(first).toEqual({ kind: 'new' });
    const second = await withTransaction(pools.app, { userId }, (c) =>
      claimIdempotencyKey(c, claim(userId, key, { a: 1 })),
    );
    expect(second).toEqual({ kind: 'replay', status: 201, body: { id: 'x' } });
  });

  it('rejects the same key with a different payload', async () => {
    const key = `k-${randomUUID()}`;
    await withTransaction(pools.app, { userId }, async (c) => {
      await claimIdempotencyKey(c, claim(userId, key, { a: 1 }));
      await recordIdempotentResponse(c, claim(userId, key, { a: 1 }), 201, {});
    });
    await expect(
      withTransaction(pools.app, { userId }, (c) =>
        claimIdempotencyKey(c, claim(userId, key, { a: 2 })),
      ),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('releases the key when the command transaction rolls back', async () => {
    const key = `k-${randomUUID()}`;
    await expect(
      withTransaction(pools.app, { userId }, async (c) => {
        await claimIdempotencyKey(c, claim(userId, key, { a: 1 }));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const retry = await withTransaction(pools.app, { userId }, (c) =>
      claimIdempotencyKey(c, claim(userId, key, { a: 1 })),
    );
    expect(retry).toEqual({ kind: 'new' });
  });

  it('serialises concurrent duplicates: the second replays the first committed result', async () => {
    const key = `k-${randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withTransaction(pools.app, { userId }, async (c) => {
      const o = await claimIdempotencyKey(c, claim(userId, key, { a: 1 }));
      await gate;
      await recordIdempotentResponse(c, claim(userId, key, { a: 1 }), 201, { winner: true });
      return o;
    });
    await new Promise((r) => setTimeout(r, 100));
    const second = withTransaction(pools.app, { userId }, (c) =>
      claimIdempotencyKey(c, claim(userId, key, { a: 1 })),
    );
    await new Promise((r) => setTimeout(r, 100));
    release();
    expect(await first).toEqual({ kind: 'new' });
    expect(await second).toEqual({ kind: 'replay', status: 201, body: { winner: true } });
  });

  it('scopes keys per actor (RLS): another user with the same key is independent', async () => {
    const key = `k-${randomUUID()}`;
    await withTransaction(pools.app, { userId }, async (c) => {
      await claimIdempotencyKey(c, claim(userId, key, { a: 1 }));
      await recordIdempotentResponse(c, claim(userId, key, { a: 1 }), 201, { owner: 'first' });
    });
    const other = await withTransaction(pools.app, { userId: otherUser }, (c) =>
      claimIdempotencyKey(c, claim(otherUser, key, { a: 2 })),
    );
    expect(other).toEqual({ kind: 'new' });
  });

  it('rejects malformed keys', async () => {
    await expect(
      withTransaction(pools.app, { userId }, (c) =>
        claimIdempotencyKey(c, claim(userId, 'bad key!', {})),
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('outbox relay primitives (worker role)', () => {
  const pools = createTestPools();
  let userId: string;
  let orgId: string;
  beforeAll(async () => {
    userId = (await createFixtureUser(pools.migrator)).id;
    orgId = await createFixtureOrganization(pools.migrator, userId);
  });
  afterAll(() => pools.end());

  async function enqueue(): Promise<string> {
    const evt = createDomainEvent({
      eventType: 'test.happened',
      schemaVersion: 1,
      actor: { type: 'user', id: userId },
      organizationId: orgId,
      aggregateType: 'test',
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      payload: { n: 1 },
    });
    await withTransaction(pools.app, { userId, organizationId: orgId }, (c) =>
      enqueueEvent(c, evt),
    );
    return evt.eventId;
  }

  it('claims, publishes, and does not re-claim published events', async () => {
    const id = await enqueue();
    await withTransaction(pools.worker, {}, async (c) => {
      const claimed = await claimDueEvents(c, 100);
      const mine = claimed.find((x) => x.event.eventId === id);
      expect(mine?.event.organizationId).toBe(orgId);
      expect(mine?.event.payload).toEqual({ n: 1 });
      await markPublished(c, id);
    });
    const again = await withTransaction(pools.worker, {}, (c) => claimDueEvents(c, 100));
    expect(again.find((x) => x.event.eventId === id)).toBeUndefined();
  });

  it('two concurrent relays never claim the same event', async () => {
    await enqueue();
    const c1 = await pools.worker.connect();
    const c2 = await pools.worker.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      const a = await claimDueEvents(c1, 100);
      const b = await claimDueEvents(c2, 100);
      const overlap = a.filter((x) => b.some((y) => y.event.eventId === x.event.eventId));
      expect(overlap).toEqual([]);
    } finally {
      await c1.query('ROLLBACK');
      await c2.query('ROLLBACK');
      c1.release();
      c2.release();
    }
  });

  it('backs off on failure and dead-letters after max attempts', async () => {
    const id = await enqueue();
    await withTransaction(pools.worker, {}, async (c) => {
      expect(await markFailed(c, id, 0, 2, 'broker unavailable')).toBe('retry');
    });
    let row = (
      await pools.migrator.query(
        'SELECT status, attempts, last_error FROM eventhub.outbox_event WHERE id = $1',
        [id],
      )
    ).rows[0];
    expect(row).toEqual({ status: 'pending', attempts: 1, last_error: 'broker unavailable' });
    await withTransaction(pools.worker, {}, async (c) => {
      expect(await markFailed(c, id, 1, 2, 'broker unavailable')).toBe('dead');
    });
    row = (
      await pools.migrator.query(
        'SELECT status, attempts FROM eventhub.outbox_event WHERE id = $1',
        [id],
      )
    ).rows[0];
    expect(row).toEqual({ status: 'dead', attempts: 2 });
  });

  it('worker cannot read tenant business tables', async () => {
    await expect(pools.worker.query('SELECT * FROM eventhub.event')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('consumers process each event at most once', async () => {
    const eventId = randomUUID();
    let calls = 0;
    const run = () =>
      withTransaction(pools.worker, {}, (c) =>
        processOnce(c, 'test.consumer', eventId, () => {
          calls += 1;
          return Promise.resolve();
        }),
      );
    expect(await run()).toBe('processed');
    expect(await run()).toBe('duplicate');
    expect(calls).toBe(1);
  });
});

describe('migration runner', () => {
  it('is idempotent on an up-to-date database and detects tampering', async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrls().migratorUrl });
    await client.connect();
    try {
      const migrations = await loadMigrations();
      const result = await migrate(client, migrations);
      expect(result.applied).toEqual([]);
      const tampered = migrations.map((m, i) => (i === 0 ? { ...m, checksum: 'f'.repeat(64) } : m));
      await expect(migrate(client, tampered)).rejects.toThrow(/checksum mismatch/);
    } finally {
      await client.end();
    }
  });
});
