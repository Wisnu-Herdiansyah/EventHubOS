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
import { deriveEmailToken } from '../../apps/worker/src/consumers/verification-token.ts';
import { sendFeedbackRequestsOnce } from '../../apps/worker/src/event-feedback.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret
const SITE = 'https://{handle}.eventhub.example';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Post-event feedback (ADR-0063): who is asked, the personal link, answers, and who reads them. */
describe('event feedback', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.82.${Math.floor(++ip / 250)}.${ip % 250}` });
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

  const email = () => `fb-${randomUUID().slice(0, 12)}@example.test`;
  const to = (addr: string) => inbox.sent.filter((m) => m.to === addr);
  const pass = (
    sender: { name: string; send(m: EmailMessage): Promise<void> } = inbox,
    publicSiteUrl: string | null = SITE,
  ) => sendFeedbackRequestsOnce(pools.worker, sender, { publicSiteUrl, tokenSecret: SECRET });
  const drain = async () => {
    for (let i = 0; i < 20 && (await pass()) > 0; i++);
  };
  const tokenIn = (m: EmailMessage) => /feedback#token=([A-Za-z0-9_-]{43})/.exec(m.text)![1]!;

  interface EventOptions {
    endedHoursAgo?: number;
    lifecycle?: string;
    feedback?: Record<string, unknown> | null;
    handle?: boolean;
    roles?: string[];
  }
  async function event(options: EventOptions = {}) {
    const owner = await createFixtureUser(pools.migrator);
    const orgId = await createFixtureOrganization(pools.migrator, owner.id);
    const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
    const handle = `f-${randomUUID().slice(0, 8)}`;
    await pools.migrator.query(
      `UPDATE eventhub.organization SET public_handle = $2, display_name = 'Feedback Org' WHERE id = $1`,
      [orgId, options.handle === false ? null : handle],
    );
    const ends = new Date(Date.now() - (options.endedHoursAgo ?? 1) * HOUR);
    const settings =
      options.feedback === null ? {} : { feedback: options.feedback ?? { enabled: true } };
    await pools.migrator.query(
      `UPDATE eventhub.event SET name = 'Annual Gathering', lifecycle = $2, settings = $3,
              starts_at = $4, ends_at = $5,
              archived_from = CASE WHEN $2 = 'archived' THEN 'ended' END
        WHERE id = $1`,
      [
        eventId,
        options.lifecycle ?? 'published',
        JSON.stringify(settings),
        new Date(ends.getTime() - 2 * HOUR),
        ends,
      ],
    );
    const members: Record<string, FixtureUser> = {};
    for (const role of options.roles ?? []) {
      const u = await createFixtureUser(pools.migrator);
      await addFixtureMembership(pools.migrator, orgId, u.id, role);
      members[role] = u;
    }
    /** A registration; `checkedIn` records attendance at the desk. */
    const person = async (opts: { status?: string; checkedIn?: boolean; name?: string } = {}) => {
      const addr = email();
      const status = opts.status ?? 'confirmed';
      const { rows } = await pools.migrator.query<{ id: string }>(
        `INSERT INTO eventhub.registration (organization_id, event_id, email, name, status,
                                            privacy_policy_url, created_at, cancelled_at, cancelled_by,
                                            checked_in_at, checked_in_by)
         VALUES ($1, $2, $3, $4, $5, 'https://example.com/privacy', now() - interval '10 days',
                 CASE WHEN $5 = 'cancelled' THEN now() END,
                 CASE WHEN $5 = 'cancelled' THEN 'attendee' END,
                 CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN $7::uuid END)
         RETURNING id`,
        [
          orgId,
          eventId,
          addr,
          opts.name ?? 'Ada Attendee',
          status,
          opts.checkedIn === true,
          owner.id,
        ],
      );
      return { addr, id: rows[0]!.id };
    };
    const summary = (as: FixtureUser = owner) =>
      call({
        method: 'GET',
        url: `/v1/organizations/${orgId}/events/${eventId}/feedback`,
        headers: auth(as),
      });
    const comments = (as: FixtureUser = owner) =>
      call({
        method: 'GET',
        url: `/v1/organizations/${orgId}/events/${eventId}/feedback/comments`,
        headers: auth(as),
      });
    return { owner, orgId, eventId, handle, members, person, summary, comments };
  }
  /** Asks one checked-in person and returns their link's token. */
  async function asked(t: Awaited<ReturnType<typeof event>>, name?: string) {
    const p = await t.person({ checkedIn: true, ...(name ? { name } : {}) });
    await drain();
    return { ...p, token: tokenIn(to(p.addr)[0]!) };
  }
  const lookup = (token: unknown) =>
    call({ method: 'POST', url: '/v1/public/feedback/lookup', payload: { token } });
  const submit = (payload: Record<string, unknown>) =>
    call({ method: 'POST', url: '/v1/public/feedback', payload });
  const row = async (registrationId: string) =>
    (
      await pools.migrator.query<{ rating: number; comment: string | null }>(
        'SELECT rating, comment FROM eventhub.event_feedback WHERE registration_id = $1',
        [registrationId],
      )
    ).rows[0];
  const state = async (id: string) =>
    (
      await pools.migrator.query<{
        feedback_requested_at: Date | null;
        feedback_token_hash: Buffer | null;
      }>(
        'SELECT feedback_requested_at, feedback_token_hash FROM eventhub.registration WHERE id = $1',
        [id],
      )
    ).rows[0]!;

  describe('who is asked', () => {
    it('asks a person who attended once, with a personal link whose hash is stored', async () => {
      const t = await event();
      const p = await t.person({ checkedIn: true });
      await drain();
      const mails = to(p.addr);
      expect(mails).toHaveLength(1);
      const m = mails[0]!;
      expect(m.template).toBe('event_feedback_request');
      expect(m.subject).toBe('How was Annual Gathering?');
      expect(m.messageId).toBe(`event-feedback-${p.id}`);
      expect(m.text).toContain('Hello Ada Attendee,');
      expect(m.text).toContain(`https://${t.handle}.eventhub.example/feedback#token=`);
      expect(m.text).toContain('shared with the organizer without your name');
      expect(m.text).toContain('Sent by Feedback Org.');
      const s = await state(p.id);
      expect(s.feedback_requested_at).toBeInstanceOf(Date);
      // Only the hash of the token is kept, and it is this person's own token.
      const token = tokenIn(m);
      expect(s.feedback_token_hash!.equals(createHash('sha256').update(token).digest())).toBe(true);
      expect(token).toBe(deriveEmailToken(SECRET, 'event-feedback', p.id));
      await drain();
      expect(to(p.addr)).toHaveLength(1);
    });

    it('asks nobody unless the organizer switched feedback on', async () => {
      const unset = await event({ feedback: null });
      const off = await event({ feedback: { enabled: false } });
      const empty = await event({ feedback: {} });
      const people = [
        await unset.person({ checkedIn: true }),
        await off.person({ checkedIn: true }),
        await empty.person({ checkedIn: true }),
      ];
      await drain();
      for (const p of people) expect(to(p.addr)).toHaveLength(0);
      // Switched on within the week: they are asked.
      await pools.migrator.query(
        `UPDATE eventhub.event SET settings = '{"feedback":{"enabled":true}}' WHERE id = $1`,
        [unset.eventId],
      );
      await drain();
      expect(to(people[0]!.addr)).toHaveLength(1);
    });

    it('asks only after the event has ended, and for a week', async () => {
      const running = await event({ endedHoursAgo: -1 });
      const justEnded = await event({ endedHoursAgo: 0.01 });
      const sixDays = await event({ endedHoursAgo: 6 * 24 });
      const eightDays = await event({ endedHoursAgo: 8 * 24 });
      const people = {
        running: await running.person({ checkedIn: true }),
        justEnded: await justEnded.person({ checkedIn: true }),
        sixDays: await sixDays.person({ checkedIn: true }),
        eightDays: await eightDays.person({ checkedIn: true }),
      };
      await drain();
      expect(
        Object.fromEntries(Object.entries(people).map(([k, p]) => [k, to(p.addr).length])),
      ).toEqual({ running: 0, justEnded: 1, sixDays: 1, eightDays: 0 });
    });

    it('asks only for events that were public and went ahead', async () => {
      const people: Record<string, string> = {};
      for (const lifecycle of ['draft', 'scheduled', 'published', 'live', 'ended', 'archived']) {
        const t = await event({ lifecycle });
        people[lifecycle] = (await t.person({ checkedIn: true })).addr;
      }
      const called = await event();
      const off = await called.person({ checkedIn: true });
      await pools.migrator.query(
        `UPDATE eventhub.event SET cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Venue closed'
          WHERE id = $1`,
        [called.eventId, called.owner.id],
      );
      const noSite = await event({ handle: false });
      const nowhere = await noSite.person({ checkedIn: true });
      await drain();
      expect(
        Object.fromEntries(Object.entries(people).map(([k, addr]) => [k, to(addr).length])),
      ).toEqual({ draft: 0, scheduled: 0, published: 1, live: 1, ended: 1, archived: 0 });
      expect(to(off.addr)).toHaveLength(0);
      expect(to(nowhere.addr)).toHaveLength(0);
    });

    it('asks those who checked in; when nobody was checked in, everyone with a seat', async () => {
      const desk = await event();
      const came = await desk.person({ checkedIn: true });
      const noShow = await desk.person();
      const cancelled = await desk.person({ status: 'cancelled' });
      const noDesk = await event();
      const seated = await noDesk.person();
      const alsoSeated = await noDesk.person();
      const waiting = await noDesk.person({ status: 'waitlisted' });
      const gone = await noDesk.person({ status: 'cancelled' });
      await drain();
      expect(to(came.addr)).toHaveLength(1);
      expect(to(noShow.addr)).toHaveLength(0);
      expect(to(cancelled.addr)).toHaveLength(0);
      expect(to(seated.addr)).toHaveLength(1);
      expect(to(alsoSeated.addr)).toHaveLength(1);
      expect(to(waiting.addr)).toHaveLength(0);
      expect(to(gone.addr)).toHaveLength(0);
    });

    it('a failed send marks nobody, and the retry asks each person exactly once', async () => {
      await drain();
      const t = await event();
      const people = [
        await t.person({ checkedIn: true }),
        await t.person({ checkedIn: true }),
        await t.person({ checkedIn: true }),
      ];
      const mine = (m: EmailMessage) => people.some((p) => p.addr === m.to);
      const delivered = new Map<string, EmailMessage>();
      const attempts: EmailMessage[] = [];
      let failures = 1;
      let seen = 0;
      const flaky = {
        name: 'flaky',
        send(m: EmailMessage): Promise<void> {
          if (mine(m)) attempts.push(m);
          if (mine(m) && ++seen === 2 && failures-- > 0)
            return Promise.reject(new Error('provider down'));
          delivered.set(m.messageId, m);
          return Promise.resolve();
        },
      };
      await expect(pass(flaky)).rejects.toThrow('provider down');
      for (const p of people) expect((await state(p.id)).feedback_requested_at).toBeNull();
      for (let i = 0; i < 20 && (await pass(flaky)) > 0; i++);
      const ours = [...delivered.values()].filter(mine);
      expect(ours.map((m) => m.to).sort()).toEqual(people.map((p) => p.addr).sort());
      // A retried email is byte-identical, so the link already delivered still works.
      for (const p of people) {
        const texts = new Set(attempts.filter((m) => m.to === p.addr).map((m) => m.text));
        expect(texts.size).toBe(1);
        expect((await lookup(tokenIn(ours.find((m) => m.to === p.addr)!))).statusCode).toBe(200);
      }
    });

    it('without a public site address nobody is asked or marked', async () => {
      await drain();
      const t = await event();
      const p = await t.person({ checkedIn: true });
      expect(await pass(inbox, null)).toBe(0);
      expect((await state(p.id)).feedback_requested_at).toBeNull();
      expect(to(p.addr)).toHaveLength(0);
    });

    it('a worker never waits for people another worker is already asking', async () => {
      await drain();
      const t = await event();
      const p = await t.person({ checkedIn: true });
      const busy = await pools.worker.connect();
      try {
        await busy.query('BEGIN');
        await busy.query('SELECT out_registration_id FROM eventhub.event_feedback_due(500)');
        const other = pass();
        const outcome = await Promise.race([
          other,
          new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 1500)),
        ]);
        await busy.query('ROLLBACK');
        await other;
        expect(outcome).toBe(0);
      } finally {
        busy.release();
      }
      await drain();
      expect(to(p.addr)).toHaveLength(1);
    });

    it('marking needs the registration’s own organization, and keeps the first link', async () => {
      const t = await event({ endedHoursAgo: -1 });
      const other = await event({ endedHoursAgo: -1 });
      const p = await t.person({ checkedIn: true });
      const h1 = createHash('sha256').update('one').digest();
      const h2 = createHash('sha256').update('two').digest();
      await pools.worker.query('SELECT eventhub.event_feedback_mark($1, $2, $3)', [
        p.id,
        other.orgId,
        h1,
      ]);
      expect((await state(p.id)).feedback_requested_at).toBeNull();
      await pools.worker.query('SELECT eventhub.event_feedback_mark($1, $2, $3)', [
        p.id,
        t.orgId,
        h1,
      ]);
      await pools.worker.query('SELECT eventhub.event_feedback_mark($1, $2, $3)', [
        p.id,
        t.orgId,
        h2,
      ]);
      expect((await state(p.id)).feedback_token_hash!.equals(h1)).toBe(true);
    });
  });

  describe('the personal link', () => {
    it('shows what it is for, and whether the person has answered', async () => {
      const t = await event();
      const p = await asked(t);
      const first = await lookup(p.token);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({
        eventName: 'Annual Gathering',
        organizationName: 'Feedback Org',
        answered: false,
      });
      expect((await submit({ token: p.token, rating: 4 })).statusCode).toBe(200);
      expect((await lookup(p.token)).json().answered).toBe(true);
    });

    it('stores a rating and a comment, and a second answer replaces the first', async () => {
      const t = await event();
      const p = await asked(t);
      const res = await submit({ token: p.token, rating: 5, comment: '  Loved the keynote.  ' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'received', eventName: 'Annual Gathering' });
      expect(await row(p.id)).toEqual({ rating: 5, comment: 'Loved the keynote.' });
      expect((await submit({ token: p.token, rating: 2, comment: '   ' })).statusCode).toBe(200);
      expect(await row(p.id)).toEqual({ rating: 2, comment: null });
      expect((await submit({ token: p.token, rating: 3 })).statusCode).toBe(200);
      expect(await row(p.id)).toEqual({ rating: 3, comment: null });
      const n = await pools.migrator.query(
        'SELECT 1 FROM eventhub.event_feedback WHERE registration_id = $1',
        [p.id],
      );
      expect(n.rowCount).toBe(1);
    });

    it('refuses anything that is not a rating from 1 to 5 with a short comment', async () => {
      const t = await event();
      const p = await asked(t);
      for (const bad of [
        { token: p.token },
        { token: p.token, rating: 0 },
        { token: p.token, rating: 6 },
        { token: p.token, rating: 4.5 },
        { token: p.token, rating: '5' },
        { token: p.token, rating: 5, comment: 'x'.repeat(2001) },
        { token: p.token, rating: 5, name: 'Ada' },
        { token: 'short', rating: 5 },
        { rating: 5 },
      ]) {
        const res = await submit(bad);
        expect(res.statusCode, JSON.stringify(Object.keys(bad))).toBe(400);
      }
      expect(await row(p.id)).toBeUndefined();
      expect(
        (await submit({ token: p.token, rating: 5, comment: 'x'.repeat(2000) })).statusCode,
      ).toBe(200);
    });

    it('unknown, foreign and expired links all answer the same, and store nothing', async () => {
      const t = await event();
      const p = await asked(t);
      const same = async (token: string) => {
        const a = await lookup(token);
        const b = await submit({ token, rating: 1, comment: 'nope' });
        for (const res of [a, b]) {
          expect(res.statusCode).toBe(400);
          expect(res.json().error.details.reason).toBe('invalid_or_expired_link');
          expect(res.json().error.message).toBe('This link is no longer valid.');
        }
      };
      await same(deriveEmailToken(SECRET, 'event-feedback', randomUUID()));
      // A token minted for another purpose, or with another secret, is not a feedback link.
      await same(deriveEmailToken(SECRET, 'registration-cancel', p.id));
      await same(deriveEmailToken(`${SECRET}-other`, 'event-feedback', p.id));

      // More than 30 days after the end.
      await pools.migrator.query(
        `UPDATE eventhub.event SET starts_at = $2, ends_at = $3 WHERE id = $1`,
        [
          t.eventId,
          new Date(Date.now() - 31 * DAY - 2 * HOUR),
          new Date(Date.now() - 30 * DAY - HOUR),
        ],
      );
      await same(p.token);
      // Just inside 30 days it works.
      await pools.migrator.query(`UPDATE eventhub.event SET ends_at = $2 WHERE id = $1`, [
        t.eventId,
        new Date(Date.now() - 30 * DAY + HOUR),
      ]);
      expect((await lookup(p.token)).statusCode).toBe(200);

      // The registration is cancelled afterwards.
      await pools.migrator.query(
        `UPDATE eventhub.registration SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'organizer' WHERE id = $1`,
        [p.id],
      );
      await same(p.token);
      expect(await row(p.id)).toBeUndefined();

      // The event is cancelled afterwards.
      const t2 = await event();
      const p2 = await asked(t2);
      await pools.migrator.query(
        `UPDATE eventhub.event SET cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'x' WHERE id = $1`,
        [t2.eventId, t2.owner.id],
      );
      await same(p2.token);
    });
  });

  describe('what organizers see', () => {
    it('figures for report readers, comments for those who manage registrations', async () => {
      const t = await event({ roles: ['analyst', 'admin'] });
      const people = [
        await asked(t, 'Grace Hopper'),
        await asked(t),
        await asked(t),
        await asked(t),
      ];
      await asked(t); // asked, never answers
      await submit({ token: people[0]!.token, rating: 5, comment: 'Wonderful.' });
      await submit({ token: people[1]!.token, rating: 4 });
      await submit({ token: people[2]!.token, rating: 4, comment: 'Too cold in the hall.' });
      await submit({ token: people[3]!.token, rating: 2, comment: 'Late start.' });

      for (const who of [t.owner, t.members.analyst!, t.members.admin!]) {
        const res = await t.summary(who);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          enabled: true,
          asked: 5,
          responses: 4,
          average: 3.8,
          ratings: [0, 1, 0, 2, 1],
        });
      }
      const list = await t.comments(t.members.admin);
      expect(list.statusCode).toBe(200);
      const body = list.json<{
        items: { rating: number; comment: string }[];
        truncated: boolean;
      }>();
      expect(body.truncated).toBe(false);
      // Newest first, and only answers with a comment.
      expect(body.items.map((i) => [i.rating, i.comment])).toEqual([
        [2, 'Late start.'],
        [4, 'Too cold in the hall.'],
        [5, 'Wonderful.'],
      ]);
      // Never who said it.
      const raw = list.body;
      for (const p of people) {
        expect(raw).not.toContain(p.addr);
        expect(raw).not.toContain(p.id);
      }
      expect(raw).not.toContain('Grace Hopper');
      expect(Object.keys(body.items[0]!).sort()).toEqual(['comment', 'rating', 'submittedAt']);
      // An analyst sees figures, not what people wrote.
      expect((await t.comments(t.members.analyst)).statusCode).toBe(403);
    });

    it('an event with no answers reports zeros, and whether feedback is on', async () => {
      const on = await event({ endedHoursAgo: -5 });
      expect((await on.summary()).json()).toEqual({
        enabled: true,
        asked: 0,
        responses: 0,
        average: null,
        ratings: [0, 0, 0, 0, 0],
      });
      const off = await event({ feedback: null });
      expect((await off.summary()).json().enabled).toBe(false);
      expect((await off.comments()).json()).toEqual({ items: [], truncated: false });
    });

    it('the switch is an event setting: on, then cleared, through the API', async () => {
      // A draft: its settings can be edited freely.
      const t = await event({ feedback: null, endedHoursAgo: -48, lifecycle: 'draft' });
      const url = `/v1/organizations/${t.orgId}/events/${t.eventId}`;
      const patch = async (settings: Record<string, unknown>) => {
        const current = (await call({ method: 'GET', url, headers: auth(t.owner) })).json<{
          version: number;
        }>();
        return call({
          method: 'PATCH',
          url,
          headers: { ...auth(t.owner), 'idempotency-key': `k-${randomUUID()}` },
          payload: { expectedVersion: current.version, settings },
        });
      };
      expect((await t.summary()).json().enabled).toBe(false);
      const on = await patch({ feedback: { enabled: true } });
      expect(on.statusCode).toBe(200);
      expect(on.json().settings.feedback).toEqual({ enabled: true });
      expect((await t.summary()).json().enabled).toBe(true);
      expect((await patch({ feedback: null })).statusCode).toBe(200);
      expect((await t.summary()).json().enabled).toBe(false);
      for (const bad of [{ enabled: 'yes' }, { enabled: true, after: 3 }, true]) {
        expect((await patch({ feedback: bad })).statusCode, JSON.stringify(bad)).toBe(400);
      }
    });

    it('another organization sees neither the figures nor the comments', async () => {
      const t = await event();
      const p = await asked(t);
      await submit({ token: p.token, rating: 1, comment: 'Private to this organizer.' });
      const other = await event();
      expect((await t.summary(other.owner)).statusCode).toBe(404);
      expect((await t.comments(other.owner)).statusCode).toBe(404);
      // Their own event's address with this event's ID finds nothing either.
      const crossed = await call({
        method: 'GET',
        url: `/v1/organizations/${other.orgId}/events/${t.eventId}/feedback/comments`,
        headers: auth(other.owner),
      });
      expect(crossed.statusCode).toBe(404);
      expect(
        (
          await call({
            method: 'GET',
            url: `/v1/organizations/${t.orgId}/events/${t.eventId}/feedback`,
          })
        ).statusCode,
      ).toBe(401);
    });
  });

  describe('database boundaries', () => {
    it('answers can only be written through the public function', async () => {
      const t = await event();
      const p = await asked(t);
      const client = await pools.app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('eventhub.organization_id', $1, true)`, [t.orgId]);
        await expect(
          client.query(
            `INSERT INTO eventhub.event_feedback (organization_id, event_id, registration_id, rating)
             VALUES ($1, $2, $3, 5)`,
            [t.orgId, t.eventId, p.id],
          ),
        ).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('each role has only its own functions', async () => {
      const hash = createHash('sha256').update('x').digest();
      await expect(
        pools.app.query('SELECT * FROM eventhub.event_feedback_due(10)'),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pools.app.query('SELECT eventhub.event_feedback_mark($1, $2, $3)', [
          randomUUID(),
          randomUUID(),
          hash,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pools.worker.query('SELECT * FROM eventhub.public_feedback_submit($1, 5, null)', [hash]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        pools.worker.query('SELECT * FROM eventhub.event_feedback LIMIT 1'),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
