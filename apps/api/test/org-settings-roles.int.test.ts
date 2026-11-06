import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addFixtureMembership,
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

async function setup(roles: string[] = []) {
  const owner = await createFixtureUser(pools.migrator);
  const orgId = await createFixtureOrganization(pools.migrator, owner.id);
  const members: Record<string, FixtureUser> = {};
  for (const role of roles) {
    const u = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgId, u.id, role);
    members[role] = u;
  }
  const orgUrl = `/v1/organizations/${orgId}`;
  const getOrg = async (as: FixtureUser = owner) =>
    (await app.inject({ method: 'GET', url: orgUrl, headers: auth(as) })).json();
  const patchOrg = (payload: object, as: FixtureUser = owner) =>
    app.inject({ method: 'PATCH', url: orgUrl, headers: { ...auth(as), ...idem() }, payload });
  const membershipOf = async (user: FixtureUser) => {
    const list = (
      await app.inject({ method: 'GET', url: `${orgUrl}/members`, headers: auth(owner) })
    ).json().data;
    return list.find((m: { userId: string }) => m.userId === user.id).membershipId as string;
  };
  const changeRole = async (target: FixtureUser, role: string, as: FixtureUser = owner) =>
    app.inject({
      method: 'POST',
      url: `${orgUrl}/members/${await membershipOf(target)}/role`,
      headers: { ...auth(as), ...idem() },
      payload: { role },
    });
  const invite = (as: FixtureUser, email: string, role: string) =>
    app.inject({
      method: 'POST',
      url: `${orgUrl}/invitations`,
      headers: { ...auth(as), ...idem() },
      payload: { email, role },
    });
  return { owner, orgId, members, orgUrl, getOrg, patchOrg, changeRole, invite, membershipOf };
}

describe('organization settings (ORG-04)', () => {
  it('an Owner updates the profile and billing contact; version bumps; audit has field names only', async () => {
    const t = await setup();
    const res = await t.patchOrg({
      expectedVersion: 1,
      displayName: 'Systematic Elegance Events',
      legalName: 'PT Systematic Elegance',
      locale: 'id-ID',
      timezone: 'Asia/Jakarta',
      billingContact: { name: 'Finance Team', email: 'Billing@Example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      displayName: 'Systematic Elegance Events',
      legalName: 'PT Systematic Elegance',
      locale: 'id-ID',
      version: 2,
      billingContact: { name: 'Finance Team', email: 'billing@example.com' },
    });
    const { rows } = await pools.migrator.query(
      `SELECT metadata FROM eventhub.audit_event WHERE organization_id = $1 AND action = 'organization.updated'`,
      [t.orgId],
    );
    expect(rows[0].metadata.fields).toEqual([
      'displayName',
      'legalName',
      'locale',
      'timezone',
      'billingContact',
    ]);
    expect(JSON.stringify(rows[0].metadata)).not.toContain('billing@example.com');
  });

  it('permissions are per field: Admins cannot change billing, Billing admins can only change billing', async () => {
    const t = await setup(['admin', 'billing_admin']);
    const adminBilling = await t.patchOrg(
      {
        expectedVersion: 1,
        displayName: 'X',
        billingContact: { name: 'A', email: 'a@example.com' },
      },
      t.members.admin,
    );
    expect(adminBilling.statusCode).toBe(403);
    expect(adminBilling.json().error.details).toMatchObject({
      reason: 'missing_permission:billing.manage',
      fields: [{ path: 'body.billingContact' }],
    });
    expect((await t.getOrg()).displayName).not.toBe('X'); // nothing partially applied

    expect(
      (await t.patchOrg({ expectedVersion: 1, displayName: 'By Admin' }, t.members.admin))
        .statusCode,
    ).toBe(200);
    const billing = await t.patchOrg(
      { expectedVersion: 2, billingContact: { name: 'Finance', email: 'fin@example.com' } },
      t.members.billing_admin,
    );
    expect(billing.statusCode).toBe(200);
    const profile = await t.patchOrg(
      { expectedVersion: 3, displayName: 'Nope' },
      t.members.billing_admin,
    );
    expect(profile.json().error.details.reason).toBe('missing_permission:organization.manage');
  });

  it('shows the billing contact only to roles with billing.read', async () => {
    const t = await setup(['viewer', 'billing_admin']);
    await t.patchOrg({
      expectedVersion: 1,
      billingContact: { name: 'Finance', email: 'fin@example.com' },
    });
    expect((await t.getOrg(t.members.viewer)).billingContact).toBeUndefined();
    expect((await t.getOrg(t.members.billing_admin)).billingContact).toEqual({
      name: 'Finance',
      email: 'fin@example.com',
    });
  });

  it('clears optional fields with null, rejects stale versions and bad input, and hides other tenants', async () => {
    const t = await setup(['viewer']);
    await t.patchOrg({
      expectedVersion: 1,
      legalName: 'Legal',
      billingContact: { name: 'F', email: 'f@example.com' },
    });
    const cleared = (
      await t.patchOrg({ expectedVersion: 2, legalName: null, billingContact: null })
    ).json();
    expect(cleared).toMatchObject({ legalName: null, billingContact: { name: null, email: null } });

    expect(
      (await t.patchOrg({ expectedVersion: 1, displayName: 'Stale' })).json().error.details.reason,
    ).toBe('version_conflict');
    expect((await t.patchOrg({ expectedVersion: 3, timezone: 'Mars/Base' })).statusCode).toBe(400);
    expect((await t.patchOrg({ expectedVersion: 3 })).statusCode).toBe(400);
    expect(
      (await t.patchOrg({ expectedVersion: 3, displayName: 'v' }, t.members.viewer)).statusCode,
    ).toBe(403);
    const outsider = (await setup()).owner;
    expect((await t.patchOrg({ expectedVersion: 3, displayName: 'x' }, outsider)).statusCode).toBe(
      404,
    );
  });
});

describe('member role changes', () => {
  it('an Owner promotes a member; the new role applies on the next request', async () => {
    const t = await setup(['viewer']);
    const viewer = t.members.viewer!;
    const createEvent = () =>
      app.inject({
        method: 'POST',
        url: `${t.orgUrl}/events`,
        headers: { ...auth(viewer), ...idem() },
        payload: {
          name: 'x',
          slug: `s-${randomUUID().slice(0, 8)}`,
          timezone: 'UTC',
          startsAt: '2027-01-01T00:00:00Z',
          endsAt: '2027-01-02T00:00:00Z',
          venueMode: 'virtual',
          primaryLanguage: 'en',
        },
      });
    expect((await createEvent()).statusCode).toBe(403);
    const res = await t.changeRole(viewer, 'event_manager');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'event_manager', email: viewer.email });
    expect((await createEvent()).statusCode).toBe(201);
    const { rows } = await pools.migrator.query(
      `SELECT metadata FROM eventhub.audit_event WHERE organization_id = $1 AND action = 'membership.role_changed'`,
      [t.orgId],
    );
    expect(rows[0].metadata).toMatchObject({ from: 'viewer', to: 'event_manager', self: false });
  });

  it('enforces the role ceiling in both directions', async () => {
    const t = await setup(['admin', 'viewer']);
    expect(
      (await t.changeRole(t.members.viewer!, 'owner', t.members.admin)).json().error.details.reason,
    ).toBe('role_above_actor');
    expect(
      (await t.changeRole(t.owner, 'viewer', t.members.admin)).json().error.details.reason,
    ).toBe('role_above_actor');
    expect((await t.changeRole(t.members.viewer!, 'admin', t.members.admin)).statusCode).toBe(200);
  });

  it('the last Owner cannot be demoted; with two Owners one can step down', async () => {
    const t = await setup(['owner']);
    const solo = await setup();
    expect((await solo.changeRole(solo.owner, 'admin')).json().error.details.reason).toBe(
      'last_owner',
    );
    expect((await t.changeRole(t.owner, 'admin')).statusCode).toBe(200);
    expect(
      (await t.changeRole(t.members.owner!, 'admin', t.members.owner)).json().error.details.reason,
    ).toBe('last_owner');
  });

  it('two Owners demoting each other at once can never leave the organization without an Owner', async () => {
    const t = await setup(['owner']);
    const other = t.members.owner!;
    const [a, b] = await Promise.all([
      t.changeRole(other, 'admin', t.owner),
      t.changeRole(t.owner, 'admin', other),
    ]);
    // Exactly one succeeds. The other is refused either as role_above_actor (403: it re-resolved
    // its caller's role after being demoted) or last_owner (409: it reached the locked Owner check).
    const outcomes = [a, b].map((r) => r.statusCode).sort();
    expect(outcomes[0]).toBe(200);
    expect([403, 409]).toContain(outcomes[1]);
    const { rows } = await pools.migrator.query(
      `SELECT count(*)::int AS n FROM eventhub.membership WHERE organization_id = $1 AND role = 'owner' AND status = 'active'`,
      [t.orgId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('roles without membership.manage cannot change roles; other tenants get 404', async () => {
    const t = await setup(['event_manager', 'viewer']);
    expect(
      (await t.changeRole(t.members.viewer!, 'analyst', t.members.event_manager)).statusCode,
    ).toBe(403);
    const outsider = (await setup()).owner;
    expect((await t.changeRole(t.members.viewer!, 'analyst', outsider)).statusCode).toBe(404);
  });
});

describe('pending invitations follow their sender’s current authority', () => {
  async function issueToken(invitationId: string, orgId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await pools.worker.query('SELECT out_email FROM eventhub.invitation_issue_token($1, $2, $3)', [
      invitationId,
      orgId,
      createHash('sha256').update(token).digest(),
    ]);
    return token;
  }

  it('demoting an Admin revokes their invitations above the new role; the rest survive', async () => {
    const t = await setup(['admin']);
    const admin = t.members.admin!;
    const adminInvite = (await t.invite(admin, `a-${randomUUID()}@example.test`, 'admin')).json();
    const token = await issueToken(adminInvite.id, t.orgId);
    const ownerInvite = (await t.invite(t.owner, `o-${randomUUID()}@example.test`, 'admin')).json();

    // Event managers cannot manage members at all, so every pending invitation the admin sent goes.
    expect((await t.changeRole(admin, 'event_manager')).statusCode).toBe(200);
    const list = (
      await app.inject({ method: 'GET', url: `${t.orgUrl}/invitations`, headers: auth(t.owner) })
    ).json().data;
    const status = (id: string) => list.find((i: { id: string }) => i.id === id).status;
    expect(status(adminInvite.id)).toBe('revoked');
    expect(status(ownerInvite.id)).toBe('pending');
    expect(
      (
        await pools.app.query('SELECT * FROM eventhub.invitation_resolve($1)', [
          createHash('sha256').update(token).digest(),
        ])
      ).rows,
    ).toEqual([]);
  });

  it('removing a member revokes all of their pending invitations', async () => {
    const t = await setup(['admin']);
    const admin = t.members.admin!;
    const inv = (await t.invite(admin, `r-${randomUUID()}@example.test`, 'viewer')).json();
    const membershipId = await t.membershipOf(admin);
    await app.inject({
      method: 'POST',
      url: `${t.orgUrl}/members/${membershipId}/remove`,
      headers: { ...auth(t.owner), ...idem() },
    });
    const list = (
      await app.inject({ method: 'GET', url: `${t.orgUrl}/invitations`, headers: auth(t.owner) })
    ).json().data;
    expect(list.find((i: { id: string }) => i.id === inv.id).status).toBe('revoked');
  });
});
