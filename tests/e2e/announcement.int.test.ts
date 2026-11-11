import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { InMemoryEmailSender, type EmailMessage } from '@eventhub/kernel';
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
import { sendAnnouncementConsumer } from '../../apps/worker/src/consumers/send-announcement.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

const SITE = 'https://{handle}.eventhub.example';

/** Event announcements (ADR-0037): one plain-text email to the people signed up for an event. */
describe('announcements', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendAnnouncementConsumer(inbox, { publicSiteUrl: SITE }),
  ]);
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.72.${Math.floor(++ip / 250)}.${ip % 250}` });
  const mails = (to: string, template?: string) =>
    inbox.sent.filter((m) => m.to === to && (!template || m.template === template));
  async function drain(until: () => boolean) {
    for (let i = 0; i < 30 && !until(); i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    }
  }
  const auth = (u: FixtureUser) => ({ authorization: `Bearer ${u.token}` });

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

  /**
   * A published event with a public page (set up directly in the database: the publishing flow
   * has its own tests).
   */
  async function publishedEvent(registration: Record<string, unknown> = {}, roles: string[] = []) {
    const owner = await createFixtureUser(pools.migrator);
    const orgId = await createFixtureOrganization(pools.migrator, owner.id);
    const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
    const handle = `r-${randomUUID().slice(0, 8)}`;
    await pools.migrator.query(
      'UPDATE eventhub.organization SET public_handle = $2 WHERE id = $1',
      [orgId, handle],
    );
    const settings = {
      visibility: 'public',
      legal: { privacyPolicyUrl: 'https://example.com/privacy' },
      sharing: { title: 'Waitlist test', description: 'An event used by the waitlist tests.' },
      registration,
    };
    const { rows } = await pools.migrator.query<{ slug: string }>(
      `UPDATE eventhub.event SET lifecycle = 'published', settings = $2,
              starts_at = now() + interval '30 days', ends_at = now() + interval '31 days'
        WHERE id = $1 RETURNING slug`,
      [eventId, JSON.stringify(settings)],
    );
    const page = await pools.migrator.query<{ id: string }>(
      `INSERT INTO eventhub.event_page (organization_id, event_id, draft_sections, draft_schema_version,
                                       draft_updated_by, published_revision, published_draft_version)
       VALUES ($1, $2, '[]', 1, $3, 1, 1) RETURNING id`,
      [orgId, eventId, owner.id],
    );
    await pools.migrator.query(
      `INSERT INTO eventhub.page_revision (organization_id, page_id, revision, sections, schema_version,
                                          draft_version, published_by)
       VALUES ($1, $2, 1, '[]', 1, 1, $3)`,
      [orgId, page.rows[0]!.id, owner.id],
    );
    const members: Record<string, FixtureUser> = {};
    for (const role of roles) {
      const u = await createFixtureUser(pools.migrator);
      await addFixtureMembership(pools.migrator, orgId, u.id, role);
      members[role] = u;
    }
    const slug = rows[0]!.slug;
    const register = (body: Record<string, unknown>) =>
      call({
        method: 'POST',
        url: `/v1/public/sites/${handle}/events/${slug}/registrations`,
        payload: { privacyConsent: true, ...body },
      });
    const base = `/v1/organizations/${orgId}/events/${eventId}/registrations`;
    const list = (as = owner) => call({ method: 'GET', url: base, headers: auth(as) });
    const summary = (as = owner) =>
      call({ method: 'GET', url: `${base}/summary`, headers: auth(as) });
    const exportList = (as = owner, payload: object = {}) =>
      call({ method: 'POST', url: `${base}/export`, headers: auth(as), payload });
    return {
      owner,
      orgId,
      eventId,
      handle,
      slug,
      members,
      register,
      list,
      summary,
      base,
      exportList,
    };
  }
  const email = () => `attendee-${randomUUID()}@example.test`;

  /** Registers people directly (the sign-up flow has its own tests). */
  async function people(
    t: { orgId: string; eventId: string },
    statuses: Array<'confirmed' | 'waitlisted' | 'cancelled'>,
  ) {
    const out: Array<{ id: string; email: string }> = [];
    for (const [i, status] of statuses.entries()) {
      const addr = email();
      const { rows } = await pools.migrator.query<{ id: string }>(
        `INSERT INTO eventhub.registration (organization_id, event_id, email, name, status,
                privacy_policy_url, cancelled_at, cancelled_by)
         VALUES ($1, $2, $3, $4, $5, 'https://example.com/privacy',
                 CASE WHEN $5 = 'cancelled' THEN now() END,
                 CASE WHEN $5 = 'cancelled' THEN 'attendee' END)
         RETURNING id`,
        [t.orgId, t.eventId, addr, `Person ${i}`, status],
      );
      out.push({ id: rows[0]!.id, email: addr });
    }
    return out;
  }
  const announcementsUrl = (t: { orgId: string; eventId: string }) =>
    `/v1/organizations/${t.orgId}/events/${t.eventId}/announcements`;
  const send = (
    t: { orgId: string; eventId: string; owner: FixtureUser },
    payload: object,
    as: FixtureUser = t.owner,
    key = `k-${randomUUID()}`,
  ) =>
    call({
      method: 'POST',
      url: announcementsUrl(t),
      headers: { ...auth(as), 'idempotency-key': key },
      payload,
    });
  const list = (t: { orgId: string; eventId: string; owner: FixtureUser }, as = t.owner) =>
    call({ method: 'GET', url: announcementsUrl(t), headers: auth(as) });
  const MESSAGE = {
    subject: 'Venue change',
    body: 'We moved to Hall B.\nDoors open at 08:30.',
    audience: 'registered',
  };
  const announcementMails = (to: string) => mails(to, 'event_announcement');

  it('emails everyone registered, and only them, with where it came from', async () => {
    const t = await publishedEvent({}, ['event_manager']);
    const [a, b, waiting, gone] = await people(t, [
      'confirmed',
      'confirmed',
      'waitlisted',
      'cancelled',
    ]);
    const res = await send(t, MESSAGE, t.members.event_manager);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      subject: 'Venue change',
      audience: 'registered',
      recipients: 2,
      delivered: 0,
      skipped: 0,
      sentBy: t.members.event_manager!.email,
    });
    await drain(() => announcementMails(b!.email).length > 0);
    for (const p of [a!, b!]) {
      const m = announcementMails(p.email);
      expect(m).toHaveLength(1);
      expect(m[0]!.subject).toBe('Fixture event: Venue change');
      expect(m[0]!.text).toContain('We moved to Hall B.\nDoors open at 08:30.');
      expect(m[0]!.text).toContain('to people who signed up for Fixture event');
      expect(m[0]!.text).toContain(`https://${t.handle}.eventhub.example/${t.slug}`);
    }
    expect(announcementMails(waiting!.email)).toHaveLength(0);
    expect(announcementMails(gone!.email)).toHaveLength(0);
    expect((await list(t)).json().data[0]).toMatchObject({ recipients: 2, delivered: 2 });
    // Once delivered, nobody is pending: a late duplicate run would email no one.
    const pending = await pools.worker.query(
      'SELECT * FROM eventhub.announcement_pending($1, $2)',
      [res.json().id, t.orgId],
    );
    expect(pending.rowCount).toBe(0);

    // No attendee details in the audit entry or the outbox event.
    const audit = await pools.migrator.query(
      `SELECT metadata FROM eventhub.audit_event
        WHERE organization_id = $1 AND action = 'event.announcement_sent'`,
      [t.orgId],
    );
    expect(audit.rows[0].metadata).toEqual({
      announcementId: res.json().id,
      audience: 'registered',
      recipients: 2,
    });
    const outbox = await pools.migrator.query(
      `SELECT payload FROM eventhub.outbox_event
        WHERE organization_id = $1 AND event_type = 'announcement.requested'`,
      [t.orgId],
    );
    expect(outbox.rows).toEqual([{ payload: { announcementId: res.json().id } }]);
  });

  it('keeps line breaks, as LF, whatever the browser sent', async () => {
    const t = await publishedEvent();
    const [a] = await people(t, ['confirmed']);
    const res = await send(t, { ...MESSAGE, body: 'Line one\r\nLine two\rLine three' });
    expect(res.json().body).toBe('Line one\nLine two\nLine three');
    await drain(() => announcementMails(a!.email).length > 0);
    expect(announcementMails(a!.email)[0]!.text).toContain('Line one\nLine two\nLine three');
    expect(announcementMails(a!.email)[0]!.text).not.toContain('\r');
  });

  it('can include the waitlist', async () => {
    const t = await publishedEvent();
    const [a, waiting] = await people(t, ['confirmed', 'waitlisted']);
    const res = await send(t, { ...MESSAGE, audience: 'registered_and_waitlist' });
    expect(res.json().recipients).toBe(2);
    await drain(() => announcementMails(waiting!.email).length > 0);
    expect(announcementMails(a!.email)).toHaveLength(1);
    expect(announcementMails(waiting!.email)).toHaveLength(1);
  });

  it('skips someone who cancels before the email goes out', async () => {
    const t = await publishedEvent();
    const [stays, leaves] = await people(t, ['confirmed', 'confirmed']);
    const res = await send(t, MESSAGE);
    expect(res.json().recipients).toBe(2);
    await pools.migrator.query(
      `UPDATE eventhub.registration SET status = 'cancelled', cancelled_at = now(),
              cancelled_by = 'attendee' WHERE id = $1`,
      [leaves!.id],
    );
    await drain(() => announcementMails(stays!.email).length > 0);
    await drain(() => false);
    expect(announcementMails(leaves!.email)).toHaveLength(0);
    expect((await list(t)).json().data[0]).toMatchObject({
      recipients: 2,
      delivered: 1,
      skipped: 1,
    });
  });

  it('a retry after a failure partway does not email anyone twice', async () => {
    const t = await publishedEvent();
    const recipients = await people(t, ['confirmed', 'confirmed', 'confirmed']);
    // Behaves like the provider: one delivery per message ID; the second send fails once.
    const delivered = new Map<string, EmailMessage>();
    let calls = 0;
    const flaky = {
      name: 'flaky',
      send(m: EmailMessage) {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error('provider outage'));
        if (!delivered.has(m.messageId)) delivered.set(m.messageId, m);
        return Promise.resolve();
      },
    };
    const res = await send(t, MESSAGE);
    const p = new OutboxDispatchPublisher(pools.worker, [
      sendAnnouncementConsumer(flaky, { publicSiteUrl: SITE }),
    ]);
    for (let i = 0; i < 5 && delivered.size < 3; i++) {
      // The relay backs off after a failure; make the event due again for the test.
      await pools.migrator.query(
        `UPDATE eventhub.outbox_event SET available_at = now() WHERE organization_id = $1`,
        [t.orgId],
      );
      await relayOnce(pools.worker, p, { batchSize: 100, maxAttempts: 5 });
    }
    expect(calls).toBeGreaterThan(3); // the first attempt failed partway, so it was retried
    expect([...delivered.values()].map((m) => m.to).sort()).toEqual(
      recipients.map((r) => r.email).sort(),
    );
    // One stable message ID per recipient, across attempts.
    expect(new Set(delivered.keys()).size).toBe(3);
    const counts = (await list(t)).json().data.find((x: { id: string }) => x.id === res.json().id);
    expect(counts).toMatchObject({ delivered: 3, skipped: 0 });
  });

  it('validates plain text and a one-line subject', async () => {
    const t = await publishedEvent();
    await people(t, ['confirmed']);
    for (const bad of [
      { ...MESSAGE, subject: 'Line one\nBcc: victim@example.test' },
      { ...MESSAGE, subject: 'Tab\tinside' },
      { ...MESSAGE, subject: '' },
      { ...MESSAGE, subject: 'x'.repeat(151) },
      { ...MESSAGE, body: '' },
      { ...MESSAGE, body: 'x'.repeat(5001) },
      { ...MESSAGE, body: 'Bell \u0007 here' },
      { ...MESSAGE, audience: 'everyone' },
      { ...MESSAGE, html: '<b>hi</b>' },
    ]) {
      const res = await send(t, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await list(t)).json().data).toEqual([]);
  });

  it('allows three per event per day, and needs someone to send to', async () => {
    const t = await publishedEvent();
    expect((await send(t, MESSAGE)).json().error.details.reason).toBe('no_recipients');
    await people(t, ['confirmed']);
    for (let i = 0; i < 3; i++) expect((await send(t, MESSAGE)).statusCode).toBe(201);
    const fourth = await send(t, MESSAGE);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error.details.reason).toBe('announcement_limit');
    // Older ones do not count.
    await pools.migrator.query(
      `UPDATE eventhub.announcement SET created_at = now() - interval '25 hours'
        WHERE organization_id = $1`,
      [t.orgId],
    );
    expect((await send(t, MESSAGE)).statusCode).toBe(201);
    // Archived events are read-only.
    await pools.migrator.query(
      `UPDATE eventhub.event SET lifecycle = 'archived', archived_from = 'ended' WHERE id = $1`,
      [t.eventId],
    );
    expect((await send(t, MESSAGE)).json().error.details.reason).toBe('event_archived');
  });

  it('replays on the same idempotency key without sending twice', async () => {
    const t = await publishedEvent();
    const [a] = await people(t, ['confirmed']);
    const key = `k-${randomUUID()}`;
    const first = await send(t, MESSAGE, t.owner, key);
    const again = await send(t, MESSAGE, t.owner, key);
    expect(again.json().id).toBe(first.json().id);
    await drain(() => announcementMails(a!.email).length > 0);
    await drain(() => false);
    expect(announcementMails(a!.email)).toHaveLength(1);
    expect((await list(t)).json().data).toHaveLength(1);
  });

  it('needs communication.send, and keeps organizations apart', async () => {
    const t = await publishedEvent({}, [
      'viewer',
      'content_editor',
      'registration_manager',
      'analyst',
      'admin',
    ]);
    await people(t, ['confirmed']);
    for (const role of ['viewer', 'content_editor', 'registration_manager', 'analyst']) {
      expect((await send(t, MESSAGE, t.members[role])).statusCode, role).toBe(403);
      expect((await list(t, t.members[role])).statusCode, role).toBe(403);
    }
    expect((await send(t, MESSAGE, t.members.admin)).statusCode).toBe(201);

    const other = await publishedEvent();
    await people(other, ['confirmed']);
    // Another organization's Owner, directly and through their own organization.
    expect((await send(t, MESSAGE, other.owner)).statusCode).toBe(404);
    expect((await list(t, other.owner)).statusCode).toBe(404);
    const viaOwn = await call({
      method: 'POST',
      url: `/v1/organizations/${other.orgId}/events/${t.eventId}/announcements`,
      headers: { ...auth(other.owner), 'idempotency-key': `k-${randomUUID()}` },
      payload: MESSAGE,
    });
    expect(viaOwn.statusCode).toBe(404);
    expect((await list(other)).json().data).toEqual([]);
  });

  it('keeps the worker functions to the worker and to the right organization', async () => {
    const t = await publishedEvent();
    await people(t, ['confirmed']);
    const id = (await send(t, MESSAGE)).json().id as string;
    await expect(
      pools.app.query('SELECT * FROM eventhub.announcement_pending($1, $2)', [id, t.orgId]),
    ).rejects.toThrow(/permission denied/);
    const other = await publishedEvent();
    const wrong = await pools.worker.query('SELECT * FROM eventhub.announcement_pending($1, $2)', [
      id,
      other.orgId,
    ]);
    expect(wrong.rowCount).toBe(0);
    await pools.worker.query('SELECT eventhub.announcement_mark($1, $2, $3, true)', [
      id,
      other.orgId,
      randomUUID(),
    ]);
    const right = await pools.worker.query('SELECT * FROM eventhub.announcement_pending($1, $2)', [
      id,
      t.orgId,
    ]);
    expect(right.rowCount).toBe(1);
  });
});
