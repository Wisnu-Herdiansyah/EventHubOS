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
  sendRegistrationDeclinedConsumer,
} from '../../apps/worker/src/consumers/send-registration-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';
import { sendAnnouncementConsumer } from '../../apps/worker/src/consumers/send-announcement.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret
const SITE = 'https://{handle}.eventhub.example';

/** Attendee self-service (ADR-0065): correcting your own details with your emailed link. */
describe('attendee self-service', () => {
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
      sharing: {
        title: 'Self-service test',
        description: 'An event used by the self-service tests.',
      },
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
  const QUESTIONS = [
    {
      id: 'diet',
      type: 'choice',
      label: 'Diet',
      required: true,
      options: ['None', 'Vegetarian', 'Vegan'],
    },
    { id: 'company', type: 'short_text', label: 'Company', required: false },
    { id: 'photo', type: 'yes_no', label: 'Photos OK?', required: false },
  ];
  const withQuestions = (registration: Record<string, unknown> = {}) =>
    publishedEvent({ capacity: 10, questions: QUESTIONS, ...registration });
  type T = Awaited<ReturnType<typeof withQuestions>>;
  const details = (token: unknown) =>
    call({ method: 'POST', url: '/v1/public/registrations/details', payload: { token } });
  const save = (payload: Record<string, unknown>) =>
    call({ method: 'POST', url: '/v1/public/registrations/details/update', payload });
  const stored = async (eventId: string, addr: string) =>
    (
      await pools.migrator.query<{
        id: string;
        name: string;
        answers: Record<string, unknown>;
        details_updated_at: Date | null;
        email: string;
        status: string;
      }>(
        'SELECT id, name, answers, details_updated_at, email, status FROM eventhub.registration WHERE event_id = $1 AND email = $2',
        [eventId, addr],
      )
    ).rows[0]!;
  const audits = async (orgId: string) =>
    (
      await pools.migrator.query<{ actor_type: string; metadata: Record<string, unknown> }>(
        `SELECT actor_type, metadata FROM eventhub.audit_event
          WHERE organization_id = $1 AND action = 'registration.details_changed' ORDER BY occurred_at`,
        [orgId],
      )
    ).rows;
  /** Registers someone and returns the token from their confirmation email. */
  async function registered(
    t: T,
    template = 'registration_confirmed',
    answers: Record<string, unknown> = { diet: 'None', company: 'Analytical Engines', photo: true },
  ) {
    const addr = email();
    const res = await t.register({
      name: 'Ada Lovelace',
      email: addr,
      answers,
    });
    expect(res.statusCode, res.body).toBe(202);
    await drain(() => mails(addr, template).length > 0);
    const mail = mails(addr, template)[0]!;
    // The whole line: the token and nothing after it.
    const m = /\/manage-registration#token=([A-Za-z0-9_-]{43})$/m.exec(mail.text);
    expect(m, 'manage link in the email').not.toBeNull();
    return { addr, token: m![1]!, mail };
  }

  it('the confirmation email links to the page, after the cancel link, with the same token', async () => {
    const t = await withQuestions();
    const p = await registered(t);
    expect(p.mail.text).toContain(
      `Need to correct your name or answers? https://${t.handle}.eventhub.example/manage-registration#token=${p.token}`,
    );
    // The cancel link is still the first link, and carries the same token.
    expect(tokenFrom(p.mail.text)).toBe(p.token);
    expect(p.mail.text.indexOf('cancel-registration')).toBeLessThan(
      p.mail.text.indexOf('manage-registration'),
    );
  });

  it('shows the person their own details, but never their email address', async () => {
    const t = await withQuestions();
    const p = await registered(t);
    const res = await details(p.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      eventName: expect.any(String),
      organizationName: expect.any(String),
      status: 'confirmed',
      name: 'Ada Lovelace',
      answers: { diet: 'None', company: 'Analytical Engines', photo: true },
      questions: expect.arrayContaining([expect.objectContaining({ id: 'diet' })]),
    });
    expect(res.body).not.toContain(p.addr);
  });

  it('saves a corrected name and answers, records when, and audits which fields only', async () => {
    const t = await withQuestions();
    const p = await registered(t);
    const res = await save({
      token: p.token,
      name: '  Augusta Ada King  ',
      answers: { diet: 'Vegan', company: '', photo: false },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'saved', eventName: expect.any(String), changed: true });
    const row = await stored(t.eventId, p.addr);
    expect(row.name).toBe('Augusta Ada King');
    // An emptied optional answer is removed.
    expect(row.answers).toEqual({ diet: 'Vegan', photo: false });
    expect(row.details_updated_at).toBeInstanceOf(Date);
    expect(row.email).toBe(p.addr);
    const a = await audits(t.orgId);
    expect(a).toEqual([
      {
        actor_type: 'system',
        metadata: { eventId: t.eventId, by: 'attendee', fields: ['name', 'answers'] },
      },
    ]);
    // Values never enter the audit record.
    expect(JSON.stringify(a)).not.toContain('Augusta');
    expect(JSON.stringify(a)).not.toContain('Vegan');
    // The organizer sees the change.
    const list = (await t.list()).json().data.find((r: { id: string }) => r.id === row.id);
    expect(list).toMatchObject({ name: 'Augusta Ada King', detailsUpdatedAt: expect.any(String) });
  });

  it('saving the same details again changes nothing and records nothing', async () => {
    const t = await withQuestions();
    const p = await registered(t);
    const before = await stored(t.eventId, p.addr);
    const res = await save({
      token: p.token,
      name: 'Ada Lovelace',
      answers: { diet: 'None', company: 'Analytical Engines', photo: true },
    });
    expect(res.json().changed).toBe(false);
    expect((await stored(t.eventId, p.addr)).details_updated_at).toBe(before.details_updated_at);
    expect(await audits(t.orgId)).toEqual([]);
    // Name only.
    await save({
      token: p.token,
      name: 'Ada L.',
      answers: { diet: 'None', company: 'Analytical Engines', photo: true },
    });
    expect((await audits(t.orgId)).map((x) => x.metadata.fields)).toEqual([['name']]);
  });

  it('a save without answers changes only the name and keeps the answers', async () => {
    const t = await withQuestions();
    const p = await registered(t);
    const res = await save({ token: p.token, name: 'Ada Renamed' });
    expect(res.statusCode, res.body).toBe(200);
    const row = await stored(t.eventId, p.addr);
    expect(row.name).toBe('Ada Renamed');
    expect(row.answers).toEqual({ diet: 'None', company: 'Analytical Engines', photo: true });
    expect((await audits(t.orgId)).map((x) => x.metadata.fields)).toEqual([['name']]);
  });

  it('checks answers against the event’s current questions', async () => {
    const t = await withQuestions();
    const p = await registered(t);
    const cases: [Record<string, unknown>, string][] = [
      [{ company: 'x' }, 'body.answers.diet'],
      [{ diet: 'Pescatarian' }, 'body.answers.diet'],
      [{ diet: 'None', photo: 'yes' }, 'body.answers.photo'],
      [{ diet: 'None', shoe: '42' }, 'body.answers.shoe'],
      [{ diet: 'None', company: 'x'.repeat(201) }, 'body.answers.company'],
    ];
    for (const [answers, path] of cases) {
      const res = await save({ token: p.token, name: 'Ada', answers });
      expect(res.statusCode, JSON.stringify(answers)).toBe(400);
      expect(JSON.stringify(res.json().error.details.fields)).toContain(path);
    }
    for (const name of ['', '   ', 'x'.repeat(121), 'Ada\nLovelace']) {
      expect((await save({ token: p.token, name, answers: { diet: 'None' } })).statusCode).toBe(
        400,
      );
    }
    // The email cannot be changed this way.
    expect(
      (
        await save({
          token: p.token,
          name: 'Ada',
          email: 'other@example.test',
          answers: { diet: 'None' },
        })
      ).statusCode,
    ).toBe(400);
    const row = await stored(t.eventId, p.addr);
    expect(row.name).toBe('Ada Lovelace');
    expect(row.details_updated_at).toBeNull();
    // An event without questions takes no answers.
    const plain = await publishedEvent({ capacity: 5 });
    const q = await registered(plain, 'registration_confirmed', {});
    expect((await save({ token: q.token, name: 'Plain Person' })).statusCode).toBe(200);
    expect(
      (await save({ token: q.token, name: 'Plain', answers: { diet: 'None' } })).statusCode,
    ).toBe(400);
  });

  it('works for people on the waitlist and waiting for approval too', async () => {
    const full = await withQuestions({ capacity: 1, waitlist: true });
    await registered(full);
    const w = await registered(full, 'registration_waitlisted');
    expect((await details(w.token)).json().status).toBe('waitlisted');
    expect(
      (await save({ token: w.token, name: 'Waiting Ada', answers: { diet: 'None' } })).statusCode,
    ).toBe(200);
    const asks = await withQuestions({ approval: true });
    const r = await registered(asks, 'registration_requested');
    expect((await details(r.token)).json().status).toBe('pending');
    expect(
      (await save({ token: r.token, name: 'Asking Ada', answers: { diet: 'Vegan' } })).statusCode,
    ).toBe(200);
    expect((await stored(asks.eventId, r.addr)).name).toBe('Asking Ada');
  });

  it('closed links all answer the same: unknown, cancelled, declined, ended, cancelled event', async () => {
    const same = async (token: string) => {
      for (const res of [
        await details(token),
        await save({ token, name: 'X', answers: { diet: 'None' } }),
      ]) {
        expect(res.statusCode).toBe(400);
        expect(res.json().error.details.reason).toBe('invalid_or_closed_link');
      }
    };
    await same('A'.repeat(43));
    expect((await details('short')).statusCode).toBe(400);

    const t = await withQuestions();
    const cancelled = await registered(t);
    const leave = await call({
      method: 'POST',
      url: '/v1/public/registrations/cancel',
      payload: { token: cancelled.token },
    });
    expect(leave.statusCode).toBe(200);
    await same(cancelled.token);

    const asks = await withQuestions({ approval: true });
    const declined = await registered(asks, 'registration_requested');
    const row = await stored(asks.eventId, declined.addr);
    const decline = await call({
      method: 'POST',
      url: `${asks.base}/${row.id}/decline`,
      headers: { ...auth(asks.owner), ...idem() },
    });
    expect(decline.statusCode).toBe(200);
    await same(declined.token);

    const ended = await withQuestions();
    const late = await registered(ended);
    await pools.migrator.query(
      `UPDATE eventhub.event SET starts_at = now() - interval '3 hours', ends_at = now() - interval '1 minute' WHERE id = $1`,
      [ended.eventId],
    );
    await same(late.token);

    const called = await withQuestions();
    const off = await registered(called);
    await pools.migrator.query(
      `UPDATE eventhub.event SET cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'x' WHERE id = $1`,
      [called.eventId, called.owner.id],
    );
    await same(off.token);
    expect((await stored(called.eventId, off.addr)).name).toBe('Ada Lovelace');
  });

  it('a link changes only its own entry: not others at the same event, nor elsewhere', async () => {
    const a = await withQuestions();
    const b = await withQuestions();
    const pa = await registered(a);
    const neighbour = await registered(a);
    const pb = await registered(b);
    await save({ token: pa.token, name: 'Only Me', answers: { diet: 'Vegan' } });
    expect((await stored(a.eventId, pa.addr)).name).toBe('Only Me');
    const n = await stored(a.eventId, neighbour.addr);
    expect(n.name).toBe('Ada Lovelace');
    expect(n.answers).toEqual({ diet: 'None', company: 'Analytical Engines', photo: true });
    expect(n.details_updated_at).toBeNull();
    expect((await stored(b.eventId, pb.addr)).name).toBe('Ada Lovelace');
    // Each organization's audit has only its own change.
    expect(await audits(a.orgId)).toHaveLength(1);
    expect(await audits(b.orgId)).toHaveLength(0);
  });

  it('the database refuses a closed entry on its own, not only through the API', async () => {
    const hash = (token: string) => createHash('sha256').update(token).digest();
    const tryUpdate = async (token: string) =>
      (
        await pools.app.query('SELECT * FROM eventhub.public_update_registration($1, $2, $3)', [
          hash(token),
          'Changed Directly',
          '{"diet":"Vegan"}',
        ])
      ).rowCount;
    const t = await withQuestions();
    const cancelled = await registered(t);
    await pools.migrator.query(
      `UPDATE eventhub.registration SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'organizer' WHERE event_id = $1 AND email = $2`,
      [t.eventId, cancelled.addr],
    );
    expect(await tryUpdate(cancelled.token)).toBe(0);
    const ended = await withQuestions();
    const late = await registered(ended);
    await pools.migrator.query(
      `UPDATE eventhub.event SET starts_at = now() - interval '3 hours', ends_at = now() - interval '1 minute' WHERE id = $1`,
      [ended.eventId],
    );
    expect(await tryUpdate(late.token)).toBe(0);
    const called = await withQuestions();
    const off = await registered(called);
    await pools.migrator.query(
      `UPDATE eventhub.event SET cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'x' WHERE id = $1`,
      [called.eventId, called.owner.id],
    );
    expect(await tryUpdate(off.token)).toBe(0);
    const ended2 = await withQuestions();
    const archived = await registered(ended2);
    await pools.migrator.query(
      `UPDATE eventhub.event SET lifecycle = 'ended', starts_at = now() + interval '1 day', ends_at = now() + interval '2 days' WHERE id = $1`,
      [ended2.eventId],
    );
    expect(await tryUpdate(archived.token)).toBe(0);
    for (const [eventId, addr] of [
      [t.eventId, cancelled.addr],
      [ended.eventId, late.addr],
      [called.eventId, off.addr],
      [ended2.eventId, archived.addr],
    ] as const) {
      expect((await stored(eventId, addr)).name).toBe('Ada Lovelace');
    }
  });

  it('only the API role may call the functions; the worker may not', async () => {
    await expect(
      pools.worker.query('SELECT * FROM eventhub.public_registration_details($1)', [
        Buffer.alloc(32),
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      pools.worker.query('SELECT * FROM eventhub.public_update_registration($1, $2, $3)', [
        Buffer.alloc(32),
        'x',
        '{}',
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});
