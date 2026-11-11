import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
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

/** Registration questions (ADR-0041): asked on the sign-up form, kept with the registration. */
describe('registration questions', () => {
  const pools = createTestPools();
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.73.${Math.floor(++ip / 250)}.${ip % 250}` });
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

  const QUESTIONS = [
    { id: 'company', type: 'short_text', label: 'Company', required: true },
    {
      id: 'diet',
      type: 'choice',
      label: 'Lunch',
      required: true,
      options: ['Regular', 'Vegetarian', 'Vegan'],
    },
    {
      id: 'notes',
      type: 'long_text',
      label: 'Anything we should know?',
      help: 'Optional.',
      required: false,
    },
    { id: 'photos', type: 'yes_no', label: 'May we photograph you?', required: true },
  ];
  const withQuestions = (extra: Record<string, unknown> = {}) =>
    publishedEvent({ capacity: 10, questions: QUESTIONS, ...extra }, ['registration_manager']);
  const VALID = { company: 'Acme', diet: 'Vegan', notes: 'Line one\nLine two', photos: false };
  const stored = async (eventId: string, addr: string) =>
    (
      await pools.migrator.query<{ answers: unknown }>(
        'SELECT answers FROM eventhub.registration WHERE event_id = $1 AND email = $2',
        [eventId, addr],
      )
    ).rows[0]?.answers;
  const fields = (res: { json(): { error: { details?: { fields?: Array<{ path: string }> } } } }) =>
    (res.json().error.details?.fields ?? []).map((f) => f.path);

  it('shows the questions on the public page', async () => {
    const t = await withQuestions();
    const page = (
      await call({ method: 'GET', url: `/v1/public/sites/${t.handle}/events/${t.slug}` })
    ).json();
    expect(page.registration.questions).toEqual(QUESTIONS);
    const plain = await publishedEvent();
    expect(
      (
        await call({ method: 'GET', url: `/v1/public/sites/${plain.handle}/events/${plain.slug}` })
      ).json().registration.questions,
    ).toEqual([]);
  });

  it('keeps valid answers with the registration, for registration managers only', async () => {
    const t = await withQuestions();
    const addr = email();
    const res = await t.register({
      name: 'Asker',
      email: addr,
      answers: { ...VALID, company: '  Acme  ' },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(await stored(t.eventId, addr)).toEqual(VALID);
    const list = (await t.list(t.members.registration_manager)).json().data;
    expect(list[0].answers).toEqual(VALID);
    // The door sees who, not what they answered.
    const door = await call({
      method: 'GET',
      url: `/v1/organizations/${t.orgId}/events/${t.eventId}/check-in?q=asker`,
      headers: auth(t.owner),
    });
    expect(door.json().data[0]).not.toHaveProperty('answers');
    // Nor does a scanned ticket.
    const ticket = await call({
      method: 'GET',
      url: `/v1/organizations/${t.orgId}/events/${t.eventId}/check-in?ticket=${list[0].id}`,
      headers: auth(t.owner),
    });
    expect(ticket.json().data[0].id).toBe(list[0].id);
    expect(ticket.json().data[0]).not.toHaveProperty('answers');
    // The export carries the questions for its columns, and the answers.
    const exp = (await t.exportList()).json();
    expect(exp.questions.map((q: { id: string }) => q.id)).toEqual([
      'company',
      'diet',
      'notes',
      'photos',
    ]);
    expect(exp.data[0].answers).toEqual(VALID);
    // Answers never enter audit or outbox records.
    const audit = await pools.migrator.query(
      'SELECT metadata FROM eventhub.audit_event WHERE organization_id = $1',
      [t.orgId],
    );
    const outbox = await pools.migrator.query(
      'SELECT payload FROM eventhub.outbox_event WHERE organization_id = $1',
      [t.orgId],
    );
    const dump = JSON.stringify([audit.rows, outbox.rows]);
    expect(dump).not.toContain('Acme');
    expect(dump).not.toContain('Vegan');
  });

  it('refuses missing, invalid or unknown answers, and stores nothing', async () => {
    const t = await withQuestions();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...VALID, company: '   ' }, 'body.answers.company'],
      [{ diet: 'Vegan', photos: true }, 'body.answers.company'],
      [{ ...VALID, diet: 'Pizza' }, 'body.answers.diet'],
      [{ ...VALID, diet: 'vegan' }, 'body.answers.diet'],
      [{ ...VALID, photos: 'yes' }, 'body.answers.photos'],
      [{ company: 'Acme', diet: 'Vegan' }, 'body.answers.photos'],
      [{ ...VALID, company: 'x'.repeat(201) }, 'body.answers.company'],
      [{ ...VALID, company: 'Two\nlines' }, 'body.answers.company'],
      [{ ...VALID, notes: 'Bell\u0007' }, 'body.answers.notes'],
      [{ ...VALID, company: true }, 'body.answers.company'],
      [{ ...VALID, extra: 'sneaky' }, 'body.answers.extra'],
    ];
    for (const [answers, path] of cases) {
      const addr = email();
      const res = await t.register({ name: 'Bad', email: addr, answers });
      expect(res.statusCode, path).toBe(400);
      expect(fields(res), path).toContain(path);
      expect(await stored(t.eventId, addr), path).toBeUndefined();
    }
    // Too many answers, or one far too long, fail the request shape itself.
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`q${i}`, 'x']));
    expect((await t.register({ name: 'Bad', email: email(), answers: many })).statusCode).toBe(400);
    expect(
      (
        await t.register({
          name: 'Bad',
          email: email(),
          answers: { ...VALID, notes: 'x'.repeat(2001) },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('drops empty optional answers, and needs none when the event asks none', async () => {
    const t = await withQuestions();
    const addr = email();
    expect(
      (await t.register({ name: 'Brief', email: addr, answers: { ...VALID, notes: '  ' } }))
        .statusCode,
    ).toBe(202);
    expect(await stored(t.eventId, addr)).toEqual({
      company: 'Acme',
      diet: 'Vegan',
      photos: false,
    });
    const plain = await publishedEvent();
    const addr2 = email();
    expect((await plain.register({ name: 'Plain', email: addr2 })).statusCode).toBe(202);
    expect(await stored(plain.eventId, addr2)).toEqual({});
    expect(
      (await plain.register({ name: 'Plain', email: email(), answers: { company: 'X' } }))
        .statusCode,
    ).toBe(400);
  });

  it('does not overwrite earlier answers on a repeat sign-up', async () => {
    const t = await withQuestions();
    const addr = email();
    await t.register({ name: 'Once', email: addr, answers: VALID });
    expect(
      (await t.register({ name: 'Twice', email: addr, answers: { ...VALID, company: 'Other' } }))
        .statusCode,
    ).toBe(202);
    expect(await stored(t.eventId, addr)).toEqual(VALID);
  });

  it('validates the questions in event settings', async () => {
    const t = await publishedEvent({}, []);
    const url = `/v1/organizations/${t.orgId}/events/${t.eventId}`;
    await pools.migrator.query(
      `UPDATE eventhub.event SET settings = jsonb_set(settings, '{sharing}', '{"title":"T","description":"D"}') WHERE id = $1`,
      [t.eventId],
    );
    const patch = async (questions: unknown) => {
      const { version } = (await call({ method: 'GET', url, headers: auth(t.owner) })).json();
      return call({
        method: 'PATCH',
        url,
        headers: { ...auth(t.owner), ...idem() },
        payload: { expectedVersion: version, settings: { registration: { questions } } },
      });
    };
    const q = (over: object) => ({
      id: 'q',
      type: 'short_text',
      label: 'Q',
      required: false,
      ...over,
    });
    for (const bad of [
      [q({ type: 'choice' })],
      [q({ type: 'choice', options: ['Only'] })],
      [q({ type: 'choice', options: ['A', 'a'] })],
      [q({ options: ['A', 'B'] })],
      [q({}), q({})],
      [q({ label: '' })],
      [q({ label: 'Two\nlines' })],
      [q({ type: 'date' })],
      [q({ id: 'Not An Id' })],
      [q({ placeholder: 'x' })],
      Array.from({ length: 11 }, (_, i) => q({ id: `q${i}` })),
    ]) {
      const res = await patch(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const ok = await patch(QUESTIONS);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().settings.registration.questions).toEqual(QUESTIONS);
  });

  it('keeps old sign-ups working and answers out of other tenants', async () => {
    const t = await withQuestions();
    const addr = email();
    await t.register({ name: 'Mine', email: addr, answers: VALID });
    // The pre-0024 function still works and stores no answers.
    const old = await pools.app.query<{ out_outcome: string }>(
      'SELECT out_outcome FROM eventhub.public_register($1, $2, $3, $4)',
      [t.handle, t.slug, email(), 'Old client'],
    );
    expect(old.rows[0]!.out_outcome).toBe('registered');
    const outsider = await createFixtureUser(pools.migrator);
    await createFixtureOrganization(pools.migrator, outsider.id);
    expect((await t.list(outsider)).statusCode).toBe(404);
    expect((await t.exportList(outsider)).statusCode).toBe(404);
    // Without tenant context the app role sees no registrations at all.
    const leaked = await pools.app.query(
      'SELECT answers FROM eventhub.registration WHERE event_id = $1',
      [t.eventId],
    );
    expect(leaked.rowCount).toBe(0);
  });
});
