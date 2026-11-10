import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createDomainEvent, InMemoryEmailSender } from '@eventhub/kernel';
import {
  addFixtureMembership,
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
  type FixtureUser,
} from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';
import { sendSecurityChangedEmailConsumer } from '../../apps/worker/src/consumers/send-security-change-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

const APP = 'https://app.example.test';

/** Owners are emailed when an organization's security settings change (ADR-0026). */
describe('security change emails', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const consumer = sendSecurityChangedEmailConsumer(inbox, { appBaseUrl: APP });
  const publisher = new OutboxDispatchPublisher(pools.worker, [consumer]);
  let app: FastifyInstance;
  const auth = (u: FixtureUser) => ({ authorization: `Bearer ${u.token}` });
  const mails = (to: string) =>
    inbox.sent.filter((m) => m.to === to && m.template === 'organization_security_changed');
  const drain = async () => {
    for (let i = 0; i < 5; i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    }
  };

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

  async function withMfa(user: FixtureUser) {
    await pools.migrator.query(
      `INSERT INTO eventhub.auth_mfa_factor (user_id, secret_sealed, status, activated_at)
       VALUES ($1, $2, 'active', now())`,
      [user.id, randomBytes(48)],
    );
    return user;
  }

  async function setup() {
    const owner = await withMfa(await createFixtureUser(pools.migrator));
    const orgId = await createFixtureOrganization(pools.migrator, owner.id, 'Jakarta Events');
    const member = async (role: string) => {
      const u = await createFixtureUser(pools.migrator);
      await addFixtureMembership(pools.migrator, orgId, u.id, role);
      return u;
    };
    const patch = async (payload: object, as: FixtureUser = owner) => {
      const url = `/v1/organizations/${orgId}`;
      const { version } = (await app.inject({ method: 'GET', url, headers: auth(as) })).json();
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers: { ...auth(as), 'idempotency-key': `k-${randomUUID()}` },
        payload: { expectedVersion: version, ...payload },
      });
      expect(res.statusCode, res.body).toBe(200);
    };
    const securityEvents = async () =>
      (
        await pools.migrator.query(
          `SELECT payload FROM eventhub.outbox_event
            WHERE organization_id = $1 AND event_type = 'organization.security_changed'`,
          [orgId],
        )
      ).rows.map((r) => r.payload);
    return { owner, orgId, member, patch, securityEvents };
  }

  it('emails every active Owner, naming who changed what', async () => {
    const t = await setup();
    const owner2 = await t.member('owner');
    const removedOwner = await t.member('owner');
    await pools.migrator.query(
      `UPDATE eventhub.membership SET status = 'removed' WHERE organization_id = $1 AND user_id = $2`,
      [t.orgId, removedOwner.id],
    );
    const admin = await withMfa(await t.member('admin'));
    const viewer = await t.member('viewer');
    const otherOrgOwner = await createFixtureUser(pools.migrator);
    await createFixtureOrganization(pools.migrator, otherOrgOwner.id);

    // An Admin makes the change: both Owners hear about it.
    await t.patch({ requireMfaForAdmins: true }, admin);
    await drain();
    for (const o of [t.owner, owner2]) {
      const sent = mails(o.email);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.subject).toBe(
        'Jakarta Events now requires two-step verification for Owners and Admins',
      );
      expect(sent[0]!.text).toContain(`${admin.email} turned on`);
      expect(sent[0]!.text).toContain(`${APP}/orgs/${t.orgId}/settings`);
      expect(sent[0]!.text).toContain(`${APP}/orgs/${t.orgId}/audit`);
    }
    for (const u of [removedOwner, admin, viewer, otherOrgOwner]) {
      expect(mails(u.email)).toHaveLength(0);
    }
    // One message per recipient, so providers do not merge them.
    const ids = [...mails(t.owner.email), ...mails(owner2.email)].map((m) => m.messageId);
    expect(new Set(ids).size).toBe(2);

    await t.patch({ requireMfaForAdmins: false });
    await drain();
    const off = mails(owner2.email).at(-1)!;
    expect(off.subject).toBe(
      'Jakarta Events no longer requires two-step verification for Owners and Admins',
    );
    expect(off.text).toContain(`${t.owner.email} turned off`);
    expect(mails(owner2.email)).toHaveLength(2);
  });

  it('announces only real changes', async () => {
    const t = await setup();
    await t.patch({ requireMfaForAdmins: false }); // already off
    await t.patch({ displayName: 'Renamed' });
    expect(await t.securityEvents()).toEqual([]);
    await t.patch({ requireMfaForAdmins: true });
    await t.patch({ requireMfaForAdmins: true }); // already on
    expect(await t.securityEvents()).toEqual([
      { organizationId: t.orgId, setting: 'requireMfaForAdmins', value: true },
    ]);
    await drain();
    await drain(); // a second pass sends nothing again (consumer ledger)
    expect(mails(t.owner.email)).toHaveLength(1);
  });

  it('ignores an event whose payload names another organization', async () => {
    const t = await setup();
    const other = await setup();
    const client = await pools.worker.connect();
    try {
      await consumer.handle(
        createDomainEvent({
          eventType: 'organization.security_changed',
          schemaVersion: 1,
          actor: { type: 'user', id: t.owner.id },
          organizationId: t.orgId,
          aggregateType: 'organization',
          aggregateId: t.orgId,
          correlationId: randomUUID(),
          payload: { organizationId: other.orgId, setting: 'requireMfaForAdmins', value: false },
        }),
        client,
      );
    } finally {
      client.release();
    }
    expect(mails(t.owner.email)).toHaveLength(0);
    expect(mails(other.owner.email)).toHaveLength(0);
  });

  it('the contacts function is for the worker only', async () => {
    const t = await setup();
    await expect(
      pools.app.query('SELECT * FROM eventhub.organization_security_contacts($1)', [t.orgId]),
    ).rejects.toThrow(/permission denied/);
  });
});
