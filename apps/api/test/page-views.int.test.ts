import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addFixtureMembership,
  createFixtureEvent,
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
  type FixtureUser,
} from '@eventhub/db/testing';
import { Argon2idPasswordHasher } from '../src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../src/app.ts';
import { DatabaseSessionAuthenticator } from '../src/modules/identity/authenticator.ts';

/** Page-view counts (ADR-0044): a daily number per event, nothing about the visitor. */
const pools = createTestPools();
let app: FastifyInstance;
let ip = 0;
const call = (opts: InjectOptions, remoteAddress = `10.75.${Math.floor(++ip / 250)}.${ip % 250}`) =>
  app.inject({ ...opts, remoteAddress });

beforeAll(async () => {
  app = await buildApp({
    pool: pools.app,
    authenticator: new DatabaseSessionAuthenticator(pools.app),
    passwordHasher: new Argon2idPasswordHasher(),
    identity: { sessionTtlSeconds: 3600, loginMaxFailures: 5, loginLockSeconds: 900 },
    logger: false,
    validateResponses: true,
    rateLimitPerMinute: 10_000,
  });
});
afterAll(async () => {
  await app.close();
  await pools.end();
});

const auth = (u: FixtureUser) => ({ authorization: `Bearer ${u.token}` });

/** A published public event with a published page (set up directly; publishing has its tests). */
async function publicEvent(timezone = 'Asia/Jakarta', roles: string[] = []) {
  const owner = await createFixtureUser(pools.migrator);
  const orgId = await createFixtureOrganization(pools.migrator, owner.id);
  const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
  const handle = `v-${randomUUID().slice(0, 8)}`;
  await pools.migrator.query('UPDATE eventhub.organization SET public_handle = $2 WHERE id = $1', [
    orgId,
    handle,
  ]);
  const { rows } = await pools.migrator.query<{ slug: string }>(
    `UPDATE eventhub.event SET lifecycle = 'published', timezone = $2,
            settings = '{"visibility":"public"}'
      WHERE id = $1 RETURNING slug`,
    [eventId, timezone],
  );
  const page = await pools.migrator.query<{ id: string }>(
    `INSERT INTO eventhub.event_page (organization_id, event_id, draft_sections, draft_schema_version,
                                     draft_updated_by, published_revision, published_draft_version)
     VALUES ($1, $2, '[]', 1, $3, 1, 1) RETURNING id`,
    [orgId, eventId, owner.id],
  );
  await pools.migrator.query(
    `INSERT INTO eventhub.page_revision (organization_id, page_id, revision, sections, schema_version,
                                        draft_version, published_by)
     VALUES ($1, $2, 1, '[]', 1, 1, $3)`,
    [orgId, page.rows[0]!.id, owner.id],
  );
  const members: Record<string, FixtureUser> = {};
  for (const role of roles) {
    const u = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgId, u.id, role);
    members[role] = u;
  }
  const slug = rows[0]!.slug;
  const view = (remoteAddress?: string, h = handle, s = slug) =>
    call({ method: 'POST', url: `/v1/public/sites/${h}/events/${s}/views` }, remoteAddress);
  const report = (as = owner) =>
    call({
      method: 'GET',
      url: `/v1/organizations/${orgId}/events/${eventId}/report`,
      headers: auth(as),
    });
  const orgReport = (query = '', as = owner) =>
    call({ method: 'GET', url: `/v1/organizations/${orgId}/report${query}`, headers: auth(as) });
  const stored = async () =>
    (
      await pools.migrator.query<{ day: string; views: string }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, views::text FROM eventhub.event_page_view_day
          WHERE event_id = $1 ORDER BY day`,
        [eventId],
      )
    ).rows;
  return { owner, orgId, eventId, handle, slug, members, view, report, orgReport, stored };
}

const today = async (timezone: string) =>
  (
    await pools.migrator.query<{ d: string }>(
      `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`,
      [timezone],
    )
  ).rows[0]!.d;

describe('counting views', () => {
  it('counts views of a public page per day, in the event’s own calendar', async () => {
    // UTC+14: often a different date from UTC.
    const t = await publicEvent('Pacific/Kiritimati');
    for (let i = 0; i < 3; i++) expect((await t.view()).statusCode).toBe(204);
    expect(await t.stored()).toEqual([{ day: await today('Pacific/Kiritimati'), views: '3' }]);
    // The table has no column that could hold anything about the visitor.
    const columns = await pools.migrator.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'eventhub' AND table_name = 'event_page_view_day' ORDER BY 1`,
    );
    expect(columns.rows.map((c) => c.column_name)).toEqual([
      'day',
      'event_id',
      'organization_id',
      'views',
    ]);
  });

  it('counts only what anyone can see: everything else is 404 and counts nothing', async () => {
    const t = await publicEvent();
    expect((await t.view(undefined, 'nobody-here')).statusCode).toBe(404);
    expect((await t.view(undefined, t.handle, 'no-such-event')).statusCode).toBe(404);
    const set = (sql: string) => pools.migrator.query(sql, [t.eventId]);
    await set(`UPDATE eventhub.event SET settings = '{"visibility":"private"}' WHERE id = $1`);
    expect((await t.view()).statusCode).toBe(404);
    await set(`UPDATE eventhub.event SET settings = '{"visibility":"unlisted"}' WHERE id = $1`);
    expect((await t.view()).statusCode).toBe(204);
    await set(`UPDATE eventhub.event SET lifecycle = 'scheduled' WHERE id = $1`);
    expect((await t.view()).statusCode).toBe(404);
    await set(`UPDATE eventhub.event SET lifecycle = 'live' WHERE id = $1`);
    await set(
      `UPDATE eventhub.event_page SET published_revision = NULL, published_draft_version = NULL WHERE event_id = $1`,
    );
    expect((await t.view()).statusCode).toBe(404);
    await set(
      `UPDATE eventhub.event_page SET published_revision = 1, published_draft_version = 1 WHERE event_id = $1`,
    );
    await pools.migrator.query(
      `UPDATE eventhub.organization SET status = 'suspended' WHERE id = $1`,
      [t.orgId],
    );
    expect((await t.view()).statusCode).toBe(404);
    expect((await t.stored()).map((r) => r.views)).toEqual(['1']);
  });

  it('limits each visitor to 30 counted requests a minute', async () => {
    const t = await publicEvent();
    const visitor = '198.51.100.7';
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await t.view(visitor)).statusCode);
    expect(codes.filter((c) => c === 204)).toHaveLength(30);
    expect(codes.at(-1)).toBe(429);
    expect(await t.stored()).toMatchObject([{ views: '30' }]);
    // Another visitor is not affected.
    expect((await t.view('198.51.100.8')).statusCode).toBe(204);
  });

  it('cannot be written directly by the runtime role, nor read across organizations', async () => {
    const t = await publicEvent();
    await t.view();
    await expect(
      pools.app.query(
        `INSERT INTO eventhub.event_page_view_day (organization_id, event_id, day, views)
         VALUES ($1, $2, current_date, 1000)`,
        [t.orgId, t.eventId],
      ),
    ).rejects.toThrow(/permission denied/);
    // Without tenant context, RLS shows nothing.
    const { rows } = await pools.app.query('SELECT * FROM eventhub.event_page_view_day');
    expect(rows).toEqual([]);
  });
});

describe('reports', () => {
  async function seed(t: { orgId: string; eventId: string }, days: Array<[string, number]>) {
    for (const [day, views] of days) {
      await pools.migrator.query(
        `INSERT INTO eventhub.event_page_view_day (organization_id, event_id, day, views)
         VALUES ($1, $2, $3, $4)`,
        [t.orgId, t.eventId, day, views],
      );
    }
  }

  it('event report: total and views by day with gaps filled', async () => {
    const t = await publicEvent('Asia/Jakarta', ['analyst', 'viewer']);
    await seed(t, [
      ['2027-01-01', 5],
      ['2027-01-04', 2],
    ]);
    const res = await t.report(t.members.analyst);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().totals.pageViews).toBe(7);
    expect(res.json().pageViewsByDay).toEqual([
      { date: '2027-01-01', views: 5 },
      { date: '2027-01-02', views: 0 },
      { date: '2027-01-03', views: 0 },
      { date: '2027-01-04', views: 2 },
    ]);
    expect((await t.report(t.members.viewer)).statusCode).toBe(403);
    // No views yet: zero and an empty series.
    const quiet = await publicEvent();
    expect((await quiet.report()).json()).toMatchObject({
      totals: { pageViews: 0 },
      pageViewsByDay: [],
    });
  });

  it('organization report: per event and in total, for the events of the period', async () => {
    const t = await publicEvent();
    await seed(t, [['2027-01-01', 4]]);
    const other = await createFixtureEvent(pools.migrator, t.orgId, t.owner.id);
    await pools.migrator.query(
      `UPDATE eventhub.event SET starts_at = '2030-06-01T10:00:00Z', ends_at = '2030-06-01T12:00:00Z'
        WHERE id = $1`,
      [other],
    );
    await seed({ orgId: t.orgId, eventId: other }, [['2027-01-01', 6]]);
    const all = (await t.orgReport()).json();
    expect(all.totals.pageViews).toBe(10);
    const byId = Object.fromEntries(
      (all.events as Array<{ id: string; pageViews: number }>).map((e) => [e.id, e.pageViews]),
    );
    expect(byId).toEqual({ [t.eventId]: 4, [other]: 6 });
    // A period selects events by start date; their views count with them.
    const period = (await t.orgReport('?from=2030-01-01&to=2030-12-31')).json();
    expect(period.totals.pageViews).toBe(6);
    expect(period.events.map((e: { id: string }) => e.id)).toEqual([other]);
  });

  it('never mixes organizations', async () => {
    const a = await publicEvent();
    const b = await publicEvent();
    await seed(a, [['2027-01-01', 9]]);
    expect((await b.orgReport()).json().totals.pageViews).toBe(0);
    const cross = await call({
      method: 'GET',
      url: `/v1/organizations/${a.orgId}/events/${a.eventId}/report`,
      headers: auth(b.owner),
    });
    expect(cross.statusCode).toBe(404);
  });
});
