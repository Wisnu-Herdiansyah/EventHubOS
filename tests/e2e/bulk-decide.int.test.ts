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

/** Deciding several requests at once (ADR-0066), on top of registration approval (ADR-0064). */
describe('bulk decisions', () => {
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
    app.inject({ ...opts, remoteAddress: `10.74.${Math.floor(++ip / 250)}.${ip % 250}` });
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

  const decideMany = (
    t: T,
    decision: 'approve' | 'decline',
    registrationIds: string[],
    as: FixtureUser = t.owner,
    headers: Record<string, string> = idem(),
  ) =>
    call({
      method: 'POST',
      url: `${t.base}/decide`,
      headers: { ...auth(as), ...headers },
      payload: { decision, registrationIds },
    });
  const settle = async () => {
    for (let i = 0; i < 3; i++)
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
  };

  it('approves several requests in one step; each is emailed its ticket and audited', async () => {
    const t = await approving({ capacity: 10 });
    const people = [await ask(t, 'Ann'), await ask(t, 'Ben'), await ask(t, 'Cat')];
    const left = await ask(t, 'Dee');
    const res = await decideMany(
      t,
      'approve',
      people.map((p) => p.id),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      decision: 'approve',
      decided: 3,
      results: people.map((p) => ({ registrationId: p.id, result: 'decided' })),
    });
    for (const p of people) {
      const row = (await rowOf(t.eventId, p.addr))!;
      expect(row.status).toBe('confirmed');
      expect(row.decided_by).toBe(t.owner.id);
      expect(row.decided_at).not.toBeNull();
    }
    // The one not listed is untouched.
    expect((await rowOf(t.eventId, left.addr))!.status).toBe('pending');
    await drain(() => people.every((p) => mails(p.addr, 'registration_approved').length > 0));
    await settle();
    for (const p of people) {
      expect(mails(p.addr, 'registration_approved')).toHaveLength(1);
      expect(mails(p.addr, 'registration_approved')[0]!.text).toContain('/ticket#');
    }
    expect(mails(left.addr, 'registration_approved')).toHaveLength(0);
    const audit = await audits(t.orgId, 'registration.approved');
    expect(audit).toHaveLength(3);
    expect(audit.every((a) => a.actor_type === 'user')).toBe(true);
    expect((await t.summary()).json()).toMatchObject({ confirmed: 3, pending: 1 });
  });

  it('declines several requests in one step; each is told by email', async () => {
    const t = await approving();
    const people = [await ask(t, 'Eve'), await ask(t, 'Fay')];
    const res = await decideMany(
      t,
      'decline',
      people.map((p) => p.id),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ decision: 'decline', decided: 2 });
    await drain(() => people.every((p) => mails(p.addr, 'registration_declined').length > 0));
    await settle();
    for (const p of people) {
      expect((await rowOf(t.eventId, p.addr))!.status).toBe('declined');
      expect(mails(p.addr, 'registration_declined')).toHaveLength(1);
      expect(mails(p.addr, 'registration_approved')).toHaveLength(0);
    }
    expect(await audits(t.orgId, 'registration.declined')).toEqual([
      { actor_type: 'user', metadata: { eventId: t.eventId } },
      { actor_type: 'user', metadata: { eventId: t.eventId } },
    ]);
  });

  it('entries already dealt with, or not found, are reported and the rest go ahead', async () => {
    const t = await approving();
    const done = await ask(t, 'Already Approved');
    await decide(t, done.id, 'approve');
    const gone = await ask(t, 'Withdrew');
    await leave(gone.token);
    const fresh = await ask(t, 'Still Waiting');
    const unknown = randomUUID();
    const res = await decideMany(t, 'decline', [done.id, gone.id, fresh.id, unknown]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      decision: 'decline',
      decided: 1,
      results: [
        { registrationId: done.id, result: 'not_pending' },
        { registrationId: gone.id, result: 'not_pending' },
        { registrationId: fresh.id, result: 'decided' },
        { registrationId: unknown, result: 'not_found' },
      ],
    });
    expect((await rowOf(t.eventId, done.addr))!.status).toBe('confirmed');
    expect((await rowOf(t.eventId, gone.addr))!.status).toBe('cancelled');
    expect((await rowOf(t.eventId, fresh.addr))!.status).toBe('declined');
    expect(await audits(t.orgId, 'registration.declined')).toHaveLength(1);
  });

  it('a whole batch of entries already dealt with changes nothing and still answers 200', async () => {
    const t = await approving();
    const r = await ask(t);
    await decide(t, r.id, 'decline');
    const res = await decideMany(t, 'approve', [r.id]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ decided: 0, results: [{ result: 'not_pending' }] });
    expect((await rowOf(t.eventId, r.addr))!.status).toBe('declined');
    expect(await audits(t.orgId, 'registration.approved')).toHaveLength(0);
  });

  it('seats count up in the order given: the approval past capacity is the one recorded as over', async () => {
    const t = await approving({ capacity: 2 });
    const people = [await ask(t, 'One'), await ask(t, 'Two'), await ask(t, 'Three')];
    const res = await decideMany(
      t,
      'approve',
      people.map((p) => p.id),
    );
    expect(res.json().decided).toBe(3);
    expect((await audits(t.orgId, 'registration.approved')).map((a) => a.metadata)).toEqual([
      { eventId: t.eventId, overCapacity: false },
      { eventId: t.eventId, overCapacity: false },
      { eventId: t.eventId, overCapacity: true },
    ]);
    expect((await t.summary()).json()).toMatchObject({ confirmed: 3, capacity: 2 });
  });

  it('a repeated batch with the same key returns the same answer and sends one email each', async () => {
    const t = await approving();
    const people = [await ask(t, 'Gil'), await ask(t, 'Hal')];
    const key = idem();
    const ids = people.map((p) => p.id);
    const a = await decideMany(t, 'approve', ids, t.owner, key);
    const b = await decideMany(t, 'approve', ids, t.owner, key);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(b.json().decided).toBe(2);
    // The same key with a different batch is refused, not replayed.
    const c = await decideMany(t, 'decline', ids, t.owner, key);
    expect(c.statusCode).toBe(422);
    await drain(() => people.every((p) => mails(p.addr, 'registration_approved').length > 0));
    await settle();
    for (const p of people) expect(mails(p.addr, 'registration_approved')).toHaveLength(1);
    expect(await audits(t.orgId, 'registration.approved')).toHaveLength(2);
  });

  it('refuses the whole batch for a cancelled event', async () => {
    const t = await approving();
    const r = await ask(t);
    await pools.migrator.query(
      `UPDATE eventhub.event SET cancelled_at = now(), cancellation_reason = 'Weather.',
              cancelled_by = $2
        WHERE id = $1`,
      [t.eventId, t.owner.id],
    );
    for (const decision of ['approve', 'decline'] as const) {
      const res = await decideMany(t, decision, [r.id]);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.reason).toBe('event_cancelled');
    }
    expect((await rowOf(t.eventId, r.addr))!.status).toBe('pending');
  });

  it('validates the batch: a decision, 1 to 100 distinct IDs, nothing else', async () => {
    const t = await approving();
    const r = await ask(t);
    const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
    const bad: unknown[] = [
      { decision: 'approve', registrationIds: [] },
      { decision: 'approve', registrationIds: ids(101) },
      { decision: 'approve', registrationIds: [r.id, r.id] },
      { decision: 'approve', registrationIds: ['not-a-uuid'] },
      { decision: 'confirm', registrationIds: [r.id] },
      { registrationIds: [r.id] },
      { decision: 'approve', registrationIds: [r.id], status: 'confirmed' },
    ];
    for (const payload of bad) {
      const res = await call({
        method: 'POST',
        url: `${t.base}/decide`,
        headers: { ...auth(t.owner), ...idem() },
        payload: payload as object,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // Exactly 100 is accepted (all unknown here, so nothing changes).
    const full = await decideMany(t, 'approve', ids(100));
    expect(full.statusCode).toBe(200);
    expect(full.json().results).toHaveLength(100);
    // An idempotency key is required.
    const noKey = await call({
      method: 'POST',
      url: `${t.base}/decide`,
      headers: auth(t.owner),
      payload: { decision: 'approve', registrationIds: [r.id] },
    });
    expect(noKey.statusCode).toBe(400);
    expect((await rowOf(t.eventId, r.addr))!.status).toBe('pending');
  });

  it('needs registration.manage; other organizations find nothing to decide', async () => {
    const t = await approving();
    const r = await ask(t);
    for (const role of ['viewer', 'content_editor'] as const) {
      for (const decision of ['approve', 'decline'] as const) {
        expect((await decideMany(t, decision, [r.id], t.members[role])).statusCode, role).toBe(403);
      }
    }
    // A registration manager may.
    const ok = await decideMany(t, 'approve', [r.id], t.members.registration_manager);
    expect(ok.json()).toMatchObject({ decided: 1 });
    expect((await rowOf(t.eventId, r.addr))!.decided_by).toBe(t.members.registration_manager!.id);

    const s = await ask(t);
    const other = await approving();
    const theirs = await ask(other);
    // Another organization's owner at this address is refused.
    expect((await decideMany(t, 'approve', [s.id], other.owner)).statusCode).toBe(404);
    // At their own event's address, this organization's request is simply not found...
    const crossed = await decideMany(other, 'approve', [s.id, theirs.id], other.owner);
    expect(crossed.json()).toEqual({
      decision: 'approve',
      decided: 1,
      results: [
        { registrationId: s.id, result: 'not_found' },
        { registrationId: theirs.id, result: 'decided' },
      ],
    });
    expect((await rowOf(t.eventId, s.addr))!.status).toBe('pending');
    // ...and so is a request for another of their own events.
    const second = await approving();
    const elsewhere = await ask(second);
    const wrongEvent = await call({
      method: 'POST',
      url: `/v1/organizations/${t.orgId}/events/${t.eventId}/registrations/decide`,
      headers: { ...auth(t.owner), ...idem() },
      payload: { decision: 'approve', registrationIds: [elsewhere.id] },
    });
    expect(wrongEvent.json().results[0].result).toBe('not_found');
    // An event ID from another organization under this organization's address: 404.
    const foreignEvent = await call({
      method: 'POST',
      url: `/v1/organizations/${t.orgId}/events/${other.eventId}/registrations/decide`,
      headers: { ...auth(t.owner), ...idem() },
      payload: { decision: 'approve', registrationIds: [theirs.id] },
    });
    expect(foreignEvent.statusCode).toBe(404);
  });
});
