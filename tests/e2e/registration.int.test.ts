import { createHash, randomUUID } from 'node:crypto';
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
} from '../../apps/worker/src/consumers/send-registration-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret
const SITE = 'https://{handle}.eventhub.example';

/** Free registration (ADR-0023), from the public form to the organizer's list. */
describe('event registration', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendRegistrationConfirmationConsumer(inbox, { publicSiteUrl: SITE, tokenSecret: SECRET }),
    sendRegistrationCancelledConsumer(inbox),
  ]);
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.70.${Math.floor(++ip / 250)}.${ip % 250}` });
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

  it('registers a visitor, confirms by email and shows them to the organizer', async () => {
    const t = await publishedEvent({ capacity: 100 });
    const addr = email();
    const res = await t.register({ name: 'Ade Wisnu', email: addr.toUpperCase() });
    expect(res.statusCode).toBe(202);
    expect(res.json().message).toContain('Check your email');

    const list = (await t.list()).json().data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Ade Wisnu', email: addr, status: 'confirmed' });
    expect((await t.summary()).json()).toMatchObject({
      confirmed: 1,
      cancelled: 0,
      capacity: 100,
      state: 'open',
    });
    // Personal data stays out of audit and outbox records.
    const audit = await pools.migrator.query(
      `SELECT metadata, actor_type FROM eventhub.audit_event WHERE action = 'registration.created'
        AND target_id = $1`,
      [list[0].id],
    );
    expect(audit.rows[0].actor_type).toBe('system');
    const outbox = await pools.migrator.query(
      `SELECT payload FROM eventhub.outbox_event WHERE aggregate_id = $1`,
      [list[0].id],
    );
    expect(JSON.stringify([audit.rows, outbox.rows])).not.toContain(addr);
    expect(JSON.stringify([audit.rows, outbox.rows])).not.toContain('Ade Wisnu');

    await drain(() => mails(addr, 'registration_confirmed').length > 0);
    const mail = mails(addr, 'registration_confirmed')[0]!;
    expect(mail.text).toContain(`https://${t.handle}.eventhub.example/${t.slug}`);
    expect(mail.text).toMatch(/cancel-registration#token=[A-Za-z0-9_-]{43}/);
  });

  it('answers a repeat sign-up the same way, without a second registration', async () => {
    const t = await publishedEvent();
    const addr = email();
    const first = await t.register({ name: 'A', email: addr });
    const again = await t.register({ name: 'Someone else', email: addr });
    const third = await t.register({ name: 'Third try', email: addr });
    expect(again.statusCode).toBe(first.statusCode);
    expect(again.json()).toEqual(first.json());
    expect(third.json()).toEqual(first.json());
    expect((await t.list()).json().data).toHaveLength(1);
    // The address gets its confirmation, one reminder, and no more within 10 minutes.
    await drain(() => mails(addr).length >= 2);
    await drain(() => false);
    expect(mails(addr, 'registration_confirmed')).toHaveLength(1);
    expect(mails(addr, 'registration_reminder')).toHaveLength(1);
  });

  it('never exceeds capacity, even with concurrent sign-ups', async () => {
    const t = await publishedEvent({ capacity: 2 });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => t.register({ name: `P${i}`, email: email() })),
    );
    const accepted = results.filter((r) => r.statusCode === 202);
    const full = results.filter((r) => r.statusCode === 409);
    expect(accepted).toHaveLength(2);
    expect(full).toHaveLength(4);
    expect(full[0]!.json().error.details.reason).toBe('event_full');
    expect((await t.summary()).json()).toMatchObject({ confirmed: 2, state: 'full' });
  });

  it('serialises sign-ups on the event row, so two people cannot take the last seat', async () => {
    const t = await publishedEvent({ capacity: 1 });
    const a = await pools.app.connect();
    const b = await pools.app.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const first = await a.query<{ out_outcome: string }>(
        'SELECT out_outcome FROM eventhub.public_register($1, $2, $3, $4)',
        [t.handle, t.slug, email(), 'First'],
      );
      expect(first.rows[0]!.out_outcome).toBe('registered');
      // The second sign-up must wait for the first transaction, then see the event as full.
      let settled = false;
      const second = b
        .query<{ out_outcome: string }>(
          'SELECT out_outcome FROM eventhub.public_register($1, $2, $3, $4)',
          [t.handle, t.slug, email(), 'Second'],
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await a.query('COMMIT');
      expect((await second).rows[0]!.out_outcome).toBe('full');
      await b.query('COMMIT');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
    expect((await t.summary()).json().confirmed).toBe(1);
  });

  it('respects the registration window and the event lifecycle', async () => {
    const later = await publishedEvent({
      opensAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const notYet = await later.register({ name: 'Early', email: email() });
    expect(notYet.json().error.details.reason).toBe('registration_not_open');

    const past = await publishedEvent({
      opensAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      closesAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(
      (await past.register({ name: 'Late', email: email() })).json().error.details.reason,
    ).toBe('registration_closed');

    const t = await publishedEvent();
    await pools.migrator.query(`UPDATE eventhub.event SET lifecycle = 'scheduled' WHERE id = $1`, [
      t.eventId,
    ]);
    expect((await t.register({ name: 'X', email: email() })).statusCode).toBe(404);
    await pools.migrator.query(
      `UPDATE eventhub.event SET lifecycle = 'published',
              settings = jsonb_set(settings, '{visibility}', '"private"') WHERE id = $1`,
      [t.eventId],
    );
    expect((await t.register({ name: 'X', email: email() })).statusCode).toBe(404);
  });

  it('validates input and quietly drops honeypot submissions', async () => {
    const t = await publishedEvent();
    expect(
      (await t.register({ name: 'X', email: email(), privacyConsent: false })).statusCode,
    ).toBe(400);
    expect((await t.register({ name: '', email: email() })).statusCode).toBe(400);
    expect((await t.register({ name: 'X', email: 'not-an-email' })).statusCode).toBe(400);
    const bot = await t.register({ name: 'Bot', email: email(), website: 'http://spam.example' });
    expect(bot.statusCode).toBe(202);
    expect((await t.list()).json().data).toHaveLength(0);
  });

  it('lets the attendee cancel once with the emailed link, and register again later', async () => {
    const t = await publishedEvent({ capacity: 1 });
    const addr = email();
    await t.register({ name: 'Ade', email: addr });
    await drain(() => mails(addr, 'registration_confirmed').length > 0);
    const token = tokenFrom(mails(addr, 'registration_confirmed')[0]!.text);
    // Only the hash is stored.
    const stored = await pools.migrator.query(
      'SELECT cancel_token_hash FROM eventhub.registration WHERE email = $1',
      [addr],
    );
    expect(stored.rows[0].cancel_token_hash).toEqual(createHash('sha256').update(token).digest());

    const cancel = () =>
      call({ method: 'POST', url: '/v1/public/registrations/cancel', payload: { token } });
    const res = await cancel();
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    expect((await cancel()).json().error.details.reason).toBe('invalid_or_used_link');
    expect((await t.summary()).json()).toMatchObject({ confirmed: 0, cancelled: 1, state: 'open' });
    await drain(() => mails(addr, 'registration_cancelled').length > 0);
    // The seat is free again, and the same person may come back.
    expect((await t.register({ name: 'Ade', email: addr })).statusCode).toBe(202);
  });

  it('limits attendee details to registration managers and keeps tenants apart', async () => {
    const t = await publishedEvent({}, ['content_editor', 'viewer', 'registration_manager']);
    const addr = email();
    await t.register({ name: 'Private Person', email: addr });
    const id = (await t.list()).json().data[0].id as string;

    expect((await t.list(t.members.viewer)).statusCode).toBe(403);
    expect((await t.list(t.members.content_editor)).statusCode).toBe(403);
    expect((await t.summary(t.members.viewer)).json().confirmed).toBe(1);
    expect((await t.list(t.members.registration_manager)).json().data[0].email).toBe(addr);

    const cancelAs = (u: FixtureUser, url = `${t.base}/${id}/cancel`) =>
      call({ method: 'POST', url, headers: { ...auth(u), ...idem() } });
    expect((await cancelAs(t.members.content_editor!)).statusCode).toBe(403);

    const outsider = await createFixtureUser(pools.migrator);
    const otherOrg = await createFixtureOrganization(pools.migrator, outsider.id);
    expect((await t.list(outsider)).statusCode).toBe(404);
    expect(
      (
        await cancelAs(
          outsider,
          `/v1/organizations/${otherOrg}/events/${t.eventId}/registrations/${id}/cancel`,
        )
      ).statusCode,
    ).toBe(404);

    const ok = await cancelAs(t.members.registration_manager!);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'cancelled', cancelledBy: 'organizer' });
    expect((await cancelAs(t.owner)).json().error.details.reason).toBe('already_cancelled');
    await drain(() => mails(addr, 'registration_cancelled').length > 0);
    expect(mails(addr, 'registration_cancelled')[0]!.text).toContain('organizer cancelled');
  });

  it('shows the registration state on the public page', async () => {
    const t = await publishedEvent({ capacity: 1 });
    const page = async () =>
      (await call({ method: 'GET', url: `/v1/public/sites/${t.handle}/events/${t.slug}` })).json()
        .registration;
    expect((await page()).state).toBe('open');
    await t.register({ name: 'Only seat', email: email() });
    expect((await page()).state).toBe('full');
  });

  describe('export (ADR-0027)', () => {
    it('exports every registration oldest first, audited without personal data', async () => {
      const t = await publishedEvent({}, ['registration_manager']);
      const first = email();
      const second = email();
      await t.register({ name: 'First Person', email: first });
      await t.register({ name: 'Second Person', email: second });
      const regs = (await t.list()).json().data as Array<{ id: string; email: string }>;
      const toCancel = regs.find((r) => r.email === second)!;
      await call({
        method: 'POST',
        url: `${t.base}/${toCancel.id}/cancel`,
        headers: { ...auth(t.owner), 'idempotency-key': `k-${randomUUID()}` },
      });

      const res = await t.exportList(t.members.registration_manager);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ eventSlug: t.slug, timezone: 'UTC', truncated: false });
      expect(body.data.map((r: { email: string; status: string }) => [r.email, r.status])).toEqual([
        [first, 'confirmed'],
        [second, 'cancelled'],
      ]);
      const confirmedOnly = (await t.exportList(t.owner, { status: 'confirmed' })).json();
      expect(confirmedOnly.data).toHaveLength(1);

      const audit = await pools.migrator.query(
        `SELECT actor_id, target_type, target_id, metadata FROM eventhub.audit_event
          WHERE organization_id = $1 AND action = 'registration.exported' ORDER BY occurred_at`,
        [t.orgId],
      );
      expect(audit.rows).toEqual([
        {
          actor_id: t.members.registration_manager!.id,
          target_type: 'event',
          target_id: t.eventId,
          metadata: { count: 2, status: 'all', truncated: false },
        },
        {
          actor_id: t.owner.id,
          target_type: 'event',
          target_id: t.eventId,
          metadata: { count: 1, status: 'confirmed', truncated: false },
        },
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain(first);
      // Never stored for replay: the response is personal data.
      const stored = await pools.migrator.query(
        `SELECT count(*)::int AS n FROM eventhub.idempotency_key
          WHERE response_body::text LIKE '%' || $1 || '%'`,
        [first],
      );
      expect(stored.rows[0].n).toBe(0);
    });

    it('needs registration.export_pii, not just registration.manage', async () => {
      const t = await publishedEvent({}, ['event_manager', 'viewer', 'admin']);
      await t.register({ name: 'Someone', email: email() });
      for (const role of ['event_manager', 'viewer']) {
        const res = await t.exportList(t.members[role]);
        expect(res.statusCode, role).toBe(403);
        expect(res.json().error.details.reason).toBe('missing_permission:registration.export_pii');
      }
      expect((await t.exportList(t.members.admin)).statusCode).toBe(200);
      const denied = await pools.migrator.query(
        `SELECT count(*)::int AS n FROM eventhub.audit_event
          WHERE organization_id = $1 AND action = 'registration.exported'`,
        [t.orgId],
      );
      expect(denied.rows[0].n).toBe(1);
    });

    it('keeps tenants and events apart', async () => {
      const a = await publishedEvent();
      const b = await publishedEvent();
      await a.register({ name: 'A Person', email: email() });
      // Another organization's Owner: same 404 as a missing organization.
      expect((await a.exportList(b.owner)).statusCode).toBe(404);
      // An event of another organization under this organization's URL: not found.
      const crossed = await call({
        method: 'POST',
        url: `/v1/organizations/${a.orgId}/events/${b.eventId}/registrations/export`,
        headers: auth(a.owner),
        payload: {},
      });
      expect(crossed.statusCode).toBe(404);
      const own = (await b.exportList()).json();
      expect(own.data).toEqual([]);
    });
  });

  describe('check-in (ADR-0028)', () => {
    const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });
    async function setup(roles: string[] = []) {
      const t = await publishedEvent({}, roles);
      const people = [
        { name: 'Ade Wisnu', email: email() },
        { name: 'Budi 100% Santoso', email: email() },
        { name: 'Citra_Dewi', email: email() },
      ];
      for (const p of people) await t.register(p);
      const list = (await t.list()).json().data as Array<{ id: string; name: string }>;
      const id = (name: string) => list.find((r) => r.name === name)!.id;
      const act = (regId: string, action: 'check-in' | 'undo-check-in', as = t.owner) =>
        call({
          method: 'POST',
          url: `${t.base}/${regId}/${action}`,
          headers: { ...auth(as), ...idem() },
        });
      const door = (q?: string, as = t.owner) =>
        call({
          method: 'GET',
          url: `/v1/organizations/${t.orgId}/events/${t.eventId}/check-in${
            q === undefined ? '' : `?q=${encodeURIComponent(q)}`
          }`,
          headers: auth(as),
        });
      return { ...t, people, id, act, door };
    }

    it('checks an attendee in once, can undo, and audits without personal data', async () => {
      const t = await setup(['registration_manager']);
      const ade = t.id('Ade Wisnu');
      const staff = t.members.registration_manager!;
      const first = await t.act(ade, 'check-in', staff);
      expect(first.statusCode, first.body).toBe(200);
      expect(Object.keys(first.json()).sort()).toEqual(['checkedInAt', 'id', 'status']);
      expect(first.json().checkedInAt).not.toBeNull();

      const again = await t.act(ade, 'check-in', staff);
      expect(again.statusCode).toBe(409);
      expect(again.json().error.details.reason).toBe('already_checked_in');

      expect((await t.summary()).json()).toMatchObject({ confirmed: 3, checkedIn: 1 });
      expect((await t.door()).json()).toMatchObject({ confirmed: 3, checkedIn: 1 });
      const stored = await pools.migrator.query(
        'SELECT checked_in_by FROM eventhub.registration WHERE id = $1',
        [ade],
      );
      expect(stored.rows[0].checked_in_by).toBe(staff.id);

      const undo = await t.act(ade, 'undo-check-in', staff);
      expect(undo.json().checkedInAt).toBeNull();
      const undoAgain = await t.act(ade, 'undo-check-in', staff);
      expect(undoAgain.statusCode).toBe(409);
      expect(undoAgain.json().error.details.reason).toBe('not_checked_in');
      expect((await t.summary()).json().checkedIn).toBe(0);

      const audit = await pools.migrator.query(
        `SELECT action, actor_id, metadata FROM eventhub.audit_event
          WHERE organization_id = $1 AND action LIKE 'registration.check%' ORDER BY occurred_at`,
        [t.orgId],
      );
      expect(audit.rows).toEqual([
        { action: 'registration.checked_in', actor_id: staff.id, metadata: { eventId: t.eventId } },
        {
          action: 'registration.check_in_undone',
          actor_id: staff.id,
          metadata: { eventId: t.eventId },
        },
      ]);
    });

    it('refuses cancelled registrations', async () => {
      const t = await setup();
      const ade = t.id('Ade Wisnu');
      await call({
        method: 'POST',
        url: `${t.base}/${ade}/cancel`,
        headers: { ...auth(t.owner), ...idem() },
      });
      const res = await t.act(ade, 'check-in');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.reason).toBe('registration_cancelled');
      // Cancelled people are not on the door list.
      expect((await t.door('ade')).json().data).toEqual([]);
    });

    it('checks in once when two doors scan the same person at the same moment', async () => {
      const t = await setup();
      const ade = t.id('Ade Wisnu');
      // Hold the row so both requests are in flight together, then let them through. Each
      // request must lock the row before reading it, or both would see "not checked in".
      const holder = await pools.migrator.connect();
      let results;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM eventhub.registration WHERE id = $1 FOR UPDATE', [ade]);
        const pending = Promise.all([t.act(ade, 'check-in'), t.act(ade, 'check-in')]);
        await new Promise((r) => setTimeout(r, 300));
        await holder.query('COMMIT');
        results = await pending;
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const audit = await pools.migrator.query(
        `SELECT count(*)::int AS n FROM eventhub.audit_event
          WHERE organization_id = $1 AND action = 'registration.checked_in'`,
        [t.orgId],
      );
      expect(audit.rows[0].n).toBe(1);
    });

    it('finds people by part of a name or the start of an email; wildcards are literal', async () => {
      const t = await setup();
      const names = async (q?: string) =>
        ((await t.door(q)).json().data as Array<{ name: string }>).map((r) => r.name);
      expect(await names()).toEqual(['Ade Wisnu', 'Budi 100% Santoso', 'Citra_Dewi']);
      expect(await names('WISNU')).toEqual(['Ade Wisnu']);
      expect(await names(t.people[1]!.email.slice(0, 12))).toEqual(['Budi 100% Santoso']);
      expect(await names('100%')).toEqual(['Budi 100% Santoso']);
      expect(await names('%')).toEqual(['Budi 100% Santoso']);
      expect(await names('_')).toEqual(['Citra_Dewi']);
      expect(await names('nobody')).toEqual([]);
      const bad = await t.door('a\u0007b');
      expect(bad.statusCode).toBe(400);
    });

    it('needs attendee.checkin, and keeps tenants apart', async () => {
      const t = await setup(['event_manager', 'viewer', 'admin']);
      const ade = t.id('Ade Wisnu');
      for (const role of ['event_manager', 'viewer']) {
        const as = t.members[role]!;
        expect((await t.door(undefined, as)).statusCode, role).toBe(403);
        const res = await t.act(ade, 'check-in', as);
        expect(res.statusCode, role).toBe(403);
        expect(res.json().error.details.reason).toBe('missing_permission:attendee.checkin');
      }
      expect((await t.act(ade, 'check-in', t.members.admin)).statusCode).toBe(200);

      const other = await setup();
      // Another organization's Owner: 404 for the list and the action.
      expect((await t.door(undefined, other.owner)).statusCode).toBe(404);
      expect((await t.act(t.id('Budi 100% Santoso'), 'check-in', other.owner)).statusCode).toBe(
        404,
      );
      // Another organization's registration under this organization's URL: not found.
      const crossed = await t.act(other.id('Ade Wisnu'), 'check-in');
      expect(crossed.statusCode).toBe(404);
      expect((await other.summary()).json().checkedIn).toBe(0);
    });
  });
});
