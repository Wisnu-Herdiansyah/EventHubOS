import { createHash, randomUUID } from 'node:crypto';
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
import {
  sendRegistrationCancelledConsumer,
  sendRegistrationConfirmationConsumer,
} from '../../apps/worker/src/consumers/send-registration-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';
import { closeWaitlistsOnce } from '../../apps/worker/src/waitlist-closer.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret
const SITE = 'https://{handle}.eventhub.example';

/** Waitlist (ADR-0035): joining a full event, getting a freed seat, and organizer promotion. */
describe('waitlist', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendRegistrationConfirmationConsumer(inbox, { publicSiteUrl: SITE, tokenSecret: SECRET }),
    sendRegistrationCancelledConsumer(inbox),
  ]);
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.71.${Math.floor(++ip / 250)}.${ip % 250}` });
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
  const tokenFrom = (text: string) => /#token=([A-Za-z0-9_-]{43})/.exec(text)![1]!;

  const waiting = (cap = 1) =>
    publishedEvent({ capacity: cap, waitlist: true }, ['viewer', 'registration_manager']);
  const rows = async (eventId: string) =>
    (
      await pools.migrator.query<{ email: string; status: string; promoted_by: string | null }>(
        `SELECT email, status, promoted_by FROM eventhub.registration
          WHERE event_id = $1 ORDER BY created_at, id`,
        [eventId],
      )
    ).rows;
  const statusOf = async (eventId: string, addr: string) =>
    (await rows(eventId)).find((r) => r.email === addr)?.status;
  const audits = async (orgId: string, action: string) =>
    (
      await pools.migrator.query<{ actor_type: string; metadata: Record<string, unknown> }>(
        `SELECT actor_type, metadata FROM eventhub.audit_event
          WHERE organization_id = $1 AND action = $2 ORDER BY occurred_at`,
        [orgId, action],
      )
    ).rows;
  const publicState = async (t: { handle: string; slug: string }) =>
    (await call({ method: 'GET', url: `/v1/public/sites/${t.handle}/events/${t.slug}` })).json()
      .registration.state;
  const leave = (token: string) =>
    call({ method: 'POST', url: '/v1/public/registrations/cancel', payload: { token } });
  /** Registers someone and returns their link token from the email that matches their state. */
  async function signUp(
    t: Awaited<ReturnType<typeof waiting>>,
    template: 'registration_confirmed' | 'registration_waitlisted',
  ) {
    const addr = email();
    const res = await t.register({ name: `Person ${addr.slice(9, 13)}`, email: addr });
    expect(res.statusCode, res.body).toBe(202);
    await drain(() => mails(addr, template).length > 0);
    const mail = mails(addr, template)[0];
    expect(mail, `${template} for ${addr}`).toBeDefined();
    return { addr, token: tokenFrom(mail!.text), mail: mail! };
  }

  it('lets visitors join the waitlist of a full event, answering exactly as a sign-up does', async () => {
    const t = await waiting(1);
    const seated = await t.register({ name: 'Seated', email: email() });
    expect(await publicState(t)).toBe('waitlist');
    const w = await signUp(t, 'registration_waitlisted');
    // No enumeration: the response is byte-identical to a normal sign-up.
    const again = await t.register({ name: 'Again', email: w.addr });
    expect(again.statusCode).toBe(202);
    expect(again.body).toBe(seated.body);
    expect(await statusOf(t.eventId, w.addr)).toBe('waitlisted');
    expect((await rows(t.eventId)).filter((r) => r.email === w.addr)).toHaveLength(1);

    expect(w.mail.subject).toMatch(/^You're on the waitlist: /);
    expect(w.mail.text).toContain('Leave the waitlist:');
    expect(w.mail.text).not.toContain('ticket'); // no ticket until there is a seat
    // The repeat sign-up re-sends the waitlist email (not a registration).
    await drain(() => mails(w.addr, 'registration_waitlisted').length > 1);
    expect(mails(w.addr, 'registration_waitlisted')[1]!.text).toContain(
      "You're already on the waitlist",
    );
    expect(mails(w.addr, 'registration_confirmed')).toHaveLength(0);

    expect((await t.summary()).json()).toMatchObject({
      confirmed: 1,
      waitlisted: 1,
      waitlist: true,
      state: 'full',
    });
    expect((await audits(t.orgId, 'registration.waitlisted'))[0]).toMatchObject({
      actor_type: 'system',
      metadata: { eventId: t.eventId, source: 'public_site' },
    });
    // The organizer's waitlist view, in joining order.
    const list = await call({
      method: 'GET',
      url: `${t.base}?status=waitlisted`,
      headers: auth(t.owner),
    });
    expect(list.json().data.map((r: { email: string }) => r.email)).toEqual([w.addr]);
  });

  it('without the waitlist setting a full event still refuses', async () => {
    const t = await publishedEvent({ capacity: 1 });
    await t.register({ name: 'Seated', email: email() });
    const res = await t.register({ name: 'Late', email: email() });
    expect(res.json().error.details.reason).toBe('event_full');
    expect((await rows(t.eventId)).map((r) => r.status)).toEqual(['confirmed']);
  });

  it('gives a freed seat to the person who has waited longest, and emails them', async () => {
    const t = await waiting(1);
    const seated = await signUp(t, 'registration_confirmed');
    const first = await signUp(t, 'registration_waitlisted');
    const second = await signUp(t, 'registration_waitlisted');

    const res = await leave(seated.token);
    expect(res.json()).toMatchObject({ status: 'cancelled', wasWaitlisted: false });
    expect(await statusOf(t.eventId, first.addr)).toBe('confirmed');
    expect(await statusOf(t.eventId, second.addr)).toBe('waitlisted');
    expect((await rows(t.eventId)).find((r) => r.email === first.addr)!.promoted_by).toBe(
      'waitlist',
    );
    expect(await audits(t.orgId, 'registration.promoted')).toEqual([
      { actor_type: 'system', metadata: { eventId: t.eventId, by: 'waitlist' } },
    ]);

    await drain(() => mails(first.addr, 'registration_promoted').length > 0);
    const promoted = mails(first.addr, 'registration_promoted')[0]!;
    expect(promoted.subject).toMatch(/^A seat opened up: you're registered for /);
    expect(promoted.text).toContain('/ticket#id=');
    // The new link cancels the seat; the old waitlist link no longer works.
    expect((await leave(first.token)).statusCode).toBe(400);
    const res2 = await leave(tokenFrom(promoted.text));
    expect(res2.json()).toMatchObject({ wasWaitlisted: false });
    expect(await statusOf(t.eventId, second.addr)).toBe('confirmed');
  });

  it('leaving the waitlist frees no seat and says so', async () => {
    const t = await waiting(1);
    await signUp(t, 'registration_confirmed');
    const first = await signUp(t, 'registration_waitlisted');
    const second = await signUp(t, 'registration_waitlisted');
    const res = await leave(first.token);
    expect(res.json()).toMatchObject({ status: 'cancelled', wasWaitlisted: true });
    expect(await statusOf(t.eventId, second.addr)).toBe('waitlisted');
    expect(await audits(t.orgId, 'registration.promoted')).toEqual([]);
    await drain(() => mails(first.addr, 'registration_waitlist_left').length > 0);
    expect(mails(first.addr, 'registration_waitlist_left')[0]!.text).toContain(
      "You've left the waitlist",
    );
    // They may join again, at the back.
    expect((await t.register({ name: 'Back', email: first.addr })).statusCode).toBe(202);
    expect((await rows(t.eventId)).at(-1)).toMatchObject({
      email: first.addr,
      status: 'waitlisted',
    });
  });

  it('promotes when an organizer cancels a seat, but not when they remove someone waiting', async () => {
    const t = await waiting(1);
    await signUp(t, 'registration_confirmed');
    const first = await signUp(t, 'registration_waitlisted');
    const second = await signUp(t, 'registration_waitlisted');
    const ids = (await t.list()).json().data as Array<{
      id: string;
      email: string;
      status: string;
    }>;
    const idOf = (addr: string) => ids.find((r) => r.email === addr)!.id;
    const seatedId = ids.find((r) => r.status === 'confirmed')!.id;
    const cancel = (id: string) =>
      call({
        method: 'POST',
        url: `${t.base}/${id}/cancel`,
        headers: { ...auth(t.members.registration_manager!), ...idem() },
      });

    const removed = await cancel(idOf(second.addr));
    expect(removed.json()).toMatchObject({ status: 'cancelled', cancelledBy: 'organizer' });
    expect(await statusOf(t.eventId, first.addr)).toBe('waitlisted');
    await drain(() => mails(second.addr, 'registration_waitlist_left').length > 0);
    expect(mails(second.addr, 'registration_waitlist_left')[0]!.text).toContain(
      'The organizer removed you from the waitlist',
    );

    expect((await cancel(seatedId)).statusCode).toBe(200);
    expect(await statusOf(t.eventId, first.addr)).toBe('confirmed');
    expect((await audits(t.orgId, 'registration.cancelled')).map((a) => a.metadata.from)).toEqual([
      'waitlisted',
      'confirmed',
    ]);
  });

  it('fills the waitlist when the capacity grows or is removed', async () => {
    const t = await waiting(1);
    await signUp(t, 'registration_confirmed');
    const w = [];
    for (let i = 0; i < 4; i++) w.push(await signUp(t, 'registration_waitlisted'));
    const patch = async (registration: object | null) => {
      const url = `/v1/organizations/${t.orgId}/events/${t.eventId}`;
      const { version } = (await call({ method: 'GET', url, headers: auth(t.owner) })).json();
      return call({
        method: 'PATCH',
        url,
        headers: { ...auth(t.owner), ...idem() },
        payload: { expectedVersion: version, settings: { registration } },
      });
    };
    const bad = await patch({ waitlist: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.fields[0].path).toBe('body.settings.registration.waitlist');

    const grow = await patch({ capacity: 3, waitlist: true });
    expect(grow.statusCode, grow.body).toBe(200);
    expect(await Promise.all(w.map((p) => statusOf(t.eventId, p.addr)))).toEqual([
      'confirmed',
      'confirmed',
      'waitlisted',
      'waitlisted',
    ]);
    expect(await patch({ waitlist: false })).toHaveProperty('statusCode', 200);
    expect(await Promise.all(w.map((p) => statusOf(t.eventId, p.addr)))).toEqual([
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
    ]);
  });

  it('stops promoting once registration has closed', async () => {
    const t = await waiting(1);
    const seated = await signUp(t, 'registration_confirmed');
    const w = await signUp(t, 'registration_waitlisted');
    await pools.migrator.query(
      `UPDATE eventhub.event SET settings = jsonb_set(settings, '{registration,closesAt}', to_jsonb($2::text))
        WHERE id = $1`,
      [t.eventId, new Date(Date.now() - 60_000).toISOString()],
    );
    expect((await leave(seated.token)).statusCode).toBe(200);
    expect(await statusOf(t.eventId, w.addr)).toBe('waitlisted');
  });

  it('lets registration managers promote someone out of turn, even beyond capacity', async () => {
    const t = await waiting(1);
    await signUp(t, 'registration_confirmed');
    const first = await signUp(t, 'registration_waitlisted');
    const second = await signUp(t, 'registration_waitlisted');
    const ids = (await t.list()).json().data as Array<{ id: string; email: string }>;
    const secondId = ids.find((r) => r.email === second.addr)!.id;
    const promote = (u: FixtureUser, url = `${t.base}/${secondId}/promote`) =>
      call({ method: 'POST', url, headers: { ...auth(u), ...idem() } });

    expect((await promote(t.members.viewer!)).statusCode).toBe(403);
    const outsider = await createFixtureUser(pools.migrator);
    const otherOrg = await createFixtureOrganization(pools.migrator, outsider.id);
    expect(
      (
        await promote(
          outsider,
          `/v1/organizations/${otherOrg}/events/${t.eventId}/registrations/${secondId}/promote`,
        )
      ).statusCode,
    ).toBe(404);
    expect(await statusOf(t.eventId, second.addr)).toBe('waitlisted');

    const ok = await promote(t.members.registration_manager!);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'confirmed', promotedBy: 'organizer' });
    expect(await statusOf(t.eventId, first.addr)).toBe('waitlisted');
    expect((await audits(t.orgId, 'registration.promoted'))[0]!.metadata).toEqual({
      eventId: t.eventId,
      by: 'organizer',
      overCapacity: true,
    });
    expect((await promote(t.owner)).json().error.details.reason).toBe('not_waitlisted');
    // Someone who left the waitlist cannot be promoted either.
    expect((await leave(first.token)).statusCode).toBe(200);
    const firstId = ids.find((r) => r.email === first.addr)!.id;
    const gone = await promote(t.owner, `${t.base}/${firstId}/promote`);
    expect(gone.json().error.details.reason).toBe('not_waitlisted');
    expect(await statusOf(t.eventId, first.addr)).toBe('cancelled');
    await drain(() => mails(second.addr, 'registration_promoted').length > 0);
    expect(mails(second.addr, 'registration_promoted')).toHaveLength(1);
  });

  it('keeps waiting people out of check-in and attendance figures', async () => {
    const t = await waiting(1);
    await signUp(t, 'registration_confirmed');
    const w = await signUp(t, 'registration_waitlisted');
    const id = ((await t.list()).json().data as Array<{ id: string; email: string }>).find(
      (r) => r.email === w.addr,
    )!.id;
    const checkIn = await call({
      method: 'POST',
      url: `${t.base}/${id}/check-in`,
      headers: { ...auth(t.owner), ...idem() },
    });
    expect(checkIn.json().error.details.reason).toBe('registration_waitlisted');
    const report = await call({
      method: 'GET',
      url: `/v1/organizations/${t.orgId}/events/${t.eventId}/report`,
      headers: auth(t.owner),
    });
    expect(report.json().totals).toMatchObject({ registered: 1, cancelled: 0, checkedIn: 0 });
  });

  it('sends only the email that matches: promoted before the waitlist email went out', async () => {
    const t = await waiting(1);
    const seated = await signUp(t, 'registration_confirmed');
    const addr = email();
    await t.register({ name: 'Quick', email: addr });
    // The seat frees up before the worker has sent the waitlist email.
    expect((await leave(seated.token)).statusCode).toBe(200);
    await drain(() => mails(addr, 'registration_promoted').length > 0);
    expect(mails(addr, 'registration_promoted')).toHaveLength(1);
    // Nothing else: no waitlist email, and no other kind sent in its place.
    expect(mails(addr).map((m) => m.template)).toEqual(['registration_promoted']);
  });

  it('serialises a freed seat with new sign-ups on the event row', async () => {
    const t = await waiting(1);
    const seated = await signUp(t, 'registration_confirmed');
    const w = await signUp(t, 'registration_waitlisted');
    const a = await pools.app.connect();
    const b = await pools.app.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const left = await a.query<{ out_organization_id: string; out_event_id: string }>(
        'SELECT * FROM eventhub.public_leave_registration($1)',
        [createHash('sha256').update(seated.token).digest()],
      );
      await a.query("SELECT set_config('app.organization_id', $1, true)", [t.orgId]);
      const promoted = await a.query('SELECT * FROM eventhub.fill_waitlist($1, $2)', [
        left.rows[0]!.out_organization_id,
        left.rows[0]!.out_event_id,
      ]);
      expect(promoted.rowCount).toBe(1);
      // A new visitor must wait for that transaction, then find the seat taken.
      let settled = false;
      const late = b
        .query<{ out_outcome: string }>(
          'SELECT out_outcome FROM eventhub.public_register($1, $2, $3, $4)',
          [t.handle, t.slug, email(), 'Late'],
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await a.query('COMMIT');
      expect((await late).rows[0]!.out_outcome).toBe('waitlisted');
      await b.query('COMMIT');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
    expect(await statusOf(t.eventId, w.addr)).toBe('confirmed');
    expect((await t.summary()).json()).toMatchObject({ confirmed: 1, waitlisted: 1 });
  });

  it('fill_waitlist itself takes the event lock before handing out seats', async () => {
    const t = await waiting(1);
    const seated = await signUp(t, 'registration_confirmed');
    const w = await signUp(t, 'registration_waitlisted');
    // A seat is free (cancelled directly), and nothing has filled it yet.
    await pools.migrator.query(
      `UPDATE eventhub.registration SET status = 'cancelled', cancelled_at = now(),
              cancelled_by = 'organizer' WHERE event_id = $1 AND email = $2`,
      [t.eventId, seated.addr],
    );
    const a = await pools.app.connect();
    const b = await pools.app.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query("SELECT set_config('app.organization_id', $1, true)", [t.orgId]);
      const promoted = await a.query('SELECT * FROM eventhub.fill_waitlist($1, $2)', [
        t.orgId,
        t.eventId,
      ]);
      expect(promoted.rowCount).toBe(1);
      let settled = false;
      const late = b
        .query<{ out_outcome: string }>(
          'SELECT out_outcome FROM eventhub.public_register($1, $2, $3, $4)',
          [t.handle, t.slug, email(), 'Late'],
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await a.query('COMMIT');
      expect((await late).rows[0]!.out_outcome).toBe('waitlisted');
      await b.query('COMMIT');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
    expect(await statusOf(t.eventId, w.addr)).toBe('confirmed');
    expect((await t.summary()).json()).toMatchObject({ confirmed: 1, waitlisted: 1 });
  });

  it('never seats more than the capacity under concurrent cancellations and sign-ups', async () => {
    const t = await waiting(2);
    const seated = [
      await signUp(t, 'registration_confirmed'),
      await signUp(t, 'registration_confirmed'),
    ];
    for (let i = 0; i < 3; i++) await signUp(t, 'registration_waitlisted');
    await Promise.all([
      ...seated.map((s) => leave(s.token)),
      ...Array.from({ length: 4 }, (_, i) => t.register({ name: `Rush ${i}`, email: email() })),
    ]);
    const s = (await t.summary()).json();
    expect(s.confirmed).toBe(2);
    expect(s.waitlisted).toBe(5);
  });

  it('fill_waitlist does nothing outside the tenant context', async () => {
    const t = await waiting(1);
    await signUp(t, 'registration_confirmed');
    const w = await signUp(t, 'registration_waitlisted');
    await pools.migrator.query(
      `UPDATE eventhub.event SET settings = jsonb_set(settings, '{registration,capacity}', '5')
        WHERE id = $1`,
      [t.eventId],
    );
    const other = await createFixtureUser(pools.migrator);
    const otherOrg = await createFixtureOrganization(pools.migrator, other.id);
    const client = await pools.app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [otherOrg]);
      const res = await client.query('SELECT * FROM eventhub.fill_waitlist($1, $2)', [
        t.orgId,
        t.eventId,
      ]);
      expect(res.rowCount).toBe(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await statusOf(t.eventId, w.addr)).toBe('waitlisted');
  });

  describe('follow-ups (ADR-0038)', () => {
    const closePass = (sender: { name: string; send(m: EmailMessage): Promise<void> } = inbox) =>
      closeWaitlistsOnce(pools.worker, sender, { publicSiteUrl: SITE });
    const closeRegistration = (eventId: string) =>
      pools.migrator.query(
        `UPDATE eventhub.event SET settings = jsonb_set(settings, '{registration,closesAt}', to_jsonb($2::text))
          WHERE id = $1`,
        [eventId, new Date(Date.now() - 60_000).toISOString()],
      );
    /** Runs passes until none is left, as the worker loop would (other tests' events included). */
    const drainClosing = async () => {
      for (let i = 0; i < 20 && (await closePass()) > 0; i++);
    };

    it('caps the waitlist: once it is full the event answers full again', async () => {
      const t = await publishedEvent({ capacity: 1, waitlist: true, waitlistLimit: 2 });
      await t.register({ name: 'Seated', email: email() });
      const first = await signUp(t, 'registration_waitlisted');
      await signUp(t, 'registration_waitlisted');
      expect(await publicState(t)).toBe('full');
      const third = await t.register({ name: 'Third', email: email() });
      expect(third.statusCode).toBe(409);
      expect(third.json().error.details.reason).toBe('event_full');
      // Someone leaves: there is room again.
      expect((await leave(first.token)).statusCode).toBe(200);
      expect(await publicState(t)).toBe('waitlist');
      expect((await t.register({ name: 'Third', email: email() })).statusCode).toBe(202);
      expect(await publicState(t)).toBe('full');
      // Someone told the waitlist closed no longer takes up a place on it.
      await pools.migrator.query(
        `UPDATE eventhub.registration SET waitlist_closed_at = now()
          WHERE event_id = $1 AND status = 'waitlisted' AND name = 'Third'`,
        [t.eventId],
      );
      expect(await publicState(t)).toBe('waitlist');
    });

    it('refuses a waitlist limit without the waitlist', async () => {
      const t = await waiting(1);
      const url = `/v1/organizations/${t.orgId}/events/${t.eventId}`;
      const { version } = (await call({ method: 'GET', url, headers: auth(t.owner) })).json();
      const res = await call({
        method: 'PATCH',
        url,
        headers: { ...auth(t.owner), ...idem() },
        payload: {
          expectedVersion: version,
          settings: { registration: { capacity: 5, waitlistLimit: 3 } },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.fields[0].path).toBe(
        'body.settings.registration.waitlistLimit',
      );
    });

    it('tells everyone still waiting, once, when registration closes', async () => {
      const t = await waiting(1);
      await signUp(t, 'registration_confirmed');
      const a = await signUp(t, 'registration_waitlisted');
      const b = await signUp(t, 'registration_waitlisted');
      const open = await waiting(1);
      await signUp(open, 'registration_confirmed');
      const stillOpen = await signUp(open, 'registration_waitlisted');

      await closeRegistration(t.eventId);
      await drainClosing();
      for (const p of [a, b]) {
        const m = mails(p.addr, 'registration_waitlist_closed');
        expect(m).toHaveLength(1);
        expect(m[0]!.subject).toMatch(/^The waitlist has closed: /);
        expect(m[0]!.text).toContain('no seat became free for you');
        expect(m[0]!.text).toContain(`https://${t.handle}.eventhub.example/${t.slug}`);
      }
      // An event still taking registrations is left alone.
      expect(mails(stillOpen.addr, 'registration_waitlist_closed')).toHaveLength(0);
      // Never twice.
      await drainClosing();
      expect(mails(a.addr, 'registration_waitlist_closed')).toHaveLength(1);
      // They stay on record as waitlisted (never registered), marked closed, and are not counted
      // as waiting any more.
      expect(await statusOf(t.eventId, a.addr)).toBe('waitlisted');
      expect((await t.summary()).json()).toMatchObject({ confirmed: 1, waitlisted: 0 });
      const listed = await call({
        method: 'GET',
        url: `${t.base}?status=waitlisted`,
        headers: auth(t.owner),
      });
      expect(
        listed.json().data.every((r: { waitlistClosedAt: string | null }) => r.waitlistClosedAt),
      ).toBe(true);
    });

    it('closes the waitlist of an event that ended or was archived early', async () => {
      for (const lifecycle of ['ended', 'archived'] as const) {
        const t = await waiting(1);
        await signUp(t, 'registration_confirmed');
        const w = await signUp(t, 'registration_waitlisted');
        await pools.migrator.query(
          `UPDATE eventhub.event SET lifecycle = $2,
                  archived_from = CASE WHEN $2 = 'archived' THEN 'ended' END WHERE id = $1`,
          [t.eventId, lifecycle],
        );
        await drainClosing();
        expect(mails(w.addr, 'registration_waitlist_closed'), lifecycle).toHaveLength(1);
      }
    });

    it('never promotes someone who was told the waitlist closed', async () => {
      const t = await waiting(1);
      const seated = await signUp(t, 'registration_confirmed');
      const told = await signUp(t, 'registration_waitlisted');
      const next = await signUp(t, 'registration_waitlisted');
      // As if registration had closed and reopened (the organizer moved the closing date).
      await pools.migrator.query(
        `UPDATE eventhub.registration SET waitlist_closed_at = now() WHERE event_id = $1 AND email = $2`,
        [t.eventId, told.addr],
      );
      expect((await leave(seated.token)).statusCode).toBe(200);
      expect(await statusOf(t.eventId, told.addr)).toBe('waitlisted');
      expect(await statusOf(t.eventId, next.addr)).toBe('confirmed');
    });

    it('retries a failed pass without a second copy for anyone', async () => {
      const t = await waiting(1);
      await signUp(t, 'registration_confirmed');
      const people = [
        await signUp(t, 'registration_waitlisted'),
        await signUp(t, 'registration_waitlisted'),
      ];
      await closeRegistration(t.eventId);
      // Provider-like: one delivery per message ID; the second send fails once.
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
      await expect(closePass(flaky)).rejects.toThrow('provider outage');
      // Nothing was marked: the batch rolled back.
      expect(await statusOf(t.eventId, people[0]!.addr)).toBe('waitlisted');
      const marked = await pools.migrator.query(
        'SELECT count(*)::int AS n FROM eventhub.registration WHERE event_id = $1 AND waitlist_closed_at IS NOT NULL',
        [t.eventId],
      );
      expect(marked.rows[0].n).toBe(0);
      for (let i = 0; i < 20 && (await closePass(flaky)) > 0; i++);
      const ours = [...delivered.values()].filter((m) => people.some((p) => p.addr === m.to));
      expect(ours.map((m) => m.to).sort()).toEqual(people.map((p) => p.addr).sort());
      expect(new Set(ours.map((m) => m.messageId)).size).toBe(2);
    });

    it('keeps the closing functions to the worker', async () => {
      await expect(pools.app.query('SELECT * FROM eventhub.waitlist_closing(10)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        pools.app.query('SELECT eventhub.waitlist_mark_closed($1, $2)', [
          randomUUID(),
          randomUUID(),
        ]),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
