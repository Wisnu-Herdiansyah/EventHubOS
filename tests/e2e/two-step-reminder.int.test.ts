import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { InMemoryEmailSender } from '@eventhub/kernel';
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
import { sendTwoStepReminderConsumer } from '../../apps/worker/src/consumers/send-two-step-reminder.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

const APP = 'https://app.example.test';

/** Reminding members to turn on two-step verification (ADR-0031). */
describe('two-step verification reminders', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendTwoStepReminderConsumer(inbox, { appBaseUrl: APP }),
  ]);
  let app: FastifyInstance;
  const auth = (u: FixtureUser) => ({ authorization: `Bearer ${u.token}` });
  const mails = (to: string) =>
    inbox.sent.filter((m) => m.to === to && m.template === 'two_step_reminder');
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

  const withMfa = async (u: FixtureUser) => {
    await pools.migrator.query(
      `INSERT INTO eventhub.auth_mfa_factor (user_id, secret_sealed, status, activated_at)
       VALUES ($1, $2, 'active', now())`,
      [u.id, randomBytes(48)],
    );
    return u;
  };

  async function setup() {
    const owner = await withMfa(await createFixtureUser(pools.migrator));
    const orgId = await createFixtureOrganization(pools.migrator, owner.id, 'Reminder Events');
    const member = async (role: string) => {
      const u = await createFixtureUser(pools.migrator);
      await addFixtureMembership(pools.migrator, orgId, u.id, role);
      const m = await pools.migrator.query<{ id: string }>(
        'SELECT id FROM eventhub.membership WHERE organization_id = $1 AND user_id = $2',
        [orgId, u.id],
      );
      return { user: u, membershipId: m.rows[0]!.id };
    };
    const remind = (membershipId: string, as: FixtureUser = owner, org = orgId) =>
      app.inject({
        method: 'POST',
        url: `/v1/organizations/${org}/members/${membershipId}/two-step-reminder`,
        headers: { ...auth(as), 'idempotency-key': `k-${randomUUID()}` },
      });
    return { owner, orgId, member, remind };
  }

  it('emails the member once, says who asked, and audits without the address', async () => {
    const t = await setup();
    const admin = await t.member('admin');
    const res = await t.remind(admin.membershipId);
    expect(res.statusCode, res.body).toBe(202);
    await drain();
    const sent = mails(admin.user.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Reminder Events: please turn on two-step verification');
    expect(sent[0]!.text).toContain(`${t.owner.email} asks you to turn on two-step verification`);
    expect(sent[0]!.text).toContain(`${APP}/account#two-step-heading`);
    expect(sent[0]!.text).not.toContain("can't open");

    const audit = await pools.migrator.query(
      `SELECT actor_id, target_id, metadata FROM eventhub.audit_event
        WHERE organization_id = $1 AND action = 'membership.two_step_reminder_sent'`,
      [t.orgId],
    );
    expect(audit.rows).toEqual([
      { actor_id: t.owner.id, target_id: admin.membershipId, metadata: { role: 'admin' } },
    ]);
  });

  it('shows managers when each member was last reminded', async () => {
    const t = await setup();
    const viewer = await t.member('viewer');
    const list = async () =>
      (
        await app.inject({
          method: 'GET',
          url: `/v1/organizations/${t.orgId}/members`,
          headers: auth(t.owner),
        })
      ).json().data as Array<{ membershipId: string; twoStepRemindedAt: string | null }>;
    expect((await list()).find((m) => m.membershipId === viewer.membershipId)).toMatchObject({
      twoStepRemindedAt: null,
    });
    await t.remind(viewer.membershipId);
    const after = (await list()).find((m) => m.membershipId === viewer.membershipId)!;
    expect(Date.now() - Date.parse(after.twoStepRemindedAt!)).toBeLessThan(60_000);
  });

  it('allows one reminder per member per day', async () => {
    const t = await setup();
    const viewer = await t.member('viewer');
    expect((await t.remind(viewer.membershipId)).statusCode).toBe(202);
    const again = await t.remind(viewer.membershipId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details.reason).toBe('recently_reminded');
    await pools.migrator.query(
      `UPDATE eventhub.membership SET two_step_reminded_at = now() - interval '25 hours' WHERE id = $1`,
      [viewer.membershipId],
    );
    expect((await t.remind(viewer.membershipId)).statusCode).toBe(202);
    await drain();
    expect(mails(viewer.user.email)).toHaveLength(2);
  });

  it('says what is at stake when the organization requires it', async () => {
    const t = await setup();
    await pools.migrator.query(
      'UPDATE eventhub.organization SET require_mfa_for_admins = true WHERE id = $1',
      [t.orgId],
    );
    const admin = await t.member('admin');
    const manager = await t.member('event_manager');
    await t.remind(admin.membershipId);
    await t.remind(manager.membershipId);
    await drain();
    expect(mails(admin.user.email)[0]!.text).toContain(
      "Reminder Events requires it for Owners and Admins: until it is on, you can't open",
    );
    // The requirement does not cover Event managers, so their email does not claim it does.
    expect(mails(manager.user.email)[0]!.text).not.toContain("can't open");
  });

  it('refuses pointless or unauthorized reminders', async () => {
    const t = await setup();
    const enrolled = await t.member('admin');
    await withMfa(enrolled.user);
    const r1 = await t.remind(enrolled.membershipId);
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.details.reason).toBe('already_enabled');

    const ownMembership = await pools.migrator.query<{ id: string }>(
      'SELECT id FROM eventhub.membership WHERE organization_id = $1 AND user_id = $2',
      [t.orgId, t.owner.id],
    );
    const r2 = await t.remind(ownMembership.rows[0]!.id);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.details.reason).toBe('self');

    const gone = await t.member('viewer');
    await pools.migrator.query(`UPDATE eventhub.membership SET status = 'removed' WHERE id = $1`, [
      gone.membershipId,
    ]);
    expect((await t.remind(gone.membershipId)).statusCode).toBe(404);

    const manager = await t.member('event_manager');
    const target = await t.member('viewer');
    const r3 = await t.remind(target.membershipId, manager.user);
    expect(r3.statusCode).toBe(403);

    // Another organization's Owner, and this organization's member under another org's URL.
    const other = await setup();
    expect((await t.remind(target.membershipId, other.owner)).statusCode).toBe(404);
    expect((await other.remind(target.membershipId)).statusCode).toBe(404);
  });

  it('lets an Admin remind an Owner: a reminder changes nothing about their account', async () => {
    const t = await setup();
    const admin = await t.member('admin');
    const owner2 = await t.member('owner');
    expect((await t.remind(owner2.membershipId, admin.user)).statusCode).toBe(202);
    await drain();
    expect(mails(owner2.user.email)[0]!.text).toContain(`${admin.user.email} asks you`);
  });

  it('sends nothing if the member turned it on before the email went out', async () => {
    const t = await setup();
    const admin = await t.member('admin');
    expect((await t.remind(admin.membershipId)).statusCode).toBe(202);
    await withMfa(admin.user);
    await drain();
    expect(mails(admin.user.email)).toHaveLength(0);
  });

  it('the details function is for the worker only', async () => {
    const t = await setup();
    const admin = await t.member('admin');
    await expect(
      pools.app.query('SELECT * FROM eventhub.two_step_reminder_details($1, $2)', [
        admin.membershipId,
        t.orgId,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});
