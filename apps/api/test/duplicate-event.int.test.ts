import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
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
import { shiftSettings } from '../src/modules/event/routes.ts';

/** Duplicating an event into a new draft (ADR-0036). */
const pools = createTestPools();
let app: FastifyInstance;

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
const DRAFT = [{ id: 'hero', type: 'hero', heading: 'Draft heading' }];
const PUBLISHED = [{ id: 'hero', type: 'hero', heading: 'Published heading' }];
const SETTINGS = {
  visibility: 'public',
  sharing: { title: 'Summit 2026', description: 'Two days of talks.' },
  legal: { privacyPolicyUrl: 'https://example.com/privacy' },
  registration: {
    opensAt: '2026-01-10T02:00:00.000Z',
    closesAt: '2026-03-01T00:00:00.000Z',
    capacity: 120,
    waitlist: true,
  },
};

/** A published event that started on 2026-03-01 09:00 Jakarta, with a page and attendees. */
async function setup() {
  const owner = await createFixtureUser(pools.migrator);
  const orgId = await createFixtureOrganization(pools.migrator, owner.id);
  const eventId = await createFixtureEvent(
    pools.migrator,
    orgId,
    owner.id,
    `summit-${randomUUID().slice(0, 6)}`,
  );
  await pools.migrator.query(
    `UPDATE eventhub.event SET name = 'Summit 2026', lifecycle = 'published', timezone = 'Asia/Jakarta',
            starts_at = '2026-03-01T02:00:00Z', ends_at = '2026-03-02T10:00:00Z',
            venue_mode = 'hybrid', primary_language = 'id', settings = $2
      WHERE id = $1`,
    [eventId, JSON.stringify(SETTINGS)],
  );
  const page = await pools.migrator.query<{ id: string }>(
    `INSERT INTO eventhub.event_page (organization_id, event_id, draft_sections, draft_schema_version,
                                     draft_version, draft_updated_by, published_revision,
                                     published_draft_version)
     VALUES ($1, $2, $3, 1, 4, $4, 2, 3) RETURNING id`,
    [orgId, eventId, JSON.stringify(DRAFT), owner.id],
  );
  await pools.migrator.query(
    `INSERT INTO eventhub.page_revision (organization_id, page_id, revision, sections, schema_version,
                                        draft_version, published_by)
     VALUES ($1, $2, 1, '[]', 1, 1, $3), ($1, $2, 2, $4, 1, 3, $3)`,
    [orgId, page.rows[0]!.id, owner.id, JSON.stringify(PUBLISHED)],
  );
  await pools.migrator.query(
    `INSERT INTO eventhub.registration (organization_id, event_id, email, name, privacy_policy_url)
     VALUES ($1, $2, 'someone@example.test', 'Some One', 'https://example.com/privacy')`,
    [orgId, eventId],
  );
  const member = async (role: string) => {
    const u = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgId, u.id, role);
    return u;
  };
  const duplicate = (
    payload: object,
    as: FixtureUser = owner,
    url = `/v1/organizations/${orgId}/events/${eventId}/duplicate`,
    key = `k-${randomUUID()}`,
  ) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...auth(as), 'idempotency-key': key },
      payload,
    });
  return { owner, orgId, eventId, member, duplicate };
}

const body = (slug = `summit-2027-${randomUUID().slice(0, 6)}`) => ({
  name: 'Summit 2027',
  slug,
  startsAt: '2027-03-07T09:00:00+07:00',
});

describe('duplicating an event', () => {
  it('creates a draft with new dates, the same details, and the window moved along', async () => {
    const t = await setup();
    const res = await t.duplicate(body());
    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json();
    expect(copy).toMatchObject({
      name: 'Summit 2027',
      lifecycle: 'draft',
      timezone: 'Asia/Jakarta',
      venueMode: 'hybrid',
      primaryLanguage: 'id',
      startsAt: '2027-03-07T02:00:00.000Z',
      // Same length: 32 hours.
      endsAt: '2027-03-08T10:00:00.000Z',
      version: 1,
      lifecycleChangedAt: null,
    });
    expect(copy.id).not.toBe(t.eventId);
    // Shifted by 371 days, the same as the event.
    expect(copy.settings).toEqual({
      ...SETTINGS,
      registration: {
        opensAt: '2027-01-16T02:00:00.000Z',
        closesAt: '2027-03-07T00:00:00.000Z',
        capacity: 120,
        waitlist: true,
      },
    });
  });

  it('copies the draft page, never the published revision or the attendees', async () => {
    const t = await setup();
    const copy = (await t.duplicate(body())).json();
    const { rows } = await pools.migrator.query(
      `SELECT draft_sections, draft_version, published_revision, published_draft_version
         FROM eventhub.event_page WHERE event_id = $1`,
      [copy.id],
    );
    expect(rows).toEqual([
      {
        draft_sections: DRAFT,
        draft_version: 1,
        published_revision: null,
        published_draft_version: null,
      },
    ]);
    const revisions = await pools.migrator.query(
      `SELECT 1 FROM eventhub.page_revision r JOIN eventhub.event_page p ON p.id = r.page_id
        WHERE p.event_id = $1`,
      [copy.id],
    );
    expect(revisions.rowCount).toBe(0);
    const regs = await pools.migrator.query(
      'SELECT 1 FROM eventhub.registration WHERE event_id = $1',
      [copy.id],
    );
    expect(regs.rowCount).toBe(0);
    // The draft copy is not publicly routable.
    const handle = `d-${randomUUID().slice(0, 8)}`;
    await pools.migrator.query(
      'UPDATE eventhub.organization SET public_handle = $2 WHERE id = $1',
      [t.orgId, handle],
    );
    const pub = await app.inject({
      method: 'GET',
      url: `/v1/public/sites/${handle}/events/${copy.slug}`,
    });
    expect(pub.statusCode).toBe(404);
  });

  it('works without a page, and from an archived event', async () => {
    const owner = await createFixtureUser(pools.migrator);
    const orgId = await createFixtureOrganization(pools.migrator, owner.id);
    const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
    await pools.migrator.query(
      `UPDATE eventhub.event SET lifecycle = 'archived', archived_from = 'ended' WHERE id = $1`,
      [eventId],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/events/${eventId}/duplicate`,
      headers: { ...auth(owner), 'idempotency-key': `k-${randomUUID()}` },
      payload: body(),
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ lifecycle: 'draft', archivedFrom: null, settings: {} });
  });

  it('is audited with its source, and replays on the same idempotency key', async () => {
    const t = await setup();
    const key = `k-${randomUUID()}`;
    const b = body();
    const first = await t.duplicate(b, t.owner, undefined, key);
    const again = await t.duplicate(b, t.owner, undefined, key);
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(first.json().id);
    const { rows } = await pools.migrator.query(
      `SELECT actor_id, target_id, metadata FROM eventhub.audit_event
        WHERE organization_id = $1 AND action = 'event.created'`,
      [t.orgId],
    );
    expect(rows).toEqual([
      {
        actor_id: t.owner.id,
        target_id: first.json().id,
        metadata: { slug: b.slug, lifecycle: 'draft', duplicatedFrom: t.eventId, pagesCopied: 1 },
      },
    ]);
  });

  it('validates the new name, address and start, and refuses a taken address', async () => {
    const t = await setup();
    const taken = await t.duplicate(body('taken-slug'));
    expect(taken.statusCode).toBe(201);
    const conflict = await t.duplicate(body('taken-slug'));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.details.reason).toBe('event_slug_taken');
    for (const bad of [
      { ...body(), slug: 'Not A Slug' },
      { ...body(), slug: 'cancel-registration' },
      { ...body(), name: '' },
      { ...body(), startsAt: 'next week' },
      { name: 'Missing start', slug: 'missing-start' },
      { ...body(), endsAt: '2027-03-08T10:00:00Z' },
    ]) {
      const res = await t.duplicate(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('needs event.create, and keeps organizations apart', async () => {
    const t = await setup();
    for (const role of ['viewer', 'content_editor', 'registration_manager', 'analyst']) {
      const res = await t.duplicate(body(), await t.member(role));
      expect(res.statusCode, role).toBe(403);
    }
    expect((await t.duplicate(body(), await t.member('event_manager'))).statusCode).toBe(201);

    // An Owner of another organization cannot copy this event, through either organization.
    const other = await createFixtureUser(pools.migrator);
    const otherOrg = await createFixtureOrganization(pools.migrator, other.id);
    expect((await t.duplicate(body(), other)).statusCode).toBe(404);
    const viaOwnOrg = await t.duplicate(
      body(),
      other,
      `/v1/organizations/${otherOrg}/events/${t.eventId}/duplicate`,
    );
    expect(viaOwnOrg.statusCode).toBe(404);
    const leaked = await pools.migrator.query(
      'SELECT 1 FROM eventhub.event WHERE organization_id = $1',
      [otherOrg],
    );
    expect(leaked.rowCount).toBe(0);
  });
});

describe('shiftSettings', () => {
  it('moves only the registration window', () => {
    const day = 86_400_000;
    expect(
      shiftSettings(
        { registration: { opensAt: '2026-01-01T00:00:00+07:00', capacity: 5 } },
        2 * day,
      ),
    ).toEqual({ registration: { opensAt: '2026-01-02T17:00:00.000Z', capacity: 5 } });
    const none = { visibility: 'public' as const };
    expect(shiftSettings(none, day)).toBe(none);
    expect(shiftSettings({ registration: { capacity: 3 } }, day)).toEqual({
      registration: { capacity: 3 },
    });
  });
});
