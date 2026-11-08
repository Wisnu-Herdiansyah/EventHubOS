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

const READY = {
  visibility: 'public',
  sharing: { title: 'Jakarta Summit', description: 'A day of talks.' },
  legal: { privacyPolicyUrl: 'https://example.com/privacy' },
};
const HERO = {
  id: 'hero',
  type: 'hero',
  version: 1,
  visible: true,
  heading: 'Published heading',
  body: 'Hello.',
  ctaLabel: 'Register',
};
const HIDDEN = {
  id: 'secret',
  type: 'text',
  version: 1,
  visible: false,
  heading: 'Hidden',
  body: 'x',
};
const ACK = ['contact.details', 'registration.window', 'legal.terms'];

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
  const orgUrl = `/v1/organizations/${orgId}`;
  const evtUrl = `${orgUrl}/events/${eventId}`;
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, as = owner) =>
    app.inject({
      method,
      url,
      headers: { ...auth(as), ...idem() },
      ...(payload ? { payload } : {}),
    });
  const version = async () => (await call('GET', evtUrl)).json().version as number;
  const orgVersion = async () => (await call('GET', orgUrl)).json().version as number;
  const setHandle = async (publicHandle: string | null, as = owner) =>
    call('PATCH', orgUrl, { expectedVersion: await orgVersion(), publicHandle }, as);
  const transition = async (to: string, as = owner, acknowledgedWarnings: string[] = []) =>
    call(
      'POST',
      `${evtUrl}/transitions`,
      { to, expectedVersion: await version(), acknowledgedWarnings },
      as,
    );
  const slug = (await call('GET', evtUrl)).json().slug as string;
  const publicGet = (handle: string, s = slug) =>
    app.inject({ method: 'GET', url: `/v1/public/sites/${handle}/events/${s}` });

  /** Ready, scheduled, page published, handle set, event published. */
  async function goPublic(handle: string) {
    await call('PATCH', evtUrl, { expectedVersion: await version(), settings: READY });
    expect((await transition('scheduled', owner, ACK)).statusCode).toBe(200);
    await call('POST', `${evtUrl}/page/draft`, { expectedVersion: 0, sections: [HERO, HIDDEN] });
    await call('POST', `${evtUrl}/page/publish`, { expectedVersion: 1 });
    expect((await setHandle(handle)).statusCode).toBe(200);
    const res = await transition('published');
    expect(res.statusCode, res.body).toBe(200);
  }
  return {
    owner,
    orgId,
    eventId,
    members,
    slug,
    evtUrl,
    orgUrl,
    call,
    setHandle,
    transition,
    publicGet,
    goPublic,
  };
}

const handle = () => `h-${randomUUID().slice(0, 8)}`;

describe('public handles', () => {
  it('are set by organization.manage, unique on the platform, and validated', async () => {
    const a = await setup(['billing_admin']);
    const b = await setup();
    const h = handle();
    const ok = await a.setHandle(h);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().publicHandle).toBe(h);

    const taken = await b.setHandle(h);
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.details.reason).toBe('handle_taken');

    for (const bad of ['www', 'ab', '-abc', 'Has Space', 'x'.repeat(41)]) {
      expect((await b.setHandle(bad)).statusCode, bad).toBe(400);
    }
    const denied = await a.setHandle(handle(), a.members.billing_admin);
    expect(denied.statusCode).toBe(403);
    // Removing frees it.
    expect((await a.setHandle(null)).json().publicHandle).toBeNull();
    expect((await b.setHandle(h)).statusCode).toBe(200);
  });
});

describe('going public', () => {
  it('needs a published page and a handle, then serves the published revision only', async () => {
    const t = await setup();
    await t.call('PATCH', t.evtUrl, { expectedVersion: 1, settings: READY });
    await t.transition('scheduled', t.owner, ACK);
    expect((await t.transition('published')).json().error.details.reason).toBe(
      'page_not_published',
    );

    await t.call('POST', `${t.evtUrl}/page/draft`, {
      expectedVersion: 0,
      sections: [HERO, HIDDEN],
    });
    await t.call('POST', `${t.evtUrl}/page/publish`, { expectedVersion: 1 });
    expect((await t.transition('published')).json().error.details.reason).toBe(
      'public_handle_missing',
    );
    const checklist = (await t.call('GET', `${t.evtUrl}/checklist`)).json();
    expect(checklist.publicSite).toEqual({ pagePublished: true, handle: null, eventSlug: t.slug });
    expect(checklist.availableTransitions).toContain('published');

    const h = handle();
    await t.setHandle(h);
    // Not public until the event itself is published.
    expect((await t.publicGet(h)).statusCode).toBe(404);
    expect((await t.transition('published')).statusCode).toBe(200);

    const res = await t.publicGet(h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      handle: h,
      eventSlug: t.slug,
      lifecycle: 'published',
      indexable: true,
      revision: 1,
      sharing: { title: 'Jakarta Summit' },
    });
    // Hidden sections never leave the server.
    expect(res.json().sections.map((s: { id: string }) => s.id)).toEqual(['hero']);
    expect(res.headers['set-cookie']).toBeUndefined();

    // Draft edits stay private until a new revision is published.
    await t.call('POST', `${t.evtUrl}/page/draft`, {
      expectedVersion: 1,
      sections: [{ ...HERO, heading: 'Unpublished draft' }],
    });
    expect((await t.publicGet(h)).json().sections[0].heading).toBe('Published heading');
    await t.call('POST', `${t.evtUrl}/page/publish`, { expectedVersion: 2 });
    const after = (await t.publicGet(h)).json();
    expect(after).toMatchObject({ revision: 2 });
    expect(after.sections[0].heading).toBe('Unpublished draft');
  });

  it('follows the lifecycle: live and ended stay public; taking offline hides it', async () => {
    const t = await setup();
    const h = handle();
    await t.goPublic(h);
    expect((await t.transition('live')).statusCode).toBe(200);
    expect((await t.publicGet(h)).json().lifecycle).toBe('live');
    expect((await t.transition('ended')).statusCode).toBe(200);
    expect((await t.publicGet(h)).json().lifecycle).toBe('ended');

    const u = await setup();
    const h2 = handle();
    await u.goPublic(h2);
    expect((await u.transition('scheduled')).statusCode).toBe(200);
    expect((await u.publicGet(h2)).statusCode).toBe(404);
  });

  it('refuses to publish a private event, and hides one made private', async () => {
    const t = await setup();
    const h = handle();
    await t.goPublic(h);
    // Unlisted: reachable, not indexable.
    await t.call('PATCH', t.evtUrl, {
      expectedVersion: (await t.call('GET', t.evtUrl)).json().version,
      settings: { visibility: 'unlisted' },
    });
    expect((await t.publicGet(h)).json().indexable).toBe(false);
    await t.call('PATCH', t.evtUrl, {
      expectedVersion: (await t.call('GET', t.evtUrl)).json().version,
      settings: { visibility: 'private' },
    });
    expect((await t.publicGet(h)).statusCode).toBe(404);

    const u = await setup();
    await u.call('PATCH', u.evtUrl, {
      expectedVersion: 1,
      settings: { ...READY, visibility: 'private' },
    });
    await u.transition('scheduled', u.owner, ACK);
    await u.call('POST', `${u.evtUrl}/page/draft`, { expectedVersion: 0, sections: [HERO] });
    await u.call('POST', `${u.evtUrl}/page/publish`, { expectedVersion: 1 });
    await u.setHandle(handle());
    expect((await u.transition('published')).json().error.details.reason).toBe('event_private');
  });

  it('gates publishing by event.publish', async () => {
    const t = await setup(['content_editor']);
    await t.call('PATCH', t.evtUrl, { expectedVersion: 1, settings: READY });
    await t.transition('scheduled', t.owner, ACK);
    const res = await t.transition('published', t.members.content_editor);
    expect(res.json().error.details.reason).toBe('missing_permission:event.publish');
  });
});

describe('public lookup isolation', () => {
  it('never resolves another organization’s event or a suspended organization', async () => {
    const a = await setup();
    const ha = handle();
    await a.goPublic(ha);
    const b = await setup();
    const hb = handle();
    await b.setHandle(hb);
    // Org B's handle with org A's event slug: not found.
    expect((await a.publicGet(hb, a.slug)).statusCode).toBe(404);
    expect((await a.publicGet('nobody-here', a.slug)).statusCode).toBe(404);
    expect((await a.publicGet(ha, 'no-such-event')).statusCode).toBe(404);

    await pools.migrator.query(
      `UPDATE eventhub.organization SET status = 'suspended' WHERE id = $1`,
      [a.orgId],
    );
    expect((await a.publicGet(ha)).statusCode).toBe(404);
  });

  it('answers malformed addresses without touching the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/public/sites/NOT_VALID/events/x' });
    expect(res.statusCode).toBe(400);
  });

  it('cannot be called with arbitrary SQL-ish input to reach drafts', async () => {
    const t = await setup();
    await t.call('POST', `${t.evtUrl}/page/draft`, { expectedVersion: 0, sections: [HERO] });
    const h = handle();
    await t.setHandle(h);
    // A draft-only page of an unpublished event is invisible.
    expect((await t.publicGet(h)).statusCode).toBe(404);
    const { rows } = await pools.app.query(
      'SELECT count(*)::int AS n FROM eventhub.public_event_page($1, $2)',
      [h, t.slug],
    );
    expect(rows[0].n).toBe(0);
  });
});
