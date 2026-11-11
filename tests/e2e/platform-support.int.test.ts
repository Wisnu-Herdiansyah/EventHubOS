import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { InMemoryEmailSender } from '@eventhub/kernel';
import {
  addFixtureMembership,
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
import {
  setPlatformStaff,
  StaffAdminError,
} from '../../apps/api/src/modules/platform/staff-admin.ts';
import { sendSupportAccessEmailConsumer } from '../../apps/worker/src/consumers/send-support-access-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

/** Platform staff and support access (ADR-0045). */
describe('platform staff and support access', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendSupportAccessEmailConsumer(inbox, { appBaseUrl: 'https://admin.example.test' }),
  ]);
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.76.${Math.floor(++ip / 250)}.${ip % 250}` });
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

  const withMfa = (u: FixtureUser) =>
    pools.migrator.query(
      `INSERT INTO eventhub.auth_mfa_factor (user_id, secret_sealed, status, activated_at)
       VALUES ($1, $2, 'active', now())`,
      [u.id, randomBytes(40)],
    );
  async function staffMember(mfa = true) {
    const u = await createFixtureUser(pools.migrator);
    expect(
      await setPlatformStaff(pools.migrator, {
        action: 'grant',
        email: u.email,
        operator: 'Test Operator',
      }),
    ).toBe('granted');
    if (mfa) await withMfa(u);
    return u;
  }
  async function organization(roles: string[] = []) {
    const owner = await createFixtureUser(pools.migrator);
    const orgId = await createFixtureOrganization(pools.migrator, owner.id);
    const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
    await pools.migrator.query(
      `INSERT INTO eventhub.registration (organization_id, event_id, email, name, status, privacy_policy_url)
       VALUES ($1, $2, 'attendee@example.test', 'Private Attendee', 'confirmed', 'https://example.com/p')`,
      [orgId, eventId],
    );
    const members: Record<string, FixtureUser> = {};
    for (const role of roles) {
      const u = await createFixtureUser(pools.migrator);
      await addFixtureMembership(pools.migrator, orgId, u.id, role);
      members[role] = u;
    }
    const base = `/v1/organizations/${orgId}`;
    const grant = (hours: number, as = owner) =>
      call({
        method: 'POST',
        url: `${base}/support-access`,
        headers: { ...auth(as), ...idem() },
        payload: { hours },
      });
    const revoke = (as = owner) =>
      call({
        method: 'POST',
        url: `${base}/support-access/revoke`,
        headers: { ...auth(as), ...idem() },
      });
    const state = (as = owner) =>
      call({ method: 'GET', url: `${base}/support-access`, headers: auth(as) });
    const get = (path: string, as: FixtureUser) =>
      call({ method: 'GET', url: `${base}${path}`, headers: auth(as) });
    return { owner, orgId, eventId, members, base, grant, revoke, state, get };
  }
  const supportAudit = async (orgId: string) =>
    (
      await pools.migrator.query<{
        action: string;
        actor_type: string;
        metadata: { permission?: string };
      }>(
        `SELECT action, actor_type, metadata FROM eventhub.audit_event
          WHERE organization_id = $1 AND action LIKE 'support.%' ORDER BY occurred_at`,
        [orgId],
      )
    ).rows;

  describe('becoming staff (operator command only)', () => {
    it('grants and revokes by email, is idempotent, and is audited with the operator', async () => {
      const u = await createFixtureUser(pools.migrator);
      const set = (action: 'grant' | 'revoke') =>
        setPlatformStaff(pools.migrator, {
          action,
          email: u.email.toUpperCase(),
          operator: 'Ade Ops',
        });
      expect(await set('grant')).toBe('granted');
      expect(await set('grant')).toBe('unchanged');
      expect(await set('revoke')).toBe('revoked');
      expect(await set('revoke')).toBe('unchanged');
      expect(await set('grant')).toBe('granted');
      const audit = await pools.migrator.query<{ action: string; metadata: { operator: string } }>(
        `SELECT action, metadata FROM eventhub.audit_event WHERE target_id = $1 ORDER BY occurred_at`,
        [u.id],
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        'platform.staff_granted',
        'platform.staff_revoked',
        'platform.staff_granted',
      ]);
      expect(audit.rows[0]!.metadata.operator).toBe('Ade Ops');
    });

    it('refuses unknown accounts and anonymous operators', async () => {
      await expect(
        setPlatformStaff(pools.migrator, {
          action: 'grant',
          email: 'nobody@example.test',
          operator: 'Ops',
        }),
      ).rejects.toBeInstanceOf(StaffAdminError);
      const u = await createFixtureUser(pools.migrator);
      await expect(
        setPlatformStaff(pools.migrator, { action: 'grant', email: u.email, operator: '' }),
      ).rejects.toBeInstanceOf(StaffAdminError);
    });

    it('cannot be done by the runtime roles', async () => {
      const u = await createFixtureUser(pools.migrator);
      for (const pool of [pools.app, pools.worker]) {
        await expect(
          pool.query('INSERT INTO eventhub.platform_staff (user_id) VALUES ($1)', [u.id]),
        ).rejects.toThrow(/permission denied/);
      }
      // And no API route exists for it.
      const routes = app.printRoutes({ commonPrefix: false });
      expect(routes).not.toMatch(/staff/i);
    });
  });

  describe('platform routes', () => {
    it('are for staff with two-step verification only', async () => {
      const nobody = await createFixtureUser(pools.migrator);
      const noMfa = await staffMember(false);
      const staff = await staffMember();
      const me = async (u: FixtureUser) =>
        (await call({ method: 'GET', url: '/v1/platform/me', headers: auth(u) })).json();
      expect(await me(nobody)).toEqual({ staff: false, mfaEnabled: false });
      expect(await me(noMfa)).toEqual({ staff: true, mfaEnabled: false });
      expect(await me(staff)).toEqual({ staff: true, mfaEnabled: true });
      for (const u of [nobody, noMfa]) {
        const res = await call({
          method: 'GET',
          url: '/v1/platform/organizations',
          headers: auth(u),
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.details.reason).toBe('platform_staff_required');
      }
      // The database checks again, whatever the API does.
      await expect(
        pools.app.query('SELECT * FROM eventhub.platform_organizations($1)', [nobody.id]),
      ).rejects.toThrow(/not platform staff/);
    });

    it('lists organizations with counts and support status, nothing personal', async () => {
      const staff = await staffMember();
      const t = await organization(['viewer']);
      await t.grant(4);
      const res = await call({
        method: 'GET',
        url: '/v1/platform/organizations',
        headers: auth(staff),
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = (
        res.json().data as Array<{ id: string; supportAccessUntil: string | null }>
      ).find((o) => o.id === t.orgId);
      expect(row).toMatchObject({ members: 2, events: 1, status: 'active' });
      expect(row?.supportAccessUntil).not.toBeNull();
      expect(res.body).not.toContain('attendee@example.test');
      expect(res.body).not.toContain(t.owner.email);
    });

    it('looks up and lifts bounce suppressions, never complaints, audited without the address', async () => {
      const staff = await staffMember();
      const bounced = `b-${randomUUID()}@example.test`;
      const complained = `c-${randomUUID()}@example.test`;
      await pools.migrator.query(
        `INSERT INTO eventhub.email_suppression (address, reason, first_event_at, last_event_at)
         VALUES ($1, 'bounce', now(), now()), ($2, 'complaint', now(), now())`,
        [bounced, complained],
      );
      const look = (a: string) =>
        call({
          method: 'GET',
          url: `/v1/platform/email-suppressions?address=${encodeURIComponent(a)}`,
          headers: auth(staff),
        });
      expect((await look(bounced.toUpperCase())).json()).toMatchObject({
        reason: 'bounce',
        liftedAt: null,
      });
      expect((await look('never@example.test')).statusCode).toBe(404);
      const lift = (a: string) =>
        call({
          method: 'POST',
          url: '/v1/platform/email-suppressions/lift-bounce',
          headers: { ...auth(staff), ...idem() },
          payload: { address: a },
        });
      expect((await lift(bounced)).json()).toEqual({ lifted: true });
      expect((await look(bounced)).json().liftedAt).not.toBeNull();
      expect((await lift(bounced)).json()).toEqual({ lifted: false });
      expect((await lift(complained)).json()).toEqual({ lifted: false });
      expect((await look(complained)).json().liftedAt).toBeNull();
      const audit = await pools.migrator.query<{
        actor_id: string;
        metadata: Record<string, string>;
      }>(
        `SELECT actor_id, metadata FROM eventhub.audit_event WHERE action = 'platform.email_bounce_lifted'
          AND actor_id = $1`,
        [staff.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(JSON.stringify(audit.rows[0]!.metadata)).not.toContain(bounced);
      expect(audit.rows[0]!.metadata.addressSha256).toMatch(/^[0-9a-f]{64}$/);
      // Non-staff cannot.
      const nobody = await createFixtureUser(pools.migrator);
      const denied = await call({
        method: 'POST',
        url: '/v1/platform/email-suppressions/lift-bounce',
        headers: { ...auth(nobody), ...idem() },
        payload: { address: bounced },
      });
      expect(denied.statusCode).toBe(403);
    });
  });

  describe('support access', () => {
    it('staff see nothing of an organization until it grants access', async () => {
      const staff = await staffMember();
      const t = await organization();
      expect((await t.get('', staff)).statusCode).toBe(404);
      expect((await t.get('/events', staff)).statusCode).toBe(404);
      expect(await supportAudit(t.orgId)).toEqual([]);
    });

    it('a grant gives read-only access without attendee data, every read audited', async () => {
      const staff = await staffMember();
      const t = await organization();
      const g = await t.grant(2);
      expect(g.statusCode, g.body).toBe(201);
      expect(g.json()).toMatchObject({ status: 'active', grantedByYou: true });
      const org = await t.get('', staff);
      expect(org.statusCode, org.body).toBe(200);
      expect(org.json().role).toBe('support');
      expect((await t.get('/events', staff)).statusCode).toBe(200);
      expect((await t.get('/members', staff)).statusCode).toBe(200);
      expect((await t.get('/audit-events', staff)).statusCode).toBe(200);
      expect((await t.get(`/events/${t.eventId}/report`, staff)).statusCode).toBe(200);
      // No attendee data, and no changes.
      const regs = await t.get(`/events/${t.eventId}/registrations`, staff);
      expect(regs.statusCode).toBe(403);
      expect(regs.body).not.toContain('attendee@example.test');
      const patch = await call({
        method: 'PATCH',
        url: t.base,
        headers: { ...auth(staff), ...idem() },
        payload: { expectedVersion: 1, displayName: 'Taken over' },
      });
      expect(patch.statusCode).toBe(403);
      // Staff cannot extend or change the grant themselves.
      expect((await t.grant(72, staff)).statusCode).toBe(403);
      expect((await t.revoke(staff)).statusCode).toBe(403);
      // Every read under support access is in the organization's own log.
      const audit = await supportAudit(t.orgId);
      // The five reads above; refused attempts change nothing and leave no access entry.
      expect(audit.length).toBe(5);
      expect(
        audit.every((a) => a.action === 'support.accessed' && a.actor_type === 'platform_support'),
      ).toBe(true);
      expect(audit.map((a) => a.metadata.permission)).toContain('event.read');
    });

    it('ends when revoked, when it expires, when staff lose their status or two-step verification', async () => {
      const staff = await staffMember();
      const t = await organization();
      await t.grant(1);
      expect((await t.get('', staff)).statusCode).toBe(200);
      expect((await t.revoke()).statusCode).toBe(204);
      expect((await t.get('', staff)).statusCode).toBe(404);
      expect((await t.revoke()).json().error.details.reason).toBe('no_active_support_access');

      await t.grant(1);
      await pools.migrator.query(
        `UPDATE eventhub.support_grant SET granted_at = now() - interval '2 hours',
                expires_at = now() - interval '1 hour' WHERE organization_id = $1 AND revoked_at IS NULL`,
        [t.orgId],
      );
      expect((await t.get('', staff)).statusCode).toBe(404);

      await t.grant(1);
      expect((await t.get('', staff)).statusCode).toBe(200);
      await pools.migrator.query('DELETE FROM eventhub.auth_mfa_factor WHERE user_id = $1', [
        staff.id,
      ]);
      expect((await t.get('', staff)).statusCode).toBe(404);
      await withMfa(staff);
      expect((await t.get('', staff)).statusCode).toBe(200);
      await setPlatformStaff(pools.migrator, {
        action: 'revoke',
        email: staff.email,
        operator: 'Ops',
      });
      expect((await t.get('', staff)).statusCode).toBe(404);
    });

    it('is for one organization only, and only Owners and Admins grant it', async () => {
      const staff = await staffMember();
      const a = await organization(['admin', 'event_manager']);
      const b = await organization();
      expect((await a.grant(1, a.members.event_manager)).statusCode).toBe(403);
      expect((await a.grant(3, a.members.admin)).statusCode).toBe(201);
      expect((await a.get('', staff)).statusCode).toBe(200);
      expect((await b.get('', staff)).statusCode).toBe(404);
      // A member of another organization cannot see or revoke this one's grants.
      expect((await a.state(b.owner)).statusCode).toBe(404);
      expect((await a.revoke(b.owner)).statusCode).toBe(404);
    });

    it('allows one grant at a time, up to 72 hours, and shows the history', async () => {
      const t = await organization();
      expect((await t.grant(73)).statusCode).toBe(400);
      expect((await t.grant(0)).statusCode).toBe(400);
      expect((await t.grant(72)).statusCode).toBe(201);
      const again = await t.grant(1);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.details.reason).toBe('support_access_active');
      await t.revoke();
      const s = (await t.state()).json();
      expect(s.active).toBeNull();
      expect(s.recent.map((g: { status: string }) => g.status)).toEqual(['revoked']);
      expect(s.maxHours).toBe(72);
      // The database refuses longer grants too.
      await expect(
        pools.migrator.query(
          `INSERT INTO eventhub.support_grant (organization_id, granted_by, expires_at)
           VALUES ($1, $2, now() + interval '73 hours')`,
          [t.orgId, t.owner.id],
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('is audited and emailed to the Owners', async () => {
      const t = await organization(['admin']);
      await t.grant(8, t.members.admin);
      await t.revoke();
      for (let i = 0; i < 5; i++)
        await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
      const mails = inbox.sent.filter((m) => m.to === t.owner.email);
      expect(mails.map((m) => m.subject)).toEqual([
        expect.stringContaining('EventHub support can view your organization until'),
        expect.stringContaining('EventHub support access was turned off'),
      ]);
      expect(mails[0]!.text).toContain(t.members.admin!.email);
      expect(mails[0]!.text).toContain('cannot change');
      const audit = await pools.migrator.query<{ action: string }>(
        `SELECT action FROM eventhub.audit_event WHERE organization_id = $1
          AND action LIKE 'organization.support_access_%' ORDER BY occurred_at`,
        [t.orgId],
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        'organization.support_access_granted',
        'organization.support_access_revoked',
      ]);
    });

    it('does not apply to suspended organizations', async () => {
      const staff = await staffMember();
      const t = await organization();
      await t.grant(1);
      await pools.migrator.query(
        `UPDATE eventhub.organization SET status = 'suspended' WHERE id = $1`,
        [t.orgId],
      );
      expect((await t.get('', staff)).statusCode).toBe(404);
    });
  });
});
