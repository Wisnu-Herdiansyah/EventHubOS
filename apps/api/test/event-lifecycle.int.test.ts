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
const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });

const READY_SETTINGS = {
  visibility: 'public',
  sharing: { title: 'Jakarta Summit', description: 'A day of talks.' },
  legal: { privacyPolicyUrl: 'https://example.com/privacy' },
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
  const url = `/v1/organizations/${orgId}/events/${eventId}`;
  const get = async (as = owner) =>
    (await app.inject({ method: 'GET', url, headers: auth(as) })).json();
  const patch = (payload: object, as = owner) =>
    app.inject({ method: 'PATCH', url, headers: { ...auth(as), ...idem() }, payload });
  const transition = (payload: object, as = owner, headers = idem()) =>
    app.inject({
      method: 'POST',
      url: `${url}/transitions`,
      headers: { ...auth(as), ...headers },
      payload,
    });
  const checklist = async (as = owner) =>
    (await app.inject({ method: 'GET', url: `${url}/checklist`, headers: auth(as) })).json();
  return { owner, orgId, eventId, members, url, get, patch, transition, checklist };
}

describe('updating event settings (EVT-02)', () => {
  it('updates details and settings, bumps the version, and audits field names only', async () => {
    const t = await setup();
    const res = await t.patch({
      expectedVersion: 1,
      name: 'Jakarta Summit 2027',
      settings: { ...READY_SETTINGS, contact: { email: 'hello@example.com' } },
    });
    expect(res.statusCode).toBe(200);
    const evt = res.json();
    expect(evt).toMatchObject({
      name: 'Jakarta Summit 2027',
      version: 2,
      settings: { contact: { email: 'hello@example.com' } },
    });

    const { rows } = await pools.migrator.query(
      `SELECT metadata FROM eventhub.audit_event WHERE target_id = $1 AND action = 'event.updated'`,
      [t.eventId],
    );
    expect(rows[0].metadata.fields).toEqual(
      expect.arrayContaining(['name', 'settings.contact', 'settings.legal']),
    );
    expect(JSON.stringify(rows[0].metadata)).not.toContain('hello@example.com');
  });

  it('rejects a stale version (optimistic concurrency)', async () => {
    const t = await setup();
    expect((await t.patch({ expectedVersion: 1, name: 'A' })).statusCode).toBe(200);
    const stale = await t.patch({ expectedVersion: 1, name: 'B' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details.reason).toBe('version_conflict');
    expect((await t.get()).name).toBe('A');
  });

  it('rejects incoherent windows and unsafe links with field errors', async () => {
    const t = await setup();
    const ev = await t.get();
    const late = new Date(Date.parse(ev.endsAt) + 86_400_000).toISOString();
    const res = await t.patch({
      expectedVersion: 1,
      settings: { registration: { closesAt: late } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.fields[0].path).toBe('body.settings.registration.closesAt');
    const bad = await t.patch({
      expectedVersion: 1,
      settings: { legal: { privacyPolicyUrl: 'javascript:alert(1)' } },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('requires event.update and hides other tenants', async () => {
    const t = await setup(['content_editor', 'viewer']);
    for (const role of ['content_editor', 'viewer']) {
      expect(
        (await t.patch({ expectedVersion: 1, name: 'x' }, t.members[role])).statusCode,
        role,
      ).toBe(403);
    }
    const outsider = (await setup()).owner;
    expect((await t.patch({ expectedVersion: 1, name: 'x' }, outsider)).statusCode).toBe(404);
  });
});

describe('setup checklist and scheduling (EVT-03)', () => {
  it('blocks scheduling until required items are done, then requires acknowledging skipped recommendations', async () => {
    const t = await setup();
    const initial = await t.checklist();
    expect(initial.canSchedule).toBe(false);
    expect(initial.availableTransitions.sort()).toEqual(['archived', 'scheduled']);

    const blocked = await t.transition({ to: 'scheduled', expectedVersion: 1 });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.details.reason).toBe('checklist_blocking');
    expect(blocked.json().error.details.fields.map((f: { path: string }) => f.path)).toEqual([
      'checklist.sharing.metadata',
      'checklist.legal.privacy_policy',
    ]);

    await t.patch({ expectedVersion: 1, settings: READY_SETTINGS });
    const warn = await t.transition({ to: 'scheduled', expectedVersion: 2 });
    expect(warn.json().error.details.reason).toBe('warnings_unacknowledged');

    const ok = await t.transition({
      to: 'scheduled',
      expectedVersion: 2,
      acknowledgedWarnings: ['contact.details', 'registration.window', 'legal.terms'],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ lifecycle: 'scheduled', version: 3 });
    const { rows } = await pools.migrator.query(
      `SELECT metadata FROM eventhub.audit_event WHERE target_id = $1 AND action = 'event.lifecycle_changed'`,
      [t.eventId],
    );
    expect(rows[0].metadata).toEqual({
      from: 'draft',
      to: 'scheduled',
      acknowledgedWarnings: ['contact.details', 'registration.window', 'legal.terms'],
    });
  });

  it('a scheduled event keeps its required items and its slug', async () => {
    const t = await setup();
    await t.patch({ expectedVersion: 1, settings: READY_SETTINGS });
    await t.transition({
      to: 'scheduled',
      expectedVersion: 2,
      acknowledgedWarnings: ['contact.details', 'registration.window', 'legal.terms'],
    });
    const regress = await t.patch({ expectedVersion: 3, settings: { legal: null } });
    expect(regress.json().error.details.reason).toBe('checklist_regression');
    const slug = await t.patch({ expectedVersion: 3, slug: `new-${randomUUID().slice(0, 8)}` });
    expect(slug.json().error.details.reason).toBe('slug_locked');
    expect((await t.transition({ to: 'draft', expectedVersion: 3 })).json().lifecycle).toBe(
      'draft',
    );
  });

  it('refuses publishing without a published page, and unnamed transitions', async () => {
    const t = await setup();
    expect(
      (await t.transition({ to: 'ended', expectedVersion: 1 })).json().error.details.reason,
    ).toBe('invalid_transition');
    await t.patch({ expectedVersion: 1, settings: READY_SETTINGS });
    await t.transition({
      to: 'scheduled',
      expectedVersion: 2,
      acknowledgedWarnings: ['contact.details', 'registration.window', 'legal.terms'],
    });
    const publish = await t.transition({ to: 'published', expectedVersion: 3 });
    expect(publish.statusCode).toBe(409);
    expect(publish.json().error.details.reason).toBe('page_not_published');
  });

  it('gates each transition by its own permission', async () => {
    const t = await setup(['content_editor', 'analyst', 'event_manager']);
    expect(
      (await t.transition({ to: 'scheduled', expectedVersion: 1 }, t.members.content_editor)).json()
        .error.details.reason,
    ).toBe('missing_permission:event.publish');
    expect(
      (await t.transition({ to: 'archived', expectedVersion: 1 }, t.members.analyst)).json().error
        .details.reason,
    ).toBe('missing_permission:event.archive');
    expect((await t.checklist(t.members.analyst)).availableTransitions).toEqual([]);
    expect(
      (await t.transition({ to: 'archived', expectedVersion: 1 }, t.members.event_manager))
        .statusCode,
    ).toBe(200);
  });

  it('concurrent transitions on the same version: one wins, the other gets a version conflict', async () => {
    const t = await setup();
    const [a, b] = await Promise.all([
      t.transition({ to: 'archived', expectedVersion: 1 }),
      t.transition({ to: 'archived', expectedVersion: 1 }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it('replays a retried transition instead of applying it twice', async () => {
    const t = await setup();
    const headers = idem();
    const first = await t.transition({ to: 'archived', expectedVersion: 1 }, t.owner, headers);
    const again = await t.transition({ to: 'archived', expectedVersion: 1 }, t.owner, headers);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
  });
});

describe('archive and restore (EVT-05)', () => {
  it('archived events are read-only and restore exactly to where they came from', async () => {
    const t = await setup();
    const archived = (await t.transition({ to: 'archived', expectedVersion: 1 })).json();
    expect(archived).toMatchObject({ lifecycle: 'archived', archivedFrom: 'draft' });
    expect((await t.patch({ expectedVersion: 2, name: 'x' })).json().error.details.reason).toBe(
      'event_archived',
    );
    expect(
      (await t.transition({ to: 'ended', expectedVersion: 2 })).json().error.details.reason,
    ).toBe('restore_target_mismatch');
    const restored = (await t.transition({ to: 'draft', expectedVersion: 2 })).json();
    expect(restored).toMatchObject({ lifecycle: 'draft', archivedFrom: null });
  });

  it('a scheduled event restores to draft so its checklist runs again', async () => {
    const t = await setup();
    await t.patch({ expectedVersion: 1, settings: READY_SETTINGS });
    await t.transition({
      to: 'scheduled',
      expectedVersion: 2,
      acknowledgedWarnings: ['contact.details', 'registration.window', 'legal.terms'],
    });
    expect((await t.transition({ to: 'archived', expectedVersion: 3 })).json().archivedFrom).toBe(
      'scheduled',
    );
    expect((await t.transition({ to: 'draft', expectedVersion: 4 })).json().lifecycle).toBe(
      'draft',
    );
  });

  it('lists events filtered by lifecycle', async () => {
    const t = await setup();
    await t.transition({ to: 'archived', expectedVersion: 1 });
    const list = async (lifecycle: string) =>
      (
        await app.inject({
          method: 'GET',
          url: `/v1/organizations/${t.orgId}/events?lifecycle=${lifecycle}`,
          headers: auth(t.owner),
        })
      ).json().data;
    expect((await list('archived')).map((e: { id: string }) => e.id)).toEqual([t.eventId]);
    expect(await list('draft')).toEqual([]);
  });

  it('the database enforces archived_from consistency even for the schema owner', async () => {
    const t = await setup();
    await expect(
      pools.migrator.query(`UPDATE eventhub.event SET lifecycle = 'archived' WHERE id = $1`, [
        t.eventId,
      ]),
    ).rejects.toMatchObject({
      code: '23514',
    });
  });
});
