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
import { setPlatformStaff } from '../../apps/api/src/modules/platform/staff-admin.ts';
import { sendDataDownloadEmailConsumer } from '../../apps/worker/src/consumers/send-data-download-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

/** Email notification settings and data download alerts (ADR-0049). */
describe('notification settings and download alerts', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendDataDownloadEmailConsumer(inbox, { appBaseUrl: 'https://admin.example.test' }),
  ]);
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.49.${Math.floor(++ip / 250)}.${ip % 250}` });
  const auth = (u: FixtureUser) => ({ authorization: `Bearer ${u.token}` });
  const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });
  const relay = async () => {
    for (let i = 0; i < 3; i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 200, maxAttempts: 5 });
    }
  };
  const mailsTo = (u: FixtureUser) =>
    inbox.sent.filter((m) => m.to === u.email && m.template === 'organization_data_downloaded');

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

  async function organization(roles: string[] = []) {
    const owner = await createFixtureUser(pools.migrator);
    const orgId = await createFixtureOrganization(pools.migrator, owner.id);
    const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
    await pools.migrator.query(
      `INSERT INTO eventhub.registration (organization_id, event_id, email, name, status, privacy_policy_url)
       VALUES ($1, $2, 'private.attendee@example.test', 'Private Attendee', 'confirmed', 'https://example.com/p')`,
      [orgId, eventId],
    );
    const members: Record<string, FixtureUser> = {};
    for (const role of roles) {
      const u = await createFixtureUser(pools.migrator);
      await addFixtureMembership(pools.migrator, orgId, u.id, role);
      members[role] = u;
    }
    const base = `/v1/organizations/${orgId}`;
    const settings = (as: FixtureUser) =>
      call({ method: 'GET', url: `${base}/notification-settings`, headers: auth(as) });
    const setDownloads = (as: FixtureUser, enabled: boolean) =>
      call({
        method: 'PATCH',
        url: `${base}/notification-settings/data_download`,
        headers: { ...auth(as), ...idem() },
        payload: { enabled },
      });
    const exportAttendees = (as: FixtureUser) =>
      call({
        method: 'POST',
        url: `${base}/events/${eventId}/registrations/export`,
        headers: auth(as),
        payload: {},
      });
    const exportAudit = (as: FixtureUser) =>
      call({ method: 'POST', url: `${base}/audit-events/export`, headers: auth(as), payload: {} });
    return { owner, orgId, eventId, members, settings, setDownloads, exportAttendees, exportAudit };
  }

  describe('settings', () => {
    it('show each role what it can turn off and what it always gets', async () => {
      const t = await organization(['admin', 'event_manager', 'viewer']);
      expect((await t.settings(t.owner)).json()).toEqual({
        settings: [{ kind: 'data_download', enabled: true, defaultEnabled: true }],
        alwaysSent: ['security_settings', 'support_access', 'two_step_reminder'],
      });
      expect((await t.settings(t.members.admin!)).json()).toEqual({
        settings: [{ kind: 'data_download', enabled: true, defaultEnabled: true }],
        alwaysSent: ['two_step_reminder'],
      });
      for (const role of ['event_manager', 'viewer']) {
        expect((await t.settings(t.members[role]!)).json(), role).toEqual({
          settings: [],
          alwaysSent: [],
        });
      }
    });

    it('are personal: turning one off changes nobody else, and is audited once', async () => {
      const t = await organization(['admin']);
      const res = await t.setDownloads(t.members.admin!, false);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ kind: 'data_download', enabled: false, defaultEnabled: true });
      expect((await t.settings(t.members.admin!)).json().settings[0].enabled).toBe(false);
      expect((await t.settings(t.owner)).json().settings[0].enabled).toBe(true);
      // Saving the same value again records nothing new.
      await t.setDownloads(t.members.admin!, false);
      const audit = await pools.migrator.query<{ actor_id: string; metadata: unknown }>(
        `SELECT actor_id, metadata FROM eventhub.audit_event
          WHERE organization_id = $1 AND action = 'notification.setting_changed'`,
        [t.orgId],
      );
      expect(audit.rows).toEqual([
        { actor_id: t.members.admin!.id, metadata: { kind: 'data_download', enabled: false } },
      ]);
    });

    it('refuse roles the notice is not for, unknown kinds, bad bodies and missing keys', async () => {
      const t = await organization(['viewer']);
      const viewer = await t.setDownloads(t.members.viewer!, false);
      expect(viewer.statusCode).toBe(403);
      expect(viewer.json().error.details.reason).toBe('notification_not_applicable');
      const url = `/v1/organizations/${t.orgId}/notification-settings`;
      for (const [path, payload] of [
        ['/security_settings', { enabled: false }],
        ['/data_download', { enabled: 'no' }],
        ['/data_download', { enabled: false, userId: t.members.viewer!.id }],
      ] as const) {
        const res = await call({
          method: 'PATCH',
          url: `${url}${path}`,
          headers: { ...auth(t.owner), ...idem() },
          payload,
        });
        expect(res.statusCode, `${path} ${JSON.stringify(payload)}`).toBe(400);
      }
      const noKey = await call({
        method: 'PATCH',
        url: `${url}/data_download`,
        headers: auth(t.owner),
        payload: { enabled: false },
      });
      expect(noKey.statusCode).toBe(400);
    });

    it('are not visible or changeable across organizations or under support access', async () => {
      const a = await organization();
      const b = await organization();
      expect((await a.settings(b.owner)).statusCode).toBe(404);
      expect((await a.setDownloads(b.owner, false)).statusCode).toBe(404);
      const staff = await createFixtureUser(pools.migrator);
      await setPlatformStaff(pools.migrator, {
        action: 'grant',
        email: staff.email,
        operator: 'Test Operator',
      });
      await pools.migrator.query(
        `INSERT INTO eventhub.auth_mfa_factor (user_id, secret_sealed, status, activated_at)
         VALUES ($1, $2, 'active', now())`,
        [staff.id, randomBytes(40)],
      );
      await pools.migrator.query(
        `INSERT INTO eventhub.support_grant (organization_id, granted_by, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [a.orgId, a.owner.id],
      );
      for (const res of [await a.settings(staff), await a.setDownloads(staff, false)]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error.details.reason).toBe('members_only');
      }
    });

    it('are limited by RLS to the caller in the organization of the request', async () => {
      const a = await organization(['admin']);
      await a.setDownloads(a.members.admin!, false);
      const client = await pools.app.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true)", [a.owner.id]);
        await client.query("SELECT set_config('app.organization_id', $1, true)", [a.orgId]);
        // The Owner cannot see or change the Admin's choice, even with SQL.
        const seen = await client.query('SELECT * FROM eventhub.notification_preference');
        expect(seen.rows).toEqual([]);
        await expect(
          client.query(
            `INSERT INTO eventhub.notification_preference (organization_id, user_id, kind, enabled)
             VALUES ($1, $2, 'data_download', true)`,
            [a.orgId, a.members.admin!.id],
          ),
        ).rejects.toThrow(/row-level security/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      // The worker has no access to the table, only to the recipients function.
      await expect(
        pools.worker.query('SELECT * FROM eventhub.notification_preference'),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('download alerts', () => {
    it('tell the other Owners and Admins who downloaded the attendee list, without attendee data', async () => {
      const t = await organization(['admin', 'event_manager']);
      const second = await createFixtureUser(pools.migrator);
      await addFixtureMembership(pools.migrator, t.orgId, second.id, 'owner');
      const res = await t.exportAttendees(t.members.admin!);
      expect(res.statusCode, res.body).toBe(200);
      await relay();
      for (const u of [t.owner, second]) {
        const mails = mailsTo(u);
        expect(mails, u.email).toHaveLength(1);
        expect(mails[0]!.subject).toContain(
          `${t.members.admin!.email} downloaded the attendee list`,
        );
        expect(mails[0]!.text).toContain('Size: 1 row');
        expect(mails[0]!.text).toContain(`https://admin.example.test/orgs/${t.orgId}/audit`);
        expect(mails[0]!.text).not.toContain('private.attendee@example.test');
        expect(mails[0]!.text).not.toContain('Private Attendee');
      }
      // Not to the person who downloaded, nor to roles that do not read the audit log.
      expect(mailsTo(t.members.admin!)).toEqual([]);
      expect(mailsTo(t.members.event_manager!)).toEqual([]);
    });

    it('cover the audit log, and reach nobody who turned them off', async () => {
      const t = await organization(['admin']);
      await t.setDownloads(t.owner, false);
      expect((await t.exportAudit(t.members.admin!)).statusCode).toBe(200);
      await relay();
      expect(mailsTo(t.owner)).toEqual([]);
      // Turned back on: the next download is reported.
      const back = await t.setDownloads(t.owner, true);
      expect(back.statusCode, back.body).toBe(200);
      expect((await t.exportAudit(t.members.admin!)).statusCode).toBe(200);
      await relay();
      const mails = mailsTo(t.owner);
      expect(mails).toHaveLength(1);
      expect(mails[0]!.subject).toContain('downloaded the audit log');
    });

    it('use one message ID per recipient, so a retried delivery is not a second email', async () => {
      const t = await organization(['admin']);
      await t.exportAttendees(t.members.admin!);
      const { rows } = await pools.migrator.query<{
        id: string;
        occurred_at: Date;
        actor_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT id, occurred_at, actor_id, payload FROM eventhub.outbox_event
          WHERE organization_id = $1 AND event_type = 'organization.data_downloaded'`,
        [t.orgId],
      );
      expect(rows).toHaveLength(1);
      const r = rows[0]!;
      const event = {
        eventId: r.id,
        eventType: 'organization.data_downloaded',
        schemaVersion: 1,
        occurredAt: r.occurred_at,
        actor: { type: 'user' as const, id: r.actor_id },
        organizationId: t.orgId,
        aggregateType: 'event',
        aggregateId: t.eventId,
        correlationId: 'c',
        causationId: null,
        payload: r.payload,
      };
      const local = new InMemoryEmailSender();
      const consumer = sendDataDownloadEmailConsumer(local, {
        appBaseUrl: 'https://admin.example.test',
      });
      const client = await pools.worker.connect();
      try {
        // A crash after sending but before the ledger commit means the event is handled again.
        await consumer.handle(event, client);
        await consumer.handle(event, client);
      } finally {
        client.release();
      }
      expect(local.sent).toHaveLength(2);
      expect(local.sent[0]).toEqual(local.sent[1]);
      expect(local.sent[0]!.messageId).toBe(`${r.id}-${t.owner.id}`);
    });

    it('skip members who are no longer active', async () => {
      const t = await organization(['admin', 'admin']);
      const gone = await createFixtureUser(pools.migrator);
      await addFixtureMembership(pools.migrator, t.orgId, gone.id, 'admin');
      await pools.migrator.query(
        `UPDATE eventhub.membership SET status = 'suspended' WHERE organization_id = $1 AND user_id = $2`,
        [t.orgId, gone.id],
      );
      await t.exportAudit(t.owner);
      await relay();
      expect(mailsTo(t.members.admin!)).toHaveLength(1);
      expect(mailsTo(gone)).toEqual([]);
    });

    it('stay within the organization', async () => {
      const a = await organization(['admin']);
      const b = await organization(['admin']);
      await a.exportAttendees(a.members.admin!);
      await relay();
      expect(mailsTo(a.owner)).toHaveLength(1);
      expect(mailsTo(b.owner)).toEqual([]);
      expect(mailsTo(b.members.admin!)).toEqual([]);
    });

    it('are not written when the export is refused', async () => {
      const t = await organization(['event_manager']);
      expect((await t.exportAudit(t.members.event_manager!)).statusCode).toBe(403);
      const outbox = await pools.migrator.query(
        `SELECT 1 FROM eventhub.outbox_event
          WHERE organization_id = $1 AND event_type = 'organization.data_downloaded'`,
        [t.orgId],
      );
      expect(outbox.rows).toEqual([]);
    });
  });
});
