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
const idem = (key = `k-${randomUUID()}`) => ({ 'idempotency-key': key });

const HERO = {
  id: 'hero',
  type: 'hero',
  version: 1,
  visible: true,
  heading: 'Jakarta Summit 2027',
  body: 'Two days of operations and branding.',
  ctaLabel: 'Register now',
};

async function setup(roles: string[] = []) {
  const owner = await createFixtureUser(pools.migrator);
  const orgId = await createFixtureOrganization(pools.migrator, owner.id);
  const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
  const members: Record<string, FixtureUser> = {};
  for (const role of roles) {
    const u = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgId, u.id, role);
    members[role] = u;
  }
  const url = `/v1/organizations/${orgId}/events/${eventId}/page`;
  const get = (as = owner) => app.inject({ method: 'GET', url, headers: auth(as) });
  const save = (payload: object, as = owner, headers = idem()) =>
    app.inject({
      method: 'POST',
      url: `${url}/draft`,
      headers: { ...auth(as), ...headers },
      payload,
    });
  const publish = (payload: object, as = owner, headers = idem()) =>
    app.inject({
      method: 'POST',
      url: `${url}/publish`,
      headers: { ...auth(as), ...headers },
      payload,
    });
  const revisions = (as = owner) =>
    app.inject({ method: 'GET', url: `${url}/revisions`, headers: auth(as) });
  return { owner, orgId, eventId, members, url, get, save, publish, revisions };
}

describe('event page drafts', () => {
  it('offers starter sections before the first save, without storing anything', async () => {
    const t = await setup();
    const res = await t.get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      pageId: null,
      draft: { version: 0, updatedAt: null },
      published: null,
      hasUnpublishedChanges: false,
    });
    expect(res.json().draft.sections.map((s: { type: string }) => s.type)).toEqual([
      'hero',
      'text',
      'agenda',
      'speakers',
      'register',
    ]);
    const { rowCount } = await pools.migrator.query(
      'SELECT 1 FROM eventhub.event_page WHERE event_id = $1',
      [t.eventId],
    );
    expect(rowCount).toBe(0);
  });

  it('saves with optimistic concurrency and audits counts, not content', async () => {
    const t = await setup();
    const first = await t.save({ expectedVersion: 0, sections: [HERO] });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ draft: { version: 1 }, hasUnpublishedChanges: true });

    const second = await t.save({
      expectedVersion: 1,
      sections: [{ ...HERO, heading: 'Renamed' }],
    });
    expect(second.json().draft).toMatchObject({ version: 2 });
    expect(second.json().draft.sections[0].heading).toBe('Renamed');

    const stale = await t.save({ expectedVersion: 1, sections: [HERO] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details.reason).toBe('version_conflict');
    // Creating twice from version 0 is a conflict too, not a second page.
    const again = await t.save({ expectedVersion: 0, sections: [HERO] });
    expect(again.statusCode).toBe(409);

    const { rows } = await pools.migrator.query(
      `SELECT metadata FROM eventhub.audit_event
        WHERE target_id = $1 AND action = 'event.page_draft_saved' ORDER BY occurred_at`,
      [t.eventId],
    );
    expect(rows.map((r) => r.metadata)).toEqual([
      { draftVersion: 1, sectionCount: 1 },
      { draftVersion: 2, sectionCount: 1 },
    ]);
    expect(JSON.stringify(rows)).not.toContain('Renamed');
    const outbox = await pools.migrator.query(
      `SELECT count(*)::int AS n FROM eventhub.outbox_event
        WHERE aggregate_id = $1 AND event_type = 'event.page_draft_saved'`,
      [t.eventId],
    );
    expect(outbox.rows[0].n).toBe(2);
  });

  it('rejects invalid sections with field paths', async () => {
    const t = await setup();
    const res = await t.save({
      expectedVersion: 0,
      sections: [
        { ...HERO, heading: '' },
        {
          id: 'agenda',
          type: 'agenda',
          version: 1,
          visible: true,
          heading: 'Agenda',
          items: [{ time: '25:00', title: 'Late' }],
        },
        { ...HERO, id: 'x', type: 'html', html: '<script>alert(1)</script>' },
      ],
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.fields.map((f: { path: string }) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(['body.sections.0.heading', 'body.sections.1.items.0.time']),
    );
  });

  it('replays an idempotent save instead of saving twice', async () => {
    const t = await setup();
    const key = idem();
    const a = await t.save({ expectedVersion: 0, sections: [HERO] }, t.owner, key);
    const b = await t.save({ expectedVersion: 0, sections: [HERO] }, t.owner, key);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json().draft.version).toBe(1);
  });
});

describe('publishing', () => {
  it('publishes immutable revisions and tracks unpublished changes', async () => {
    const t = await setup();
    await t.save({ expectedVersion: 0, sections: [HERO] });
    const pub = await t.publish({ expectedVersion: 1 });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({
      published: { revision: 1 },
      hasUnpublishedChanges: false,
    });
    // Nothing new to publish.
    const same = await t.publish({ expectedVersion: 1 });
    expect(same.json().error.details.reason).toBe('nothing_to_publish');

    // Editing the draft never changes the published revision.
    await t.save({ expectedVersion: 1, sections: [{ ...HERO, heading: 'Draft only' }] });
    const page = (await t.get()).json();
    expect(page).toMatchObject({ published: { revision: 1 }, hasUnpublishedChanges: true });
    const rev1 = await pools.migrator.query(
      `SELECT r.sections FROM eventhub.page_revision r
         JOIN eventhub.event_page p ON p.id = r.page_id
        WHERE p.event_id = $1 AND r.revision = 1`,
      [t.eventId],
    );
    expect(rev1.rows[0].sections[0].heading).toBe('Jakarta Summit 2027');

    // Publishing a stale review is refused.
    const stale = await t.publish({ expectedVersion: 1 });
    expect(stale.json().error.details.reason).toBe('version_conflict');
    expect((await t.publish({ expectedVersion: 2 })).json().published.revision).toBe(2);

    const list = (await t.revisions()).json().data;
    expect(list.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
    expect(list[0]).toMatchObject({
      publishedByYou: true,
      sectionCount: 1,
      visibleSectionCount: 1,
    });

    const audit = await pools.migrator.query(
      `SELECT metadata FROM eventhub.audit_event
        WHERE target_id = $1 AND action = 'event.page_published' ORDER BY occurred_at`,
      [t.eventId],
    );
    expect(audit.rows.map((r) => r.metadata.revision)).toEqual([1, 2]);
  });

  it('refuses to publish nothing, an unsaved page, or a page with every section hidden', async () => {
    const t = await setup();
    expect((await t.publish({ expectedVersion: 1 })).json().error.details.reason).toBe(
      'draft_missing',
    );
    await t.save({ expectedVersion: 0, sections: [{ ...HERO, visible: false }] });
    expect((await t.publish({ expectedVersion: 1 })).json().error.details.reason).toBe(
      'page_empty',
    );
  });

  it('keeps revisions immutable for the runtime role', async () => {
    const t = await setup();
    await t.save({ expectedVersion: 0, sections: [HERO] });
    await t.publish({ expectedVersion: 1 });
    const client = await pools.app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.organization_id', $1, true)`, [t.orgId]);
      await expect(
        client.query(`UPDATE eventhub.page_revision SET sections = '[]'::jsonb`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const client2 = await pools.app.connect();
    try {
      await client2.query('BEGIN');
      await client2.query(`SELECT set_config('app.organization_id', $1, true)`, [t.orgId]);
      await expect(client2.query(`DELETE FROM eventhub.page_revision`)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await client2.query('ROLLBACK');
      client2.release();
    }
  });
});

describe('page permissions and tenancy', () => {
  it('lets Content editors save but not publish; Viewers only read', async () => {
    const t = await setup(['content_editor', 'viewer', 'event_manager']);
    const editor = t.members.content_editor!;
    expect((await t.save({ expectedVersion: 0, sections: [HERO] }, editor)).statusCode).toBe(200);
    const denied = await t.publish({ expectedVersion: 1 }, editor);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.details.reason).toBe('missing_permission:event.publish');

    const viewer = t.members.viewer!;
    expect((await t.get(viewer)).statusCode).toBe(200);
    expect((await t.save({ expectedVersion: 1, sections: [HERO] }, viewer)).statusCode).toBe(403);

    const manager = t.members.event_manager!;
    expect((await t.publish({ expectedVersion: 1 }, manager)).statusCode).toBe(200);
    expect((await t.revisions(t.owner)).json().data[0].publishedByYou).toBe(false);
  });

  it("hides another organization's page entirely", async () => {
    const t = await setup();
    await t.save({ expectedVersion: 0, sections: [HERO] });
    const outsider = await createFixtureUser(pools.migrator);
    const otherOrg = await createFixtureOrganization(pools.migrator, outsider.id);
    for (const res of [
      await t.get(outsider),
      await t.save({ expectedVersion: 1, sections: [HERO] }, outsider),
      await t.publish({ expectedVersion: 1 }, outsider),
      await t.revisions(outsider),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    // Their own organization ID with this event ID: the event is not found.
    const crossUrl = `/v1/organizations/${otherOrg}/events/${t.eventId}/page`;
    const cross = await app.inject({ method: 'GET', url: crossUrl, headers: auth(outsider) });
    expect(cross.statusCode).toBe(404);
    const crossSave = await app.inject({
      method: 'POST',
      url: `${crossUrl}/draft`,
      headers: { ...auth(outsider), ...idem() },
      payload: { expectedVersion: 1, sections: [HERO] },
    });
    expect(crossSave.statusCode).toBe(404);
    expect((await t.get()).json().draft.sections[0].heading).toBe('Jakarta Summit 2027');
  });

  it('treats archived events as read-only', async () => {
    const t = await setup();
    await t.save({ expectedVersion: 0, sections: [HERO] });
    await pools.migrator.query(
      `UPDATE eventhub.event SET lifecycle = 'archived', archived_from = 'draft' WHERE id = $1`,
      [t.eventId],
    );
    const res = await t.save({ expectedVersion: 1, sections: [HERO] });
    expect(res.json().error.details.reason).toBe('event_archived');
    expect((await t.publish({ expectedVersion: 1 })).json().error.details.reason).toBe(
      'event_archived',
    );
    expect((await t.get()).statusCode).toBe(200);
  });
});

describe('program sections v2 (ADR-0040)', () => {
  const speakers = (items: object[], id = 'speakers') => ({
    id,
    type: 'speakers',
    version: 2,
    visible: true,
    heading: 'Speakers',
    items,
  });
  const agenda = (items: object[]) => ({
    id: 'agenda',
    type: 'agenda',
    version: 2,
    visible: true,
    heading: 'Agenda',
    items,
  });
  const ADE = { id: 'ade', name: 'Ade Wisnu', role: 'Host', bio: 'Runs events.\n\nLoves systems.' };
  const RINA = { id: 'rina', name: 'Rina', role: 'Speaker', bio: '' };
  const SESSION = {
    id: 'keynote',
    day: '2027-03-01',
    start: '09:30',
    end: '10:15',
    title: 'Opening keynote',
    room: 'Hall A',
    description: 'Why operations is a craft.',
    speakerIds: ['ade', 'rina'],
  };
  const fieldPaths = (res: {
    json(): { error: { details: { fields: Array<{ path: string }> } } };
  }) => res.json().error.details.fields.map((f) => f.path);

  it('starts new pages with v2 agenda and v3 speakers (photos, ADR-0042)', async () => {
    const t = await setup();
    const draft = (await t.get()).json().draft.sections as Array<{ type: string; version: number }>;
    expect(draft.filter((s) => s.type === 'agenda' || s.type === 'speakers')).toMatchObject([
      { type: 'agenda', version: 2 },
      { type: 'speakers', version: 3 },
    ]);
  });

  it('saves sessions with days, rooms and linked speakers, and keeps v1 sections valid', async () => {
    const t = await setup();
    const sections = [
      HERO,
      speakers([ADE, RINA]),
      agenda([
        SESSION,
        {
          ...SESSION,
          id: 'lunch',
          start: '12:00',
          end: '',
          speakerIds: [],
          room: '',
          description: '',
        },
      ]),
      // Published revisions keep v1 sections; drafts may still hold them.
      {
        id: 'old-agenda',
        type: 'agenda',
        version: 1,
        visible: false,
        heading: 'Old',
        items: [{ time: '09:00', title: 'Doors' }],
      },
      {
        id: 'old-speakers',
        type: 'speakers',
        version: 1,
        visible: false,
        heading: 'Old',
        items: [{ name: 'X', role: '' }],
      },
    ];
    const res = await t.save({ expectedVersion: 0, sections });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().draft.sections).toEqual(sections);
    const pub = await t.publish({ expectedVersion: 1 });
    expect(pub.statusCode, pub.body).toBe(200);
  });

  it('refuses sessions that name speakers who are not on the page', async () => {
    const t = await setup();
    const res = await t.save({
      expectedVersion: 0,
      sections: [HERO, speakers([ADE]), agenda([SESSION])],
    });
    expect(res.statusCode).toBe(400);
    expect(fieldPaths(res)).toContain('body.sections.2.items.0.speakerIds.1');
    // v1 speakers have no IDs, so they cannot be linked either.
    const v1 = await t.save({
      expectedVersion: 0,
      sections: [
        HERO,
        {
          id: 'people',
          type: 'speakers',
          version: 1,
          visible: true,
          heading: 'S',
          items: [{ name: 'Ade', role: '' }],
        },
        agenda([{ ...SESSION, speakerIds: ['ade'] }]),
      ],
    });
    expect(v1.statusCode).toBe(400);
  });

  it('validates times, days, IDs and lengths', async () => {
    const t = await setup();
    const cases: Array<[object[], string]> = [
      [
        [HERO, speakers([ADE, RINA]), agenda([{ ...SESSION, end: '09:00' }])],
        'body.sections.2.items.0.end',
      ],
      [
        [HERO, speakers([ADE, RINA]), agenda([{ ...SESSION, end: '09:30' }])],
        'body.sections.2.items.0.end',
      ],
      [
        [HERO, speakers([ADE, RINA]), agenda([{ ...SESSION, start: '9:30' }])],
        'body.sections.2.items.0.start',
      ],
      [
        [HERO, speakers([ADE, RINA]), agenda([{ ...SESSION, day: '2027-13-01' }])],
        'body.sections.2.items.0.day',
      ],
      [[HERO, speakers([ADE, RINA]), agenda([SESSION, SESSION])], 'body.sections.2.items.1.id'],
      [[HERO, speakers([ADE, ADE])], 'body.sections.1.items.1.id'],
      [[HERO, speakers([ADE]), speakers([ADE], 'more')], 'body.sections.2.items.0.id'],
      [[HERO, speakers([{ ...ADE, bio: 'x'.repeat(801) }])], 'body.sections.1.items.0.bio'],
      [[HERO, speakers([{ ...ADE, name: 'Line\nbreak' }])], 'body.sections.1.items.0.name'],
      [
        [HERO, speakers([ADE, RINA]), agenda([{ ...SESSION, room: 'r'.repeat(61) }])],
        'body.sections.2.items.0.room',
      ],
      [
        [HERO, speakers([ADE, RINA]), agenda([{ ...SESSION, speakerIds: Array(11).fill('ade') }])],
        'body.sections.2.items.0.speakerIds',
      ],
      [
        [HERO, speakers([ADE]), agenda([{ ...SESSION, photoUrl: 'https://example.com/x.png' }])],
        'body.sections.2.items.0',
      ],
      [[HERO, { ...speakers([ADE]), version: 3 }], 'body.sections.1'],
    ];
    for (const [sections, path] of cases) {
      const res = await t.save({ expectedVersion: 0, sections });
      expect(res.statusCode, path).toBe(400);
      expect(
        fieldPaths(res).some((p: string) => p.startsWith(path)),
        `${path} in ${fieldPaths(res).join(', ')}`,
      ).toBe(true);
    }
  });

  it('serves v2 sections on the public page as text', async () => {
    const t = await setup();
    const evil = { ...ADE, name: '<img src=x onerror=alert(1)>', bio: '<script>alert(1)</script>' };
    const sections = [HERO, speakers([evil, RINA]), agenda([SESSION])];
    expect((await t.save({ expectedVersion: 0, sections })).statusCode).toBe(200);
    expect((await t.publish({ expectedVersion: 1 })).statusCode).toBe(200);
    const handle = `p-${randomUUID().slice(0, 8)}`;
    await pools.migrator.query(
      'UPDATE eventhub.organization SET public_handle = $2 WHERE id = $1',
      [t.orgId, handle],
    );
    const { rows } = await pools.migrator.query<{ slug: string }>(
      `UPDATE eventhub.event SET lifecycle = 'published',
              settings = '{"visibility":"public","legal":{"privacyPolicyUrl":"https://example.com/privacy"}}'
        WHERE id = $1 RETURNING slug`,
      [t.eventId],
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/public/sites/${handle}/events/${rows[0]!.slug}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    // The API stores and returns text; renderers emit it as text nodes (ADR-0020).
    expect(res.json().sections[1].items[0]).toEqual(evil);
    expect(res.json().sections[2].items[0]).toEqual(SESSION);
  });
});
