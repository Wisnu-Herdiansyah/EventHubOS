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
import { buildApp } from '../src/app.ts';
import { DatabaseSessionAuthenticator } from '../src/modules/identity/authenticator.ts';

const pools = createTestPools();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    pool: pools.app,
    authenticator: new DatabaseSessionAuthenticator(pools.app),
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
const idem = () => ({ 'idempotency-key': `test-${randomUUID()}` });
const eventBody = (slug = `launch-${randomUUID().slice(0, 8)}`) => ({
  name: 'Product Launch 2027',
  slug,
  timezone: 'Asia/Jakarta',
  startsAt: '2027-03-01T09:00:00+07:00',
  endsAt: '2027-03-01T17:00:00+07:00',
  venueMode: 'hybrid',
  primaryLanguage: 'id-ID',
});

describe('HTTP foundation', () => {
  it('returns consistent errors with a correlation ID for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toMatchObject({ code: 'not_found', retryable: false });
    expect(body.error.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('propagates a well-formed client correlation ID and replaces malformed ones', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': 'trace-abc-12345' },
    });
    expect(ok.headers['x-correlation-id']).toBe('trace-abc-12345');
    const bad = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': '<script>' },
    });
    expect(bad.headers['x-correlation-id']).not.toBe('<script>');
  });

  it('sets no-store and hardening headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('reports readiness from the database', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
  });

  it('rejects missing, malformed, unknown, and expired sessions with 401', async () => {
    const expired = await createFixtureUser(pools.migrator, { sessionExpired: true });
    for (const headers of [
      {},
      { authorization: 'Bearer x' },
      { authorization: `Bearer ${'z'.repeat(43)}` },
      auth(expired),
    ]) {
      const res = await app.inject({ method: 'GET', url: '/v1/me/organizations', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthenticated');
    }
  });

  it('rejects malformed JSON and oversized bodies with typed errors', async () => {
    const u = await createFixtureUser(pools.migrator);
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { ...auth(u), ...idem(), 'content-type': 'application/json' },
      payload: '{"x":',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_failed');
    const big = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { ...auth(u), ...idem(), 'content-type': 'application/json' },
      payload: JSON.stringify({ displayName: 'x'.repeat(70_000) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('payload_too_large');
  });
});

describe('organization creation (ORG-01)', () => {
  const body = { displayName: 'Acme Events', locale: 'en-US', timezone: 'America/New_York' };

  it('requires an Idempotency-Key', async () => {
    const u = await createFixtureUser(pools.migrator);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: auth(u),
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('requires a verified email', async () => {
    const u = await createFixtureUser(pools.migrator, { verified: false });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { ...auth(u), ...idem() },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('email_not_verified');
  });

  it('validates input with field-level details', async () => {
    const u = await createFixtureUser(pools.migrator);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { ...auth(u), ...idem() },
      payload: { displayName: '', locale: '??', timezone: 'Mars/Base', extra: 1 },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.fields.map((f: { path: string }) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(['body.displayName', 'body.locale', 'body.timezone']),
    );
  });

  it('creates the org with the caller as Owner, plus audit and outbox records atomically', async () => {
    const u = await createFixtureUser(pools.migrator);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { ...auth(u), ...idem(), 'x-correlation-id': `corr-${randomUUID()}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const org = res.json();
    expect(org).toMatchObject({
      displayName: 'Acme Events',
      role: 'owner',
      status: 'active',
      locale: 'en-US',
    });
    const corr = res.headers['x-correlation-id'];
    const { rows } = await pools.migrator.query(
      `SELECT (SELECT role FROM eventhub.membership WHERE organization_id = $1 AND user_id = $2) AS role,
              (SELECT count(*)::int FROM eventhub.audit_event WHERE organization_id = $1 AND action = 'organization.created' AND correlation_id = $3) AS audits,
              (SELECT count(*)::int FROM eventhub.outbox_event WHERE organization_id = $1 AND event_type = 'organization.created' AND correlation_id = $3) AS events`,
      [org.id, u.id, corr],
    );
    expect(rows[0]).toEqual({ role: 'owner', audits: 1, events: 1 });
  });

  it('replays the original result for a retried key and creates nothing new', async () => {
    const u = await createFixtureUser(pools.migrator);
    const headers = { ...auth(u), ...idem() };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers,
      payload: body,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers,
      payload: { ...body },
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    const { rows } = await pools.migrator.query(
      'SELECT count(*)::int AS n FROM eventhub.membership WHERE user_id = $1',
      [u.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('rejects a reused key with a different payload (422)', async () => {
    const u = await createFixtureUser(pools.migrator);
    const headers = { ...auth(u), ...idem() };
    await app.inject({ method: 'POST', url: '/v1/organizations', headers, payload: body });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers,
      payload: { ...body, displayName: 'Other' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('idempotency_key_reused');
  });

  it('lists only the caller’s organizations (ORG-03)', async () => {
    const u = await createFixtureUser(pools.migrator);
    const other = await createFixtureUser(pools.migrator);
    const mine = await createFixtureOrganization(pools.migrator, u.id, 'Mine');
    await createFixtureOrganization(pools.migrator, other.id, 'Theirs');
    const res = await app.inject({ method: 'GET', url: '/v1/me/organizations', headers: auth(u) });
    expect(res.json()).toEqual({
      data: [{ organizationId: mine, displayName: 'Mine', role: 'owner' }],
    });
  });
});

describe('events (EVT-01)', () => {
  let owner: FixtureUser;
  let orgId: string;
  beforeAll(async () => {
    owner = await createFixtureUser(pools.migrator);
    orgId = await createFixtureOrganization(pools.migrator, owner.id);
  });

  it('creates a draft event with audit + outbox, then reads and lists it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/events`,
      headers: { ...auth(owner), ...idem() },
      payload: eventBody('launch-day'),
    });
    expect(res.statusCode).toBe(201);
    const evt = res.json();
    expect(evt).toMatchObject({
      organizationId: orgId,
      slug: 'launch-day',
      lifecycle: 'draft',
      startsAt: '2027-03-01T02:00:00.000Z',
      primaryLanguage: 'id-ID',
      version: 1,
    });

    const got = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/events/${evt.id}`,
      headers: auth(owner),
    });
    expect(got.json()).toEqual(evt);

    const { rows } = await pools.migrator.query(
      `SELECT (SELECT count(*)::int FROM eventhub.audit_event WHERE target_id = $1 AND action = 'event.created') AS a,
              (SELECT count(*)::int FROM eventhub.outbox_event WHERE aggregate_id = $1 AND event_type = 'event.created') AS o`,
      [evt.id],
    );
    expect(rows[0]).toEqual({ a: 1, o: 1 });
  });

  it('rejects duplicate slugs within the organization (409)', async () => {
    const payload = eventBody('dup-slug');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/organizations/${orgId}/events`,
          headers: { ...auth(owner), ...idem() },
          payload,
        })
      ).statusCode,
    ).toBe(201);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/events`,
      headers: { ...auth(owner), ...idem() },
      payload,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.reason).toBe('event_slug_taken');
  });

  it('allows the same slug in a different organization', async () => {
    const other = await createFixtureUser(pools.migrator);
    const otherOrg = await createFixtureOrganization(pools.migrator, other.id);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${otherOrg}/events`,
      headers: { ...auth(other), ...idem() },
      payload: eventBody('dup-slug'),
    });
    expect(res.statusCode).toBe(201);
  });

  it('validates incoherent schedules, reserved slugs, and unknown fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/events`,
      headers: { ...auth(owner), ...idem() },
      payload: {
        ...eventBody('admin'),
        endsAt: '2027-02-01T00:00:00Z',
        organizationId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.fields.map((f: { path: string }) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['body.slug', 'body']));
  });

  it('paginates with a stable cursor', async () => {
    const u = await createFixtureUser(pools.migrator);
    const o = await createFixtureOrganization(pools.migrator, u.id);
    for (let i = 0; i < 5; i++) await createFixtureEvent(pools.migrator, o, u.id, `page-${i}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/organizations/${o}/events?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await app.inject({ method: 'GET', url, headers: auth(u) });
      expect(res.statusCode).toBe(200);
      const page = res.json();
      seen.push(...page.data.map((e: { slug: string }) => e.slug));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(['page-0', 'page-1', 'page-2', 'page-3', 'page-4']);
  });

  it('rejects a malformed cursor and out-of-range limit', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/events?limit=1000&cursor=%%%`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('cross-organization access (tenant isolation through the API)', () => {
  let alice: FixtureUser;
  let bob: FixtureUser;
  let orgA: string;
  let orgB: string;
  let eventB: string;

  beforeAll(async () => {
    alice = await createFixtureUser(pools.migrator);
    bob = await createFixtureUser(pools.migrator);
    orgA = await createFixtureOrganization(pools.migrator, alice.id);
    orgB = await createFixtureOrganization(pools.migrator, bob.id);
    eventB = await createFixtureEvent(pools.migrator, orgB, bob.id, 'bob-secret-event');
  });

  it('cannot read another organization (404, indistinguishable from non-existent)', async () => {
    const theirs = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgB}`,
      headers: auth(alice),
    });
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${randomUUID()}`,
      headers: auth(alice),
    });
    expect(theirs.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(theirs.json().error.message).toBe(missing.json().error.message);
  });

  it('cannot list, read, or create events in another organization', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgB}/events`,
      headers: auth(alice),
    });
    expect(list.statusCode).toBe(404);
    const get = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgB}/events/${eventB}`,
      headers: auth(alice),
    });
    expect(get.statusCode).toBe(404);
    const create = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgB}/events`,
      headers: { ...auth(alice), ...idem() },
      payload: eventBody('intrusion'),
    });
    expect(create.statusCode).toBe(404);
    const { rows } = await pools.migrator.query(
      `SELECT count(*)::int AS n FROM eventhub.event WHERE organization_id = $1`,
      [orgB],
    );
    expect(rows[0].n).toBe(1);
  });

  it('cannot reach another tenant’s event through their own organization path (object-level check)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/events/${eventB}`,
      headers: auth(alice),
    });
    expect(res.statusCode).toBe(404);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgA}/events`,
      headers: auth(alice),
    });
    expect(list.json().data.map((e: { id: string }) => e.id)).not.toContain(eventB);
  });

  it('ignores a browser-supplied organization ID in the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgA}/events`,
      headers: { ...auth(alice), ...idem() },
      payload: { ...eventBody(), organizationId: orgB },
    });
    expect(res.statusCode).toBe(400); // strict schema: unknown fields are rejected outright
  });

  it('loses access immediately when membership is suspended', async () => {
    const carol = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgA, carol.id, 'viewer');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/organizations/${orgA}/events`,
          headers: auth(carol),
        })
      ).statusCode,
    ).toBe(200);
    await pools.migrator.query(
      `UPDATE eventhub.membership SET status = 'suspended' WHERE organization_id = $1 AND user_id = $2`,
      [orgA, carol.id],
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/organizations/${orgA}/events`,
          headers: auth(carol),
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('role permissions through the API (deny by default)', () => {
  let owner: FixtureUser;
  let orgId: string;
  beforeAll(async () => {
    owner = await createFixtureUser(pools.migrator);
    orgId = await createFixtureOrganization(pools.migrator, owner.id);
  });

  const cases: Array<[string, { read: number; create: number }]> = [
    ['admin', { read: 200, create: 201 }],
    ['event_manager', { read: 200, create: 201 }],
    ['content_editor', { read: 200, create: 403 }],
    ['registration_manager', { read: 200, create: 403 }],
    ['analyst', { read: 200, create: 403 }],
    ['viewer', { read: 200, create: 403 }],
    ['billing_admin', { read: 403, create: 403 }],
  ];

  it.each(cases)('%s', async (role, expected) => {
    const u = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgId, u.id, role);
    const read = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/events`,
      headers: auth(u),
    });
    expect(read.statusCode).toBe(expected.read);
    const create = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/events`,
      headers: { ...auth(u), ...idem() },
      payload: eventBody(),
    });
    expect(create.statusCode).toBe(expected.create);
    if (expected.create === 403)
      expect(create.json().error).toMatchObject({
        code: 'forbidden',
        details: { reason: 'missing_permission:event.create' },
      });
  });
});
