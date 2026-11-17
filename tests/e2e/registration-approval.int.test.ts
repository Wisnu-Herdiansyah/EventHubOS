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
import {
  sendRegistrationCancelledConsumer,
  sendRegistrationConfirmationConsumer,
  sendRegistrationDeclinedConsumer,
} from '../../apps/worker/src/consumers/send-registration-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';
import { sendAnnouncementConsumer } from '../../apps/worker/src/consumers/send-announcement.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret
const SITE = 'https://{handle}.eventhub.example';

/** Registration approval (ADR-0064): requests, decisions, withdrawals and what they touch. */
describe('registration approval', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendRegistrationConfirmationConsumer(inbox, { publicSiteUrl: SITE, tokenSecret: SECRET }),
    sendRegistrationCancelledConsumer(inbox),
    sendRegistrationDeclinedConsumer(inbox),
    sendAnnouncementConsumer(inbox, { publicSiteUrl: SITE }),
  ]);
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.73.${Math.floor(++ip / 250)}.${ip % 250}` });
  const mails = (to: string, template?: string) =>
    inbox.sent.filter((m) => m.to === to && (!template || m.template === template));
  async function drain(until: () => boolean) {
    for (let i = 0; i < 30 && !until(); i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    }
  }
  const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });
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
      sharing: { title: 'Approval test', description: 'An event used by the approval tests.' },
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
  const tokenFrom = (text: string) => /#token=([A-Za-z0-9_-]{43})/.exec(text)![1]!;

  const approving = (registration: Record<string, unknown> = {}) =>
    publishedEvent({ approval: true, ...registration }, [
      'registration_manager',
      'viewer',
      'content_editor',
    ]);
  const rows = async (eventId: string) =>
    (
      await pools.migrator.query<{
        id: string;
        email: string;
        status: string;
        decided_at: Date | null;
        decided_by: string | null;
      }>(
        `SELECT id, email, status, decided_at, decided_by FROM eventhub.registration
          WHERE event_id = $1 ORDER BY created_at, id`,
        [eventId],
      )
    ).rows;
  const rowOf = async (eventId: string, addr: string) =>
    (await rows(eventId)).find((r) => r.email === addr);
  const audits = async (orgId: string, action: string) =>
    (
      await pools.migrator.query<{ actor_type: string; metadata: Record<string, unknown> }>(
        `SELECT actor_type, metadata FROM eventhub.audit_event
          WHERE organization_id = $1 AND action = $2 ORDER BY occurred_at`,
        [orgId, action],
      )
    ).rows;
  const leave = (token: string) =>
    call({ method: 'POST', url: '/v1/public/registrations/cancel', payload: { token } });
  type T = Awaited<ReturnType<typeof approving>>;
  const decide = (t: T, id: string, action: 'approve' | 'decline', as: FixtureUser = t.owner) =>
    call({
      method: 'POST',
      url: `${t.base}/${id}/${action}`,
      headers: { ...auth(as), ...idem() },
    });
  /** Asks for a place and returns the request with its withdraw link. */
  async function ask(t: T, name = 'Rae Requester') {
    const addr = email();
    const res = await t.register({ name, email: addr });
    expect(res.statusCode, res.body).toBe(202);
    await drain(() => mails(addr, 'registration_requested').length > 0);
    const mail = mails(addr, 'registration_requested')[0]!;
    const row = (await rowOf(t.eventId, addr))!;
    return { addr, id: row.id, token: tokenFrom(mail.text), mail };
  }

  describe('asking for a place', () => {
    it('a sign-up waits as a request, answered exactly as an ordinary sign-up', async () => {
      const t = await approving({ capacity: 10 });
      const plain = await publishedEvent({ capacity: 10 });
      const a = await t.register({ name: 'Rae', email: email() });
      const b = await plain.register({ name: 'Rae', email: email() });
      // No hint of approval in the response: it is the same as anywhere else.
      expect(a.statusCode).toBe(202);
      expect(a.body).toBe(b.body);

      const r = await ask(t);
      expect((await rowOf(t.eventId, r.addr))!.status).toBe('pending');
      expect(r.mail.subject).toMatch(/^Request received: /);
      expect(r.mail.text).toContain('The organizer reviews each request.');
      expect(r.mail.text).toContain("you don't have a ticket yet");
      expect(r.mail.text).toContain('Withdraw your request:');
      expect(r.mail.text).not.toContain('/ticket#');
      expect(mails(r.addr, 'registration_confirmed')).toHaveLength(0);
      expect((await audits(t.orgId, 'registration.requested')).at(-1)).toMatchObject({
        actor_type: 'system',
        metadata: { eventId: t.eventId, source: 'public_site' },
      });
    });

    it('asking again re-sends the request email, and creates nothing new', async () => {
      const t = await approving();
      const r = await ask(t);
      const again = await t.register({ name: 'Rae Again', email: r.addr });
      expect(again.statusCode).toBe(202);
      await drain(() => mails(r.addr, 'registration_requested').length > 1);
      expect(mails(r.addr, 'registration_requested')[1]!.text).toContain(
        "You've already asked for a place",
      );
      expect((await rows(t.eventId)).filter((x) => x.email === r.addr)).toHaveLength(1);
    });

    it('requests hold no seat; a full event refuses new requests', async () => {
      const t = await approving({ capacity: 1 });
      const r1 = await ask(t);
      const r2 = await ask(t);
      // Two requests on a one-seat event: still open, nobody holds the seat.
      expect((await t.summary()).json()).toMatchObject({
        confirmed: 0,
        pending: 2,
        approval: true,
        state: 'open',
      });
      expect((await decide(t, r1.id, 'approve')).statusCode).toBe(200);
      expect((await t.summary()).json()).toMatchObject({ confirmed: 1, pending: 1, state: 'full' });
      const late = await t.register({ name: 'Late', email: email() });
      expect(late.statusCode).toBe(409);
      expect(late.json().error.details.reason).toBe('event_full');
      void r2;
    });

    it('without the setting nothing changes: sign-ups are confirmed at once', async () => {
      const t = await publishedEvent({ capacity: 5 });
      const addr = email();
      await t.register({ name: 'Direct', email: addr });
      expect((await rowOf(t.eventId, addr))!.status).toBe('confirmed');
      expect((await t.summary()).json()).toMatchObject({ approval: false, pending: 0 });
    });

    it('the older sign-up function follows the same rules', async () => {
      const t = await approving();
      const addr = email();
      const { rows: out } = await pools.app.query<{ out_outcome: string }>(
        'SELECT out_outcome FROM eventhub.public_register($1, $2, $3, $4)',
        [t.handle, t.slug, addr, 'Old Path'],
      );
      expect(out[0]!.out_outcome).toBe('requested');
      expect((await rowOf(t.eventId, addr))!.status).toBe('pending');
    });
  });

  describe('deciding', () => {
    it('approving confirms the request and emails the ticket', async () => {
      const t = await approving({ capacity: 5 });
      const r = await ask(t);
      const res = await decide(t, r.id, 'approve', t.members.registration_manager);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ id: r.id, status: 'confirmed' });
      expect(res.json().decidedAt).toEqual(expect.any(String));
      const row = (await rowOf(t.eventId, r.addr))!;
      expect(row.status).toBe('confirmed');
      expect(row.decided_by).toBe(t.members.registration_manager!.id);
      await drain(() => mails(r.addr, 'registration_approved').length > 0);
      const mail = mails(r.addr, 'registration_approved')[0]!;
      expect(mail.subject).toMatch(/^Your request is approved: /);
      expect(mail.text).toContain('the organizer approved your request');
      expect(mail.text).toContain(`/ticket#id=${r.id}`);
      expect(mail.text).toContain('Cancel your registration:');
      expect(await audits(t.orgId, 'registration.approved')).toEqual([
        { actor_type: 'user', metadata: { eventId: t.eventId, overCapacity: false } },
      ]);
      // The request email's withdraw link now cancels the registration (one link per person).
      const newLink = tokenFrom(mail.text);
      expect((await leave(newLink)).json()).toMatchObject({
        status: 'cancelled',
        wasPending: false,
        wasWaitlisted: false,
      });
    });

    it('approving beyond capacity is allowed, and recorded as such', async () => {
      const t = await approving({ capacity: 1 });
      const a = await ask(t);
      const b = await ask(t);
      await decide(t, a.id, 'approve');
      // Filling the last seat exactly is not over capacity.
      expect((await audits(t.orgId, 'registration.approved'))[0]!.metadata).toEqual({
        eventId: t.eventId,
        overCapacity: false,
      });
      const res = await decide(t, b.id, 'approve');
      expect(res.statusCode).toBe(200);
      expect((await audits(t.orgId, 'registration.approved')).at(-1)!.metadata).toEqual({
        eventId: t.eventId,
        overCapacity: true,
      });
      expect((await t.summary()).json()).toMatchObject({ confirmed: 2, capacity: 1 });
    });

    it('declining tells the person, gives no reason, and keeps the address out', async () => {
      const t = await approving();
      const r = await ask(t);
      const res = await decide(t, r.id, 'decline');
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('declined');
      await drain(() => mails(r.addr, 'registration_declined').length > 0);
      const mail = mails(r.addr, 'registration_declined')[0]!;
      expect(mail.subject).toMatch(/^About your request: /);
      expect(mail.text).toContain("isn't able to offer you a place this time");
      expect(await audits(t.orgId, 'registration.declined')).toEqual([
        { actor_type: 'user', metadata: { eventId: t.eventId } },
      ]);
      // Asking again: the same 202, no new request, no email.
      const before = inbox.sent.filter((m) => m.to === r.addr).length;
      const again = await t.register({ name: 'Rae Again', email: r.addr });
      expect(again.statusCode).toBe(202);
      for (let i = 0; i < 3; i++)
        await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
      expect(inbox.sent.filter((m) => m.to === r.addr)).toHaveLength(before);
      expect(
        (await rows(t.eventId)).filter((x) => x.email === r.addr).map((x) => x.status),
      ).toEqual(['declined']);
      // The withdraw link from the request email no longer works.
      expect((await leave(r.token)).statusCode).toBe(400);
    });

    it('each request is decided once; other entries cannot be approved or declined', async () => {
      const t = await approving();
      const r = await ask(t);
      expect((await decide(t, r.id, 'approve')).statusCode).toBe(200);
      for (const action of ['approve', 'decline'] as const) {
        const res = await decide(t, r.id, action);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.details.reason).toBe('not_pending');
      }
      const d = await ask(t);
      await decide(t, d.id, 'decline');
      expect((await decide(t, d.id, 'approve')).json().error.details.reason).toBe('not_pending');
      expect((await decide(t, randomUUID(), 'approve')).statusCode).toBe(404);
    });

    it('a repeated decision with the same key returns the same answer and sends one email', async () => {
      const t = await approving();
      const r = await ask(t);
      const headers = { ...auth(t.owner), ...idem() };
      const url = `${t.base}/${r.id}/approve`;
      const a = await call({ method: 'POST', url, headers });
      const b = await call({ method: 'POST', url, headers });
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(b.json()).toEqual(a.json());
      await drain(() => mails(r.addr, 'registration_approved').length > 0);
      for (let i = 0; i < 3; i++)
        await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
      expect(mails(r.addr, 'registration_approved')).toHaveLength(1);
    });

    it('needs registration.manage; other organizations find nothing', async () => {
      const t = await approving();
      const r = await ask(t);
      for (const role of ['viewer', 'content_editor'] as const) {
        for (const action of ['approve', 'decline'] as const) {
          expect((await decide(t, r.id, action, t.members[role])).statusCode, role).toBe(403);
        }
      }
      const other = await approving();
      expect((await decide(t, r.id, 'approve', other.owner)).statusCode).toBe(404);
      // Their own event's address with this request's ID finds nothing either.
      const crossed = await call({
        method: 'POST',
        url: `${other.base}/${r.id}/approve`,
        headers: { ...auth(other.owner), ...idem() },
      });
      expect(crossed.statusCode).toBe(404);
      expect((await rowOf(t.eventId, r.addr))!.status).toBe('pending');
    });

    it('requests are not cancelled or checked in: they are decided', async () => {
      const t = await approving();
      const r = await ask(t);
      const cancel = await call({
        method: 'POST',
        url: `${t.base}/${r.id}/cancel`,
        headers: { ...auth(t.owner), ...idem() },
      });
      expect(cancel.json().error.details.reason).toBe('registration_pending');
      const checkIn = await call({
        method: 'POST',
        url: `${t.base}/${r.id}/check-in`,
        headers: { ...auth(t.members.registration_manager!), ...idem() },
      });
      expect(checkIn.statusCode).toBe(409);
      expect(checkIn.json().error.details.reason).toBe('registration_pending');
      await decide(t, r.id, 'decline');
      const declinedCancel = await call({
        method: 'POST',
        url: `${t.base}/${r.id}/cancel`,
        headers: { ...auth(t.owner), ...idem() },
      });
      expect(declinedCancel.json().error.details.reason).toBe('registration_declined');
      const declinedCheckIn = await call({
        method: 'POST',
        url: `${t.base}/${r.id}/check-in`,
        headers: { ...auth(t.members.registration_manager!), ...idem() },
      });
      expect(declinedCheckIn.json().error.details.reason).toBe('registration_declined');
    });
  });

  describe('withdrawing and listing', () => {
    it('the link in the request email withdraws it, and says so', async () => {
      const t = await approving();
      const r = await ask(t);
      const res = await leave(r.token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'cancelled',
        wasPending: true,
        wasWaitlisted: false,
      });
      expect((await rowOf(t.eventId, r.addr))!.status).toBe('cancelled');
      await drain(() => mails(r.addr, 'registration_request_withdrawn').length > 0);
      expect(mails(r.addr, 'registration_request_withdrawn')[0]!.text).toContain(
        "You've withdrawn your request",
      );
      expect((await decide(t, r.id, 'approve')).json().error.details.reason).toBe('not_pending');
      // Having withdrawn, the person may ask again.
      const again = await t.register({ name: 'Back Again', email: r.addr });
      expect(again.statusCode).toBe(202);
      expect(
        (await rows(t.eventId)).filter((x) => x.email === r.addr).map((x) => x.status),
      ).toEqual(['cancelled', 'pending']);
    });

    it('the organizer sees requests oldest first, and filters by each state', async () => {
      const t = await approving();
      // Several, so that an order other than joining order cannot match by chance.
      const askers = [];
      for (const n of ['First', 'Second', 'Third', 'Fourth', 'Fifth'])
        askers.push(await ask(t, `${n} Asker`));
      const third = await ask(t, 'Declined Asker');
      await decide(t, third.id, 'decline');
      const list = (status: string) =>
        call({ method: 'GET', url: `${t.base}?status=${status}`, headers: auth(t.owner) });
      expect((await list('pending')).json().data.map((x: { id: string }) => x.id)).toEqual(
        askers.map((a) => a.id),
      );
      const declined = (await list('declined')).json().data;
      expect(declined.map((x: { id: string }) => x.id)).toEqual([third.id]);
      expect(declined[0].decidedAt).toEqual(expect.any(String));
      expect((await t.summary()).json()).toMatchObject({ pending: 5, confirmed: 0 });
    });
  });

  describe('settings and event cancellation', () => {
    it('an event cannot both approve sign-ups and take a waitlist', async () => {
      const t = await approving({ capacity: 5 });
      const url = `/v1/organizations/${t.orgId}/events/${t.eventId}`;
      const current = (await call({ method: 'GET', url, headers: auth(t.owner) })).json<{
        version: number;
        settings: Record<string, unknown>;
      }>();
      const res = await call({
        method: 'PATCH',
        url,
        headers: { ...auth(t.owner), ...idem() },
        payload: {
          expectedVersion: current.version,
          settings: { registration: { capacity: 5, approval: true, waitlist: true } },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json().error.details)).toContain('settings.registration.approval');
    });

    it('cancelling the event tells people waiting for a decision, who can then not be approved', async () => {
      const t = await approving({ capacity: 5 });
      const seated = await ask(t, 'Seated Person');
      await decide(t, seated.id, 'approve');
      const waitingForUs = await ask(t, 'Still Waiting');
      const withdrawn = await ask(t, 'Changed Mind');
      await leave(withdrawn.token);
      const url = `/v1/organizations/${t.orgId}/events/${t.eventId}`;
      const current = (await call({ method: 'GET', url, headers: auth(t.owner) })).json<{
        version: number;
      }>();
      const res = await call({
        method: 'POST',
        url: `${url}/cancel`,
        headers: { ...auth(t.owner), ...idem() },
        payload: {
          expectedVersion: current.version,
          reason: 'The venue flooded.',
          notifyAttendees: true,
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      await drain(
        () =>
          mails(seated.addr, 'event_announcement').length > 0 &&
          mails(waitingForUs.addr, 'event_announcement').length > 0,
      );
      expect(mails(waitingForUs.addr, 'event_announcement')[0]!.text).toContain(
        'The venue flooded.',
      );
      expect(mails(seated.addr, 'event_announcement')).toHaveLength(1);
      expect(mails(withdrawn.addr, 'event_announcement')).toHaveLength(0);
      for (const action of ['approve', 'decline'] as const) {
        const d = await decide(t, waitingForUs.id, action);
        expect(d.statusCode).toBe(409);
        expect(d.json().error.details.reason).toBe('event_cancelled');
      }
    });

    it('an ordinary announcement to registered and waitlist does not reach requests', async () => {
      const t = await approving({ capacity: 5 });
      const seated = await ask(t);
      await decide(t, seated.id, 'approve');
      const pending = await ask(t);
      const res = await call({
        method: 'POST',
        url: `/v1/organizations/${t.orgId}/events/${t.eventId}/announcements`,
        headers: { ...auth(t.owner), ...idem() },
        payload: {
          subject: 'Parking update',
          body: 'Use the north entrance.',
          audience: 'registered_and_waitlist',
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      await drain(() => mails(seated.addr, 'event_announcement').length > 0);
      expect(mails(seated.addr, 'event_announcement')).toHaveLength(1);
      expect(mails(pending.addr, 'event_announcement')).toHaveLength(0);
    });
  });

  it('decisions can only be recorded by the API role through tenant rules', async () => {
    const t = await approving();
    const r = await ask(t);
    await expect(
      pools.worker.query(`UPDATE eventhub.registration SET status = 'confirmed' WHERE id = $1`, [
        r.id,
      ]),
    ).rejects.toThrow(/permission denied/);
    // Without the tenant set, the API role sees no rows to change.
    const changed = await pools.app.query(
      `UPDATE eventhub.registration SET decided_at = now() WHERE id = $1`,
      [r.id],
    );
    expect(changed.rowCount).toBe(0);
  });
});
