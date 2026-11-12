import { randomUUID } from 'node:crypto';
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
import { sendAnnouncementConsumer } from '../../apps/worker/src/consumers/send-announcement.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

/** Event cancellation (ADR-0050). */
describe('event cancellation', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendAnnouncementConsumer(inbox, { publicSiteUrl: 'https://{handle}.eventhub.example' }),
  ]);
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.50.${Math.floor(++ip / 250)}.${ip % 250}` });
  const auth = (u: FixtureUser) => ({ authorization: `Bearer ${u.token}` });
  const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });
  const relay = async () => {
    for (let i = 0; i < 3; i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 200, maxAttempts: 5 });
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

  /** A published public event with one confirmed, one waitlisted and one cancelled sign-up. */
  async function publishedEvent(roles: string[] = []) {
    const owner = await createFixtureUser(pools.migrator);
    const orgId = await createFixtureOrganization(pools.migrator, owner.id);
    const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
    const handle = `x-${randomUUID().slice(0, 8)}`;
    await pools.migrator.query(
      'UPDATE eventhub.organization SET public_handle = $2 WHERE id = $1',
      [orgId, handle],
    );
    const members: Record<string, FixtureUser> = {};
    for (const role of roles) {
      const u = await createFixtureUser(pools.migrator);
      await addFixtureMembership(pools.migrator, orgId, u.id, role);
      members[role] = u;
    }
    await pools.migrator.query(
      `UPDATE eventhub.event
          SET lifecycle = 'published',
              starts_at = now() + interval '30 days', ends_at = now() + interval '31 days',
              settings = settings || jsonb_build_object(
                'visibility', 'public',
                'legal', jsonb_build_object('privacyPolicyUrl', 'https://example.com/privacy'),
                'registration', jsonb_build_object('capacity', 1, 'waitlist', true))
        WHERE id = $1`,
      [eventId],
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
    const people = {
      confirmed: `confirmed-${randomUUID()}@example.test`,
      waiting: `waiting-${randomUUID()}@example.test`,
      gone: `gone-${randomUUID()}@example.test`,
    };
    for (const [email, status] of [
      [people.confirmed, 'confirmed'],
      [people.waiting, 'waitlisted'],
      [people.gone, 'cancelled'],
    ] as const) {
      await pools.migrator.query(
        `INSERT INTO eventhub.registration (organization_id, event_id, email, name, status,
                                           privacy_policy_url, cancelled_at, cancelled_by)
         VALUES ($1, $2, $3, 'Someone', $4, 'https://example.com/privacy',
                 CASE WHEN $4 = 'cancelled' THEN now() END,
                 CASE WHEN $4 = 'cancelled' THEN 'attendee' END)`,
        [orgId, eventId, email, status],
      );
    }
    const slug = (
      await pools.migrator.query<{ slug: string }>(
        'SELECT slug FROM eventhub.event WHERE id = $1',
        [eventId],
      )
    ).rows[0]!.slug;
    const evtUrl = `/v1/organizations/${orgId}/events/${eventId}`;
    const version = async () =>
      (await call({ method: 'GET', url: evtUrl, headers: auth(owner) })).json<{
        version: number;
      }>().version;
    const cancel = async (
      payload: Record<string, unknown> = {},
      as: FixtureUser = owner,
      headers: Record<string, string> = idem(),
    ) =>
      call({
        method: 'POST',
        url: `${evtUrl}/cancel`,
        headers: { ...auth(as), ...headers },
        payload: {
          expectedVersion: await version(),
          reason: 'The venue flooded.',
          notifyAttendees: true,
          ...payload,
        },
      });
    const publicPage = () =>
      call({ method: 'GET', url: `/v1/public/sites/${handle}/events/${slug}` });
    const calendar = () =>
      call({ method: 'GET', url: `/v1/public/sites/${handle}/events/${slug}/calendar` });
    const register = () =>
      call({
        method: 'POST',
        url: `/v1/public/sites/${handle}/events/${slug}/registrations`,
        payload: {
          name: 'Late Comer',
          email: `late-${randomUUID()}@example.test`,
          privacyConsent: true,
        },
      });
    const mailsTo = (email: string) => inbox.sent.filter((m) => m.to === email);
    return {
      owner,
      orgId,
      eventId,
      handle,
      slug,
      members,
      people,
      evtUrl,
      version,
      cancel,
      publicPage,
      calendar,
      register,
      mailsTo,
    };
  }

  it('cancels a published event: final, shown publicly, in the calendar file, and audited', async () => {
    const t = await publishedEvent();
    const before = (await t.calendar()).json();
    expect(before.cancelled).toBe(false);
    const res = await t.cancel({ reason: '  The venue flooded.\r\nSorry!  ' });
    expect(res.statusCode, res.body).toBe(200);
    const event = res.json();
    expect(event.lifecycle).toBe('published');
    expect(event.cancellation).toEqual({
      cancelledAt: expect.any(String),
      reason: 'The venue flooded.\nSorry!',
    });
    const page = (await t.publicPage()).json();
    expect(page.cancellation).toEqual({
      cancelledAt: event.cancellation.cancelledAt,
      reason: 'The venue flooded.\nSorry!',
    });
    expect(page.registration.state).toBe('cancelled');
    const after = (await t.calendar()).json();
    expect(after).toMatchObject({ cancelled: true, uid: before.uid });
    expect(after.sequence).toBeGreaterThan(before.sequence);
    const audit = await pools.migrator.query<{ action: string; metadata: unknown }>(
      `SELECT action, metadata FROM eventhub.audit_event
        WHERE organization_id = $1 AND action IN ('event.cancelled', 'event.announcement_sent')
        ORDER BY occurred_at, action`,
      [t.orgId],
    );
    expect(audit.rows).toEqual([
      {
        action: 'event.announcement_sent',
        metadata: {
          announcementId: expect.any(String),
          audience: 'registered_and_waitlist',
          recipients: 2,
          purpose: 'cancellation',
        },
      },
      { action: 'event.cancelled', metadata: { lifecycle: 'published', notified: 2 } },
    ]);
  });

  it('emails everyone registered or waiting, once, with the reason; not people who left', async () => {
    const t = await publishedEvent();
    expect((await t.cancel()).statusCode).toBe(200);
    await relay();
    for (const email of [t.people.confirmed, t.people.waiting]) {
      const mails = t.mailsTo(email);
      expect(mails, email).toHaveLength(1);
      expect(mails[0]!.subject).toMatch(/: This event is cancelled$/);
      expect(mails[0]!.text).toContain('The venue flooded.');
      expect(mails[0]!.text).toContain('Please don’t come to the venue.');
    }
    expect(t.mailsTo(t.people.gone)).toEqual([]);
    // The waitlist sweep has nothing left to tell them (ADR-0038).
    const sweep = await pools.worker.query(
      'SELECT out_registration_id FROM eventhub.waitlist_closing(500) WHERE out_organization_id = $1',
      [t.orgId],
    );
    expect(sweep.rows).toEqual([]);
  });

  it('sends nothing when the organizer chooses not to email', async () => {
    const t = await publishedEvent();
    expect((await t.cancel({ notifyAttendees: false })).statusCode).toBe(200);
    await relay();
    expect(t.mailsTo(t.people.confirmed)).toEqual([]);
    const n = await pools.migrator.query(
      'SELECT 1 FROM eventhub.announcement WHERE organization_id = $1',
      [t.orgId],
    );
    expect(n.rows).toEqual([]);
  });

  it('is not held back by the daily announcement limit', async () => {
    const t = await publishedEvent();
    for (let i = 0; i < 3; i++) {
      const sent = await call({
        method: 'POST',
        url: `${t.evtUrl}/announcements`,
        headers: { ...auth(t.owner), ...idem() },
        payload: { subject: `Update ${i}`, body: 'News.', audience: 'registered' },
      });
      expect(sent.statusCode, sent.body).toBe(201);
    }
    expect((await t.cancel()).statusCode).toBe(200);
  });

  it('closes registration and the waitlist for good', async () => {
    const t = await publishedEvent();
    expect((await t.register()).statusCode).toBe(202); // joins the waitlist
    await t.cancel();
    const refused = await t.register();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details.reason).toBe('event_cancelled');
    // A freed seat does not promote anyone.
    const confirmed = await pools.migrator.query<{ id: string }>(
      `SELECT id FROM eventhub.registration WHERE event_id = $1 AND status = 'confirmed'`,
      [t.eventId],
    );
    const freed = await call({
      method: 'POST',
      url: `${t.evtUrl}/registrations/${confirmed.rows[0]!.id}/cancel`,
      headers: { ...auth(t.owner), ...idem() },
      payload: {},
    });
    expect(freed.statusCode, freed.body).toBeLessThan(300);
    const promoted = await pools.migrator.query(
      `SELECT 1 FROM eventhub.registration WHERE event_id = $1 AND promoted_at IS NOT NULL`,
      [t.eventId],
    );
    expect(promoted.rows).toEqual([]);
    const summary = await call({
      method: 'GET',
      url: `${t.evtUrl}/registrations/summary`,
      headers: auth(t.owner),
    });
    expect(summary.json().state).toBe('cancelled');
  });

  it('is final: no second cancellation and no more edits', async () => {
    const t = await publishedEvent();
    await t.cancel();
    const again = await t.cancel();
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details.reason).toBe('event_cancelled');
    const edit = await call({
      method: 'PATCH',
      url: t.evtUrl,
      headers: { ...auth(t.owner), ...idem() },
      payload: { expectedVersion: await t.version(), name: 'Back on' },
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.details.reason).toBe('event_cancelled');
    // A copy is a new event, not cancelled.
    const copy = await call({
      method: 'POST',
      url: `${t.evtUrl}/duplicate`,
      headers: { ...auth(t.owner), ...idem() },
      payload: {
        name: 'Rescheduled',
        slug: `re-${randomUUID().slice(0, 8)}`,
        startsAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
      },
    });
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json().cancellation).toBeNull();
  });

  it('only cancels events that are announced and not over', async () => {
    const t = await publishedEvent();
    for (const lifecycle of ['draft', 'ended']) {
      await pools.migrator.query('UPDATE eventhub.event SET lifecycle = $2 WHERE id = $1', [
        t.eventId,
        lifecycle,
      ]);
      const res = await t.cancel();
      expect(res.statusCode, lifecycle).toBe(409);
      expect(res.json().error.details.reason).toBe('not_cancellable');
    }
    for (const lifecycle of ['scheduled', 'live']) {
      const u = await publishedEvent();
      await pools.migrator.query('UPDATE eventhub.event SET lifecycle = $2 WHERE id = $1', [
        u.eventId,
        lifecycle,
      ]);
      expect((await u.cancel({ notifyAttendees: false })).statusCode, lifecycle).toBe(200);
    }
  });

  it('validates input, version and idempotency key', async () => {
    const t = await publishedEvent();
    for (const bad of [
      { reason: '   ' },
      { reason: 'x'.repeat(2001) },
      { notifyAttendees: 'yes' },
    ]) {
      expect((await t.cancel(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await t.cancel({ expectedVersion: 999 })).statusCode).toBe(409);
    expect((await t.cancel({}, t.owner, {})).statusCode).toBe(400);
    // A retry with the same key replays the first answer and cancels once.
    const key = idem();
    const same = { expectedVersion: await t.version() };
    const first = await t.cancel(same, t.owner, key);
    const second = await t.cancel(same, t.owner, key);
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const n = await pools.migrator.query(
      `SELECT 1 FROM eventhub.audit_event WHERE organization_id = $1 AND action = 'event.cancelled'`,
      [t.orgId],
    );
    expect(n.rows).toHaveLength(1);
  });

  it('needs event.publish; other organizations get 404', async () => {
    const t = await publishedEvent(['event_manager', 'registration_manager', 'viewer']);
    for (const role of ['registration_manager', 'viewer']) {
      expect((await t.cancel({}, t.members[role])).statusCode, role).toBe(403);
    }
    const other = await publishedEvent();
    expect((await t.cancel({}, other.owner)).statusCode).toBe(404);
    expect((await t.publicPage()).json().cancellation).toBeNull();
    expect((await t.cancel({}, t.members.event_manager)).statusCode).toBe(200);
    // Nothing leaked to the other organization.
    expect((await other.publicPage()).json().cancellation).toBeNull();
  });

  it('keeps the cancellation off pages that are not public', async () => {
    const t = await publishedEvent();
    await t.cancel({ notifyAttendees: false });
    await pools.migrator.query(
      `UPDATE eventhub.event SET settings = settings || '{"visibility":"private"}' WHERE id = $1`,
      [t.eventId],
    );
    const rows = await pools.app.query('SELECT * FROM eventhub.public_event_cancellation($1, $2)', [
      t.handle,
      t.slug,
    ]);
    expect(rows.rows).toEqual([]);
    await expect(
      pools.worker.query('SELECT * FROM eventhub.public_event_cancellation($1, $2)', ['x', 'y']),
    ).rejects.toThrow(/permission denied/);
  });
});
