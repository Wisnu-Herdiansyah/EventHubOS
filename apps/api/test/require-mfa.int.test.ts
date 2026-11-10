import { randomBytes, randomUUID } from 'node:crypto';
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

/** Requiring two-step verification for Owners and Admins (ADR-0024), on the real schema. */
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

/** Gives a fixture user two-step verification (the sealed secret is never opened here). */
async function withMfa(user: FixtureUser, status: 'active' | 'pending' = 'active') {
  await pools.migrator.query(
    `INSERT INTO eventhub.auth_mfa_factor (user_id, secret_sealed, status, activated_at)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'active' THEN now() END)`,
    [user.id, randomBytes(48), status],
  );
  return user;
}

async function setup() {
  const owner = await withMfa(await createFixtureUser(pools.migrator));
  const orgId = await createFixtureOrganization(pools.migrator, owner.id);
  const member = async (role: string) => {
    const u = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgId, u.id, role);
    return u;
  };
  const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
  const orgUrl = `/v1/organizations/${orgId}`;
  const get = (url: string, as: FixtureUser) =>
    app.inject({ method: 'GET', url: orgUrl + url, headers: auth(as) });
  const patchOrg = async (payload: object, as: FixtureUser = owner) => {
    const { version } = (await get('', as)).json();
    return app.inject({
      method: 'PATCH',
      url: orgUrl,
      headers: { ...auth(as), ...idem() },
      payload: { expectedVersion: version, ...payload },
    });
  };
  return { owner, orgId, eventId, orgUrl, member, get, patchOrg };
}

describe('require two-step verification for Owners and Admins', () => {
  it('is off by default and reported on the organization', async () => {
    const t = await setup();
    const org = (await t.get('', t.owner)).json();
    expect(org).toMatchObject({ requireMfaForAdmins: false, mfaSetupRequired: false });
  });

  it('cannot be turned on by someone who does not use two-step verification', async () => {
    const t = await setup();
    const admin = await t.member('admin');
    const res = await t.patchOrg({ requireMfaForAdmins: true }, admin);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.reason).toBe('actor_mfa_required');
    expect((await t.get('', t.owner)).json().requireMfaForAdmins).toBe(false);

    // A factor that was started but never confirmed does not count.
    await withMfa(admin, 'pending');
    const pending = await t.patchOrg({ requireMfaForAdmins: true }, admin);
    expect(pending.statusCode).toBe(409);
  });

  it('needs organization.manage', async () => {
    const t = await setup();
    const manager = await withMfa(await t.member('event_manager'));
    const res = await t.patchOrg({ requireMfaForAdmins: true }, manager);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.reason).toBe('missing_permission:organization.manage');
  });

  it('blocks Owners and Admins without it from everything but the organization profile', async () => {
    const t = await setup();
    const admin = await t.member('admin');
    const owner2 = await t.member('owner');
    const manager = await t.member('event_manager');
    const viewer = await t.member('viewer');

    // Before: the admin works normally.
    expect((await t.get('/events', admin)).statusCode).toBe(200);

    const on = await t.patchOrg({ requireMfaForAdmins: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ requireMfaForAdmins: true, mfaSetupRequired: false });

    for (const blocked of [admin, owner2]) {
      for (const path of ['/events', `/events/${t.eventId}`, '/members', '/audit-events']) {
        const res = await t.get(path, blocked);
        expect(res.statusCode, path).toBe(403);
        expect(res.json().error.details.reason).toBe('mfa_required');
      }
      const org = await t.get('', blocked);
      expect(org.statusCode).toBe(200);
      expect(org.json()).toMatchObject({ requireMfaForAdmins: true, mfaSetupRequired: true });
      // The profile read does not open writes.
      const write = await t.patchOrg({ displayName: 'Taken over' }, blocked);
      expect(write.statusCode).toBe(403);
      expect(write.json().error.details.reason).toBe('mfa_required');
    }
    const create = await app.inject({
      method: 'POST',
      url: `${t.orgUrl}/events`,
      headers: { ...auth(admin), ...idem() },
      payload: {
        name: 'Blocked',
        slug: 'blocked',
        timezone: 'UTC',
        startsAt: '2030-01-01T09:00:00Z',
        endsAt: '2030-01-01T17:00:00Z',
        venueMode: 'virtual',
        primaryLanguage: 'en',
      },
    });
    expect(create.statusCode, create.body).toBe(403);
    expect(create.json().error.details.reason).toBe('mfa_required');

    // Other roles are unaffected.
    expect((await t.get('/events', manager)).statusCode).toBe(200);
    expect((await t.get('/events', viewer)).statusCode).toBe(200);
    expect((await t.get('', manager)).json().mfaSetupRequired).toBe(false);
    // The Owner who turned it on keeps working.
    expect((await t.get('/members', t.owner)).statusCode).toBe(200);

    // Setting it up lifts the block on the next request.
    await withMfa(admin);
    expect((await t.get('/events', admin)).statusCode).toBe(200);
    expect((await t.get('', admin)).json().mfaSetupRequired).toBe(false);
    expect((await t.get('/events', owner2)).statusCode).toBe(403);

    // Turning it off restores access for everyone.
    const off = await t.patchOrg({ requireMfaForAdmins: false });
    expect(off.statusCode).toBe(200);
    expect((await t.get('/events', owner2)).statusCode).toBe(200);
  });

  it('is audited with the new value', async () => {
    const t = await setup();
    await t.patchOrg({ requireMfaForAdmins: true });
    await t.patchOrg({ requireMfaForAdmins: false });
    const { rows } = await pools.migrator.query(
      `SELECT actor_id, metadata FROM eventhub.audit_event
        WHERE organization_id = $1 AND action = 'organization.updated' ORDER BY occurred_at`,
      [t.orgId],
    );
    expect(rows.map((r) => r.metadata)).toEqual([
      { fields: ['requireMfaForAdmins'], requireMfaForAdmins: true },
      { fields: ['requireMfaForAdmins'], requireMfaForAdmins: false },
    ]);
    expect(rows[0].actor_id).toBe(t.owner.id);
  });

  it('applies only to the organization that turned it on', async () => {
    const a = await setup();
    const b = await setup();
    const admin = await a.member('admin');
    await addFixtureMembership(pools.migrator, b.orgId, admin.id, 'admin');
    await a.patchOrg({ requireMfaForAdmins: true });
    expect((await a.get('/events', admin)).statusCode).toBe(403);
    expect((await b.get('/events', admin)).statusCode).toBe(200);
    expect((await b.get('', admin)).json()).toMatchObject({
      requireMfaForAdmins: false,
      mfaSetupRequired: false,
    });
    // A non-member still gets 404, not a hint about the requirement.
    const outsider = await createFixtureUser(pools.migrator);
    expect((await a.get('', outsider)).statusCode).toBe(404);
    expect((await a.get('/events', outsider)).statusCode).toBe(404);
  });

  it('cannot be set by an Owner of another organization', async () => {
    const a = await setup();
    const b = await setup();
    const res = await app.inject({
      method: 'PATCH',
      url: a.orgUrl,
      headers: { ...auth(b.owner), ...idem() },
      payload: { expectedVersion: 1, requireMfaForAdmins: true },
    });
    expect(res.statusCode).toBe(404);
    expect((await a.get('', a.owner)).json().requireMfaForAdmins).toBe(false);
  });
});

describe('who uses two-step verification (ADR-0025)', () => {
  const members = async (url: string, as: FixtureUser) =>
    app.inject({ method: 'GET', url: url + '/members', headers: auth(as) });

  it('shows Owners and Admins one boolean per member', async () => {
    const t = await setup();
    const admin = await t.member('admin');
    const manager = await withMfa(await t.member('event_manager'));
    const pending = await t.member('viewer');
    await withMfa(pending, 'pending');

    for (const as of [t.owner, admin]) {
      const res = await members(t.orgUrl, as);
      expect(res.statusCode).toBe(200);
      const byUser = new Map(
        res
          .json()
          .data.map((m: { userId: string; twoStepEnabled: boolean }) => [
            m.userId,
            m.twoStepEnabled,
          ]),
      );
      expect(byUser.get(t.owner.id)).toBe(true);
      expect(byUser.get(admin.id)).toBe(false);
      expect(byUser.get(manager.id)).toBe(true);
      // An unconfirmed setup is not "on".
      expect(byUser.get(pending.id)).toBe(false);
    }
    // Only the boolean: no dates, secrets or code counts.
    const owner = (await members(t.orgUrl, t.owner))
      .json()
      .data.find((m: { userId: string }) => m.userId === t.owner.id);
    expect(Object.keys(owner).sort()).toEqual(
      ['email', 'joinedAt', 'membershipId', 'role', 'status', 'twoStepEnabled', 'userId'].sort(),
    );
  });

  it('is not readable by other roles, other tenants, or outside tenant context', async () => {
    const t = await setup();
    const manager = await t.member('event_manager');
    expect((await members(t.orgUrl, manager)).statusCode).toBe(403);
    const other = await setup();
    expect((await members(t.orgUrl, other.owner)).statusCode).toBe(404);

    // The function itself returns nothing unless the tenant context matches the argument.
    const client = await pools.app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [other.orgId]);
      const leaked = await client.query('SELECT * FROM eventhub.organization_member_mfa($1)', [
        t.orgId,
      ]);
      expect(leaked.rowCount).toBe(0);
      const own = await client.query('SELECT * FROM eventhub.organization_member_mfa($1)', [
        other.orgId,
      ]);
      expect(own.rows).toEqual([{ out_user_id: other.owner.id, out_mfa_enabled: true }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
