import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFixtureEvent,
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
} from './testing/index.ts';
import { withTransaction } from './transaction.ts';

/**
 * Roadmap Phase 0 exit criterion: cross-tenant SQL access is denied by RLS even when the
 * caller (simulating a service-layer bug) issues queries for another tenant's rows.
 */
describe('PostgreSQL RLS tenant isolation (runtime role)', () => {
  const pools = createTestPools();
  let userA: string;
  let userB: string;
  let orgA: string;
  let orgB: string;
  let eventB: string;

  beforeAll(async () => {
    userA = (await createFixtureUser(pools.migrator)).id;
    userB = (await createFixtureUser(pools.migrator)).id;
    orgA = await createFixtureOrganization(pools.migrator, userA);
    orgB = await createFixtureOrganization(pools.migrator, userB);
    await createFixtureEvent(pools.migrator, orgA, userA);
    eventB = await createFixtureEvent(pools.migrator, orgB, userB);
  });
  afterAll(() => pools.end());

  const asTenantA = <T>(fn: Parameters<typeof withTransaction<T>>[2]) =>
    withTransaction(pools.app, { userId: userA, organizationId: orgA }, fn);

  it('runtime role is not superuser, cannot bypass RLS, and owns no tables', async () => {
    const { rows } = await pools.app.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      owned: string;
    }>(
      `SELECT r.rolsuper, r.rolbypassrls,
              (SELECT count(*) FROM pg_tables WHERE tableowner = current_user)::text AS owned
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owned: '0' });
  });

  it('every table with organization_id has RLS enabled and forced', async () => {
    const { rows } = await pools.migrator.query<{
      table: string;
      enabled: boolean;
      forced: boolean;
    }>(
      `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'eventhub' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows)
      expect({ table: r.table, enabled: r.enabled, forced: r.forced }).toEqual({
        table: r.table,
        enabled: true,
        forced: true,
      });
  });

  it('cannot read another tenant’s event by ID', async () => {
    const rows = await asTenantA(
      async (c) => (await c.query('SELECT id FROM eventhub.event WHERE id = $1', [eventB])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('sees only its own tenant’s rows in unfiltered queries', async () => {
    const orgs = await asTenantA(
      async (c) =>
        (
          await c.query<{ organization_id: string }>(
            'SELECT DISTINCT organization_id FROM eventhub.event',
          )
        ).rows,
    );
    expect(orgs.map((r) => r.organization_id)).toEqual([orgA]);
  });

  it('cannot insert a row into another tenant', async () => {
    await expect(
      asTenantA((c) =>
        c.query(
          `INSERT INTO eventhub.event (organization_id, name, slug, timezone, starts_at, ends_at, venue_mode, primary_language, created_by)
           VALUES ($1, 'x', 'injected', 'UTC', now(), now() + interval '1 day', 'virtual', 'en', $2)`,
          [orgB, userA],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot update or move another tenant’s rows', async () => {
    const updated = await asTenantA(
      async (c) =>
        (await c.query(`UPDATE eventhub.event SET name = 'pwned' WHERE id = $1`, [eventB]))
          .rowCount,
    );
    expect(updated).toBe(0);
    const { rows } = await pools.migrator.query('SELECT name FROM eventhub.event WHERE id = $1', [
      eventB,
    ]);
    expect(rows[0]).toEqual({ name: 'Fixture event' });
  });

  it('has no DELETE privilege on events', async () => {
    await expect(
      asTenantA((c) => c.query('DELETE FROM eventhub.event WHERE id = $1', [eventB])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot change tenant ownership columns (no column privilege)', async () => {
    await expect(
      asTenantA((c) => c.query('UPDATE eventhub.event SET organization_id = $1', [orgB])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('fails closed when no tenant context is set', async () => {
    const rows = await withTransaction(
      pools.app,
      {},
      async (c) => (await c.query('SELECT id FROM eventhub.event')).rows,
    );
    expect(rows).toEqual([]);
    const orgs = await withTransaction(
      pools.app,
      {},
      async (c) => (await c.query('SELECT id FROM eventhub.organization')).rows,
    );
    expect(orgs).toEqual([]);
  });

  it('cannot read another tenant’s memberships, audit, or organization', async () => {
    await asTenantA(async (c) => {
      expect(
        (await c.query('SELECT 1 FROM eventhub.membership WHERE organization_id = $1', [orgB]))
          .rows,
      ).toEqual([]);
      expect(
        (await c.query('SELECT 1 FROM eventhub.organization WHERE id = $1', [orgB])).rows,
      ).toEqual([]);
      expect(
        (await c.query('SELECT 1 FROM eventhub.audit_event WHERE organization_id = $1', [orgB]))
          .rows,
      ).toEqual([]);
    });
  });

  it('cannot read the session table or other users directly', async () => {
    await expect(
      asTenantA((c) => c.query('SELECT * FROM eventhub.auth_session')),
    ).rejects.toMatchObject({ code: '42501' });
    const users = await asTenantA(
      async (c) => (await c.query<{ id: string }>('SELECT id FROM eventhub.app_user')).rows,
    );
    expect(users.map((u) => u.id)).toEqual([userA]);
  });

  it('cannot write audit or outbox records for another tenant', async () => {
    await expect(
      asTenantA((c) =>
        c.query(
          `INSERT INTO eventhub.audit_event (organization_id, actor_type, actor_id, action, target_type, correlation_id)
           VALUES ($1, 'user', $2, 'event.created', 'event', 'c')`,
          [orgB, userA],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asTenantA((c) =>
        c.query(
          `INSERT INTO eventhub.outbox_event (id, organization_id, event_type, schema_version, aggregate_type, aggregate_id, actor_type, correlation_id, payload, occurred_at)
           VALUES ($1, $2, 'x.y', 1, 'event', $1, 'user', 'c', '{}', now())`,
          [randomUUID(), orgB],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('does not leak tenant context across pooled transactions', async () => {
    await asTenantA((c) => c.query('SELECT 1'));
    const leaked = await withTransaction(
      pools.app,
      {},
      async (c) =>
        (
          await c.query<{ v: string | null }>(
            "SELECT nullif(current_setting('app.organization_id', true), '') AS v",
          )
        ).rows[0]!.v,
    );
    expect(leaked).toBeNull();
  });
});
