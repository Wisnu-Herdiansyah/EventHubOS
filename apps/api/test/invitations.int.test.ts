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
    invitationTtlSeconds: 3600,
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
const ip = () => `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

const invite = (actor: FixtureUser, orgId: string, email: string, role: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/organizations/${orgId}/invitations`,
    headers: { ...auth(actor), ...idem() },
    payload: { email, role },
    remoteAddress: ip(),
  });

const accept = (user: FixtureUser, token: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/invitations/accept',
    headers: auth(user),
    payload: { token },
    remoteAddress: ip(),
  });

/** Plays the worker: bind a fresh token to the invitation and return it. */
async function issueToken(invitationId: string, orgId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await pools.worker.query(
    'SELECT out_email FROM eventhub.invitation_issue_token($1, $2, $3)',
    [invitationId, orgId, createHash('sha256').update(token).digest()],
  );
  expect(rows).toHaveLength(1);
  return token;
}

async function orgWith(roles: string[] = []) {
  const owner = await createFixtureUser(pools.migrator);
  const orgId = await createFixtureOrganization(pools.migrator, owner.id);
  const members: Record<string, FixtureUser> = {};
  for (const role of roles) {
    const u = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgId, u.id, role);
    members[role] = u;
  }
  return { owner, orgId, members };
}

describe('creating invitations', () => {
  it('an Owner invites by email; outbox and audit carry no plaintext address', async () => {
    const { owner, orgId } = await orgWith();
    const email = `new-${randomUUID()}@example.test`;
    const res = await invite(owner, orgId, email.toUpperCase(), 'viewer');
    expect(res.statusCode).toBe(201);
    const inv = res.json();
    expect(inv).toMatchObject({
      organizationId: orgId,
      email,
      role: 'viewer',
      status: 'pending',
      invitedBy: owner.id,
    });

    const { rows } = await pools.migrator.query(
      `SELECT (SELECT payload FROM eventhub.outbox_event WHERE aggregate_id = $1 AND event_type = 'membership.invited') AS payload,
              (SELECT metadata FROM eventhub.audit_event WHERE target_id = $1 AND action = 'membership.invited') AS metadata`,
      [inv.id],
    );
    expect(rows[0].payload).toEqual({ invitationId: inv.id, organizationId: orgId });
    expect(JSON.stringify(rows[0].metadata)).not.toContain(email);
  });

  it('enforces the role ceiling: an Admin cannot invite an Owner but can invite an Admin', async () => {
    const { orgId, members } = await orgWith(['admin']);
    const up = await invite(members.admin!, orgId, `o-${randomUUID()}@example.test`, 'owner');
    expect(up.statusCode).toBe(403);
    expect(up.json().error.details.reason).toBe('role_above_actor');
    expect(
      (await invite(members.admin!, orgId, `a-${randomUUID()}@example.test`, 'admin')).statusCode,
    ).toBe(201);
  });

  it('roles without membership.manage cannot invite', async () => {
    const { orgId, members } = await orgWith(['event_manager', 'billing_admin', 'viewer']);
    for (const role of ['event_manager', 'billing_admin', 'viewer']) {
      const res = await invite(members[role]!, orgId, `x-${randomUUID()}@example.test`, 'viewer');
      expect(res.statusCode, role).toBe(403);
    }
  });

  it('rejects a second pending invitation and inviting an existing member', async () => {
    const { owner, orgId, members } = await orgWith(['viewer']);
    const email = `dup-${randomUUID()}@example.test`;
    expect((await invite(owner, orgId, email, 'viewer')).statusCode).toBe(201);
    const dup = await invite(owner, orgId, email, 'analyst');
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.details.reason).toBe('invitation_pending');
    const member = await invite(owner, orgId, members.viewer!.email, 'analyst');
    expect(member.statusCode).toBe(409);
    expect(member.json().error.details.reason).toBe('already_member');
  });

  it('an expired invitation does not block a new one', async () => {
    const { owner, orgId } = await orgWith();
    const email = `exp-${randomUUID()}@example.test`;
    const first = (await invite(owner, orgId, email, 'viewer')).json();
    await pools.migrator.query(
      `UPDATE eventhub.invitation SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1`,
      [first.id],
    );
    expect((await invite(owner, orgId, email, 'viewer')).statusCode).toBe(201);
  });
});

describe('listing and revoking', () => {
  it('only members with membership.read can list; other tenants get 404', async () => {
    const { owner, orgId, members } = await orgWith(['viewer']);
    await invite(owner, orgId, `l-${randomUUID()}@example.test`, 'viewer');
    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invitations`,
      headers: auth(owner),
    });
    expect(list.json().data).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/organizations/${orgId}/invitations`,
          headers: auth(members.viewer!),
        })
      ).statusCode,
    ).toBe(403);
    const outsider = (await orgWith()).owner;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/organizations/${orgId}/invitations`,
          headers: auth(outsider),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('revoking kills the link; revoking twice conflicts; other tenants cannot revoke', async () => {
    const { owner, orgId } = await orgWith();
    const invitee = await createFixtureUser(pools.migrator);
    const inv = (await invite(owner, orgId, invitee.email, 'viewer')).json();
    const token = await issueToken(inv.id, orgId);

    const outsider = (await orgWith()).owner;
    const foreign = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invitations/${inv.id}/revoke`,
      headers: { ...auth(outsider), ...idem() },
    });
    expect(foreign.statusCode).toBe(404);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invitations/${inv.id}/revoke`,
      headers: { ...auth(owner), ...idem() },
    });
    expect(res.json().status).toBe('revoked');
    const again = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/invitations/${inv.id}/revoke`,
      headers: { ...auth(owner), ...idem() },
    });
    expect(again.statusCode).toBe(409);
    expect((await accept(invitee, token)).statusCode).toBe(400);
  });
});

describe('accepting', () => {
  it('the invited, verified user joins with the invited role; the link is single-use', async () => {
    const { owner, orgId } = await orgWith();
    const invitee = await createFixtureUser(pools.migrator);
    const inv = (await invite(owner, orgId, invitee.email, 'event_manager')).json();
    const token = await issueToken(inv.id, orgId);

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/organizations/${orgId}`,
          headers: auth(invitee),
        })
      ).statusCode,
    ).toBe(404);
    const res = await accept(invitee, token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ organizationId: orgId, role: 'event_manager' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/organizations/${orgId}`,
          headers: auth(invitee),
        })
      ).json().role,
    ).toBe('event_manager');

    const again = await accept(invitee, token);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.details.reason).toBe('invalid_or_expired_invitation');
    const list = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/invitations`,
      headers: auth(owner),
    });
    expect(list.json().data[0].status).toBe('accepted');
  });

  it('a forwarded link cannot be used by a different account', async () => {
    const { owner, orgId } = await orgWith();
    const invitee = await createFixtureUser(pools.migrator);
    const someoneElse = await createFixtureUser(pools.migrator);
    const inv = (await invite(owner, orgId, invitee.email, 'admin')).json();
    const token = await issueToken(inv.id, orgId);
    const res = await accept(someoneElse, token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.reason).toBe('invitation_email_mismatch');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/organizations/${orgId}`,
          headers: auth(someoneElse),
        })
      ).statusCode,
    ).toBe(404);
    expect((await accept(invitee, token)).statusCode).toBe(200); // still usable by the right person
  });

  it('requires a verified email and rejects expired invitations', async () => {
    const { owner, orgId } = await orgWith();
    const unverified = await createFixtureUser(pools.migrator, { verified: false });
    const inv = (await invite(owner, orgId, unverified.email, 'viewer')).json();
    const token = await issueToken(inv.id, orgId);
    expect((await accept(unverified, token)).json().error.code).toBe('email_not_verified');

    const invitee = await createFixtureUser(pools.migrator);
    const inv2 = (await invite(owner, orgId, invitee.email, 'viewer')).json();
    const token2 = await issueToken(inv2.id, orgId);
    await pools.migrator.query(
      `UPDATE eventhub.invitation SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1`,
      [inv2.id],
    );
    expect((await accept(invitee, token2)).statusCode).toBe(400);
  });

  it('only the newest emailed link works after a re-send', async () => {
    const { owner, orgId } = await orgWith();
    const invitee = await createFixtureUser(pools.migrator);
    const inv = (await invite(owner, orgId, invitee.email, 'viewer')).json();
    const older = await issueToken(inv.id, orgId);
    const newer = await issueToken(inv.id, orgId);
    expect((await accept(invitee, older)).statusCode).toBe(400);
    expect((await accept(invitee, newer)).statusCode).toBe(200);
  });

  it('accepting grants exactly the invited role (deny by default still applies)', async () => {
    const { owner, orgId } = await orgWith();
    const invitee = await createFixtureUser(pools.migrator);
    const inv = (await invite(owner, orgId, invitee.email, 'viewer')).json();
    await accept(invitee, await issueToken(inv.id, orgId));
    const create = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/events`,
      headers: { ...auth(invitee), ...idem() },
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
    expect(create.statusCode).toBe(403);
  });
});

describe('members', () => {
  it('lists members with emails for managers', async () => {
    const { owner, orgId, members } = await orgWith(['viewer']);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/members`,
      headers: auth(owner),
    });
    const emails = res
      .json()
      .data.map((m: { email: string }) => m.email)
      .sort();
    expect(emails).toEqual([owner.email, members.viewer!.email].sort());
  });

  it('removal ends access on the next request, and a removed member can be re-invited', async () => {
    const { owner, orgId, members } = await orgWith(['viewer']);
    const list = (
      await app.inject({
        method: 'GET',
        url: `/v1/organizations/${orgId}/members`,
        headers: auth(owner),
      })
    ).json().data;
    const viewerMembership = list.find(
      (m: { userId: string }) => m.userId === members.viewer!.id,
    ).membershipId;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/members/${viewerMembership}/remove`,
      headers: { ...auth(owner), ...idem() },
    });
    expect(res.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/organizations/${orgId}`,
          headers: auth(members.viewer!),
        })
      ).statusCode,
    ).toBe(404);

    const inv = (await invite(owner, orgId, members.viewer!.email, 'analyst')).json();
    const back = await accept(members.viewer!, await issueToken(inv.id, orgId));
    expect(back.json()).toMatchObject({ membershipId: viewerMembership, role: 'analyst' });
  });

  it('an Admin cannot remove an Owner, and the last Owner cannot be removed', async () => {
    const { owner, orgId, members } = await orgWith(['admin']);
    const list = (
      await app.inject({
        method: 'GET',
        url: `/v1/organizations/${orgId}/members`,
        headers: auth(owner),
      })
    ).json().data;
    const ownerMembership = list.find((m: { role: string }) => m.role === 'owner').membershipId;

    const byAdmin = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/members/${ownerMembership}/remove`,
      headers: { ...auth(members.admin!), ...idem() },
    });
    expect(byAdmin.json().error.details.reason).toBe('role_above_actor');
    const self = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${orgId}/members/${ownerMembership}/remove`,
      headers: { ...auth(owner), ...idem() },
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().error.details.reason).toBe('last_owner');
  });

  it('a second Owner makes owner removal possible; other tenants cannot remove members', async () => {
    const { owner, orgId, members } = await orgWith(['owner']);
    const list = (
      await app.inject({
        method: 'GET',
        url: `/v1/organizations/${orgId}/members`,
        headers: auth(owner),
      })
    ).json().data;
    const second = list.find(
      (m: { userId: string }) => m.userId === members.owner!.id,
    ).membershipId;
    const outsider = (await orgWith()).owner;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/organizations/${orgId}/members/${second}/remove`,
          headers: { ...auth(outsider), ...idem() },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/organizations/${orgId}/members/${second}/remove`,
          headers: { ...auth(owner), ...idem() },
        })
      ).statusCode,
    ).toBe(204);
  });
});
