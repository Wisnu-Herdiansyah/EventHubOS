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

/** Announcements to requests waiting for approval (ADR-0068). */
describe('announcements to requests', () => {
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
    app.inject({ ...opts, remoteAddress: `10.76.${Math.floor(++ip / 250)}.${ip % 250}` });
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
  type T = Awaited<ReturnType<typeof publishedEvent>>;
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

  const reviewing = () =>
    publishedEvent({ capacity: 10, approval: true }, [
      'event_manager',
      'registration_manager',
      'viewer',
    ]);
  const announce = (
    t: T,
    audience: string,
    as: FixtureUser = t.owner,
    subject = 'Decisions by Friday',
  ) =>
    call({
      method: 'POST',
      url: `/v1/organizations/${t.orgId}/events/${t.eventId}/announcements`,
      headers: { ...auth(as), ...idem() },
      payload: {
        subject,
        body: 'Thanks for asking. We will decide on every request by Friday.',
        audience,
      },
    });
  const announcementAudits = async (orgId: string) =>
    (await audits(orgId, 'event.announcement_sent')).map((a) => a.metadata);
  const announced = (to: string) => mails(to, 'event_announcement');

  it('reaches only the people waiting for a decision', async () => {
    const t = await reviewing();
    const waiting = [await ask(t, 'Wanda Waiting'), await ask(t, 'Walt Waiting')];
    const seated = await ask(t, 'Sam Seated');
    await decide(t, seated.id, 'approve');
    const refused = await ask(t, 'Rita Refused');
    await decide(t, refused.id, 'decline');
    const gone = await ask(t, 'Gus Gone');
    await leave(gone.token);

    const res = await announce(t, 'requests');
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ audience: 'requests', recipients: 2 });
    await drain(() => waiting.every((w) => announced(w.addr).length > 0));
    for (let i = 0; i < 3; i++)
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    for (const w of waiting) {
      const mail = announced(w.addr);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toMatch(/: Decisions by Friday$/);
      expect(mail[0]!.text).toContain('We will decide on every request by Friday.');
    }
    for (const other of [seated, refused, gone]) expect(announced(other.addr)).toHaveLength(0);
    expect((await announcementAudits(t.orgId)).at(-1)).toMatchObject({
      audience: 'requests',
      recipients: 2,
    });
    // The organizer's list shows the group it went to.
    const list = await call({
      method: 'GET',
      url: `/v1/organizations/${t.orgId}/events/${t.eventId}/announcements`,
      headers: auth(t.owner),
    });
    expect(list.json().data[0]).toMatchObject({ audience: 'requests', delivered: 2 });
  });

  it('the other audiences still leave requests out', async () => {
    const t = await reviewing();
    const r = await ask(t);
    const seated = await ask(t, 'Sam Seated');
    await decide(t, seated.id, 'approve');
    for (const audience of ['registered', 'registered_and_waitlist']) {
      const res = await announce(t, audience, t.owner, `To ${audience}`);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().recipients).toBe(1);
    }
    await drain(() => announced(seated.addr).length >= 2);
    for (let i = 0; i < 3; i++)
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    expect(announced(r.addr)).toHaveLength(0);
  });

  it('a request decided or withdrawn before the email goes out is skipped', async () => {
    const t = await reviewing();
    const stays = await ask(t, 'Still Waiting');
    const approved = await ask(t, 'Approved Meanwhile');
    const declined = await ask(t, 'Declined Meanwhile');
    const withdrew = await ask(t, 'Withdrew Meanwhile');
    const res = await announce(t, 'requests');
    expect(res.json().recipients).toBe(4);
    // Before the worker runs, three of them stop waiting.
    await decide(t, approved.id, 'approve');
    await decide(t, declined.id, 'decline');
    await leave(withdrew.token);
    await drain(() => announced(stays.addr).length > 0);
    for (let i = 0; i < 3; i++)
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    expect(announced(stays.addr)).toHaveLength(1);
    for (const p of [approved, declined, withdrew]) expect(announced(p.addr)).toHaveLength(0);
    const list = await call({
      method: 'GET',
      url: `/v1/organizations/${t.orgId}/events/${t.eventId}/announcements`,
      headers: auth(t.owner),
    });
    expect(list.json().data[0]).toMatchObject({ recipients: 4, delivered: 1, skipped: 3 });
  });

  it('with no requests waiting, nothing is sent', async () => {
    const t = await reviewing();
    const r = await ask(t);
    await decide(t, r.id, 'approve');
    const res = await announce(t, 'requests');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      message: 'Nobody is waiting for approval.',
      details: { reason: 'no_recipients' },
    });
    expect(await announcementAudits(t.orgId)).toHaveLength(0);
    // An unknown audience is refused.
    expect((await announce(t, 'everyone')).statusCode).toBe(400);
  });

  it('counts towards the daily limit like any announcement', async () => {
    const t = await reviewing();
    await ask(t);
    for (let i = 0; i < 3; i++) {
      expect((await announce(t, 'requests', t.owner, `Update ${i}`)).statusCode).toBe(201);
    }
    const fourth = await announce(t, 'requests', t.owner, 'One more');
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error.details.reason).toBe('announcement_limit');
  });

  it('needs communication.send; other organizations reach nobody', async () => {
    const t = await reviewing();
    const r = await ask(t);
    for (const role of ['registration_manager', 'viewer'] as const) {
      expect((await announce(t, 'requests', t.members[role])).statusCode, role).toBe(403);
    }
    expect((await announce(t, 'requests', t.members.event_manager)).statusCode).toBe(201);

    const other = await reviewing();
    const theirs = await ask(other, 'Their Request');
    // Another organization's owner at this event's address: refused.
    expect((await announce(t, 'requests', other.owner)).statusCode).toBe(404);
    // Their own announcement reaches their requests, never this organization's.
    const own = await announce(other, 'requests');
    expect(own.json().recipients).toBe(1);
    await drain(() => announced(theirs.addr).length > 0 && announced(r.addr).length > 0);
    for (let i = 0; i < 3; i++)
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    expect(announced(r.addr)).toHaveLength(1);
    expect(announced(theirs.addr)).toHaveLength(1);
  });

  it('the database accepts the new audience and still refuses anything else', async () => {
    const t = await reviewing();
    for (const audience of ['registered', 'registered_and_waitlist', 'requests']) {
      await pools.migrator.query(
        `INSERT INTO eventhub.announcement (organization_id, event_id, subject, body, audience, created_by)
         VALUES ($1, $2, 'S', 'B', $3, $4)`,
        [t.orgId, t.eventId, audience, t.owner.id],
      );
    }
    await expect(
      pools.migrator.query(
        `INSERT INTO eventhub.announcement (organization_id, event_id, subject, body, audience, created_by)
         VALUES ($1, $2, 'S', 'B', 'everyone', $3)`,
        [t.orgId, t.eventId, t.owner.id],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
