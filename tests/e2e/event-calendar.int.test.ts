import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import {
  createFixtureEvent,
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
  type FixtureUser,
} from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';
import { calendarUid } from '../../apps/api/src/modules/public-site/routes.ts';

/** Add to calendar (ADR-0048): what the public calendar route returns, and when. */
describe('public event calendar', () => {
  const pools = createTestPools();
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.48.${Math.floor(++ip / 250)}.${ip % 250}` });
  const auth = (u: FixtureUser) => ({ authorization: `Bearer ${u.token}` });
  const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });

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

  async function setup(slug?: string) {
    const owner = await createFixtureUser(pools.migrator);
    const orgId = await createFixtureOrganization(pools.migrator, owner.id);
    const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
    const handle = `k-${randomUUID().slice(0, 8)}`;
    await pools.migrator.query(
      'UPDATE eventhub.organization SET public_handle = $2 WHERE id = $1',
      [orgId, handle],
    );
    if (slug) {
      await pools.migrator.query('UPDATE eventhub.event SET slug = $2 WHERE id = $1', [
        eventId,
        slug,
      ]);
    }
    const evtUrl = `/v1/organizations/${orgId}/events/${eventId}`;
    const current = async () =>
      (await call({ method: 'GET', url: evtUrl, headers: auth(owner) })).json<{
        version: number;
        slug: string;
      }>();
    const patch = async (payload: Record<string, unknown>) =>
      call({
        method: 'PATCH',
        url: evtUrl,
        headers: { ...auth(owner), ...idem() },
        payload: { expectedVersion: (await current()).version, ...payload },
      });
    /** Publishes the event with a published (empty) page, directly: publishing has its tests. */
    const goPublic = async () => {
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
      await pools.migrator.query(
        `UPDATE eventhub.event SET lifecycle = 'published' WHERE id = $1`,
        [eventId],
      );
    };
    const setLifecycle = (lifecycle: string) =>
      pools.migrator.query('UPDATE eventhub.event SET lifecycle = $2 WHERE id = $1', [
        eventId,
        lifecycle,
      ]);
    /** Published events refuse edits that break their checklist: edit as a draft, then republish. */
    const editPublished = async (payload: Record<string, unknown>) => {
      await setLifecycle('draft');
      const res = await patch(payload);
      await setLifecycle('published');
      return res;
    };
    const calendar = async (s?: string) =>
      call({
        method: 'GET',
        url: `/v1/public/sites/${handle}/events/${s ?? (await current()).slug}/calendar`,
      });
    return { owner, orgId, eventId, handle, patch, editPublished, goPublic, calendar, current };
  }

  it('returns the event for a published public page, with an opaque UID', async () => {
    const t = await setup();
    await t.patch({ settings: { visibility: 'public', sharing: { description: 'Two days.' } } });
    await t.goPublic();
    const res = await t.calendar();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const row = (
      await pools.migrator.query<{
        name: string;
        starts_at: Date;
        ends_at: Date;
        timezone: string;
        venue_mode: string;
        version: number;
      }>('SELECT * FROM eventhub.event WHERE id = $1', [t.eventId])
    ).rows[0]!;
    expect(body).toEqual({
      uid: calendarUid(t.eventId),
      sequence: row.version - 1,
      updatedAt: expect.any(String),
      name: row.name,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      timezone: row.timezone,
      venueMode: row.venue_mode,
      description: 'Two days.',
      cancelled: false,
    });
    // The UID is not the event's ID, and nothing else identifies the organization or event.
    expect(res.body).not.toContain(t.eventId);
    expect(res.body).not.toContain(t.orgId);
    expect(body.uid).toMatch(/^[0-9a-f]{32}@eventhub$/);
  });

  it('keeps the UID and raises the sequence when the event changes', async () => {
    const t = await setup();
    await t.patch({ settings: { visibility: 'public' } });
    await t.goPublic();
    const before = (await t.calendar()).json();
    const renamed = await t.editPublished({ name: 'Renamed Summit' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const after = (await t.calendar()).json();
    expect(after.uid).toBe(before.uid);
    expect(after.sequence).toBeGreaterThan(before.sequence);
    expect(after.name).toBe('Renamed Summit');
  });

  it('answers 404 whenever the page is not public', async () => {
    const t = await setup();
    // Draft event, no published page.
    expect((await t.calendar()).statusCode).toBe(404);
    await t.patch({ settings: { visibility: 'private' } });
    await t.goPublic();
    // Published but private.
    expect((await t.calendar()).statusCode).toBe(404);
    await t.editPublished({ settings: { visibility: 'unlisted' } });
    // Unlisted pages are reachable by link, so their calendar file is too.
    expect((await t.calendar()).statusCode).toBe(200);
    // Scheduled (not yet published), or a suspended organization.
    await pools.migrator.query(`UPDATE eventhub.event SET lifecycle = 'scheduled' WHERE id = $1`, [
      t.eventId,
    ]);
    expect((await t.calendar()).statusCode).toBe(404);
    await pools.migrator.query(`UPDATE eventhub.event SET lifecycle = 'published' WHERE id = $1`, [
      t.eventId,
    ]);
    await pools.migrator.query(
      `UPDATE eventhub.organization SET status = 'suspended' WHERE id = $1`,
      [t.orgId],
    );
    expect((await t.calendar()).statusCode).toBe(404);
    // Unknown slug and malformed input.
    const u = await setup();
    expect((await u.calendar('no-such-event')).statusCode).toBe(404);
    expect(
      (await call({ method: 'GET', url: `/v1/public/sites/${u.handle}/events/Bad_Slug/calendar` }))
        .statusCode,
    ).toBe(400);
  });

  it('answers 404 for a published event whose page is still a draft', async () => {
    const t = await setup();
    await t.patch({ settings: { visibility: 'public' } });
    await pools.migrator.query(
      `INSERT INTO eventhub.event_page (organization_id, event_id, draft_sections, draft_schema_version,
                                       draft_updated_by)
       VALUES ($1, $2, '[]', 1, $3)`,
      [t.orgId, t.eventId, t.owner.id],
    );
    await pools.migrator.query(`UPDATE eventhub.event SET lifecycle = 'published' WHERE id = $1`, [
      t.eventId,
    ]);
    expect((await t.calendar()).statusCode).toBe(404);
  });

  it('keeps organizations apart when they use the same slug', async () => {
    const slug = `same-${randomUUID().slice(0, 8)}`;
    const a = await setup(slug);
    const b = await setup(slug);
    for (const t of [a, b]) {
      await t.patch({ settings: { visibility: 'public' } });
      await t.goPublic();
    }
    await b.editPublished({ name: 'Organization B Summit' });
    const fromA = (await a.calendar(slug)).json();
    const fromB = (await b.calendar(slug)).json();
    expect(fromA.uid).toBe(calendarUid(a.eventId));
    expect(fromB.uid).toBe(calendarUid(b.eventId));
    expect(fromA.uid).not.toBe(fromB.uid);
    expect(fromA.name).not.toBe('Organization B Summit');
    // A's handle never reaches B's event, and B's event is private to A's handle.
    await b.editPublished({ settings: { visibility: 'private' } });
    expect((await a.calendar(slug)).statusCode).toBe(200);
    expect((await b.calendar(slug)).statusCode).toBe(404);
  });

  it('is reachable only through the definer function', async () => {
    await expect(
      pools.app.query('SELECT * FROM eventhub.public_event_calendar($1, $2)', ['x', 'y']),
    ).resolves.toBeDefined();
    await expect(
      pools.worker.query('SELECT * FROM eventhub.public_event_calendar($1, $2)', ['x', 'y']),
    ).rejects.toThrow(/permission denied/);
  });
});
