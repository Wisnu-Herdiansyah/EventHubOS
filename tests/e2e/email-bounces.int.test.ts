import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { Webhook } from 'standardwebhooks';
import { InMemoryEmailSender } from '@eventhub/kernel';
import { createPool } from '@eventhub/db';
import {
  createFixtureEvent,
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
  testDatabaseUrls,
  type FixtureUser,
} from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { ResendEmailFeedbackReceiver } from '../../apps/api/src/adapters/resend-email-feedback.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';
import {
  SuppressingEmailSender,
  suppressionLookup,
} from '../../apps/worker/src/adapters/suppressing-email-sender.ts';
import { sendAnnouncementConsumer } from '../../apps/worker/src/consumers/send-announcement.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

// Generated per run: a test-only webhook secret.
const SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const URL = '/v1/webhooks/email-feedback';

/** Email bounces and complaints (ADR-0043): webhook, suppression list, worker, attendee list. */
describe('email bounces and complaints', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  // The worker's real wiring: the sender consults the suppression list through its own role.
  // As in the worker: lookups through their own pool, never the outbox pool.
  const lookupPool = createPool({
    connectionString: testDatabaseUrls().workerUrl,
    applicationName: 'test-worker-suppression',
    max: 1,
  });
  const sender = new SuppressingEmailSender(inbox, suppressionLookup(lookupPool));
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendAnnouncementConsumer(sender, { publicSiteUrl: null }),
  ]);
  let app: FastifyInstance;
  let off: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions, on = () => app) =>
    on().inject({ ...opts, remoteAddress: `10.74.${Math.floor(++ip / 250)}.${ip % 250}` });
  const auth = (u: FixtureUser) => ({ authorization: `Bearer ${u.token}` });

  beforeAll(async () => {
    const deps = {
      pool: pools.app,
      authenticator: new DatabaseSessionAuthenticator(pools.app),
      passwordHasher: new Argon2idPasswordHasher(),
      identity: { sessionTtlSeconds: 3600, loginMaxFailures: 5, loginLockSeconds: 900 },
      logger: false as const,
      validateResponses: true,
      rateLimitPerMinute: 10_000,
    };
    app = await buildApp({ ...deps, emailFeedback: new ResendEmailFeedbackReceiver(SECRET) });
    off = await buildApp(deps);
  });
  afterAll(async () => {
    await app.close();
    await off.close();
    await lookupPool.end();
    await pools.end();
  });

  const TYPES = {
    bounce: 'email.bounced',
    complaint: 'email.complained',
    delivered: 'email.delivered',
    other: 'email.opened',
  };
  /** A signed provider delivery, as Resend sends it. */
  function delivery(
    type: keyof typeof TYPES,
    to: string[],
    opts: { at?: Date; id?: string; secret?: string; sentAt?: Date } = {},
  ) {
    const at = opts.at ?? new Date();
    const body = JSON.stringify({
      type: TYPES[type],
      created_at: at.toISOString(),
      data: {
        email_id: `email-${randomUUID()}`,
        to,
        from: 'x@example.test',
        subject: 's',
        created_at: at.toISOString(),
      },
    });
    const id = opts.id ?? `msg_${randomUUID().replace(/-/g, '')}`;
    const sentAt = opts.sentAt ?? new Date();
    return {
      id,
      body,
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': String(Math.floor(sentAt.getTime() / 1000)),
        'svix-signature': new Webhook(opts.secret ?? SECRET).sign(id, sentAt, body),
      },
    };
  }
  const post = (d: { body: string; headers: Record<string, string> }, on = () => app) =>
    call({ method: 'POST', url: URL, payload: d.body, headers: d.headers }, on);
  const suppression = async (address: string) =>
    (
      await pools.migrator.query<{ reason: string; event_count: number; lifted: boolean }>(
        `SELECT reason, event_count, lifted_at IS NOT NULL AS lifted
           FROM eventhub.email_suppression WHERE address = $1`,
        [address],
      )
    ).rows[0] ?? null;
  const address = () => `person-${randomUUID()}@example.test`;

  it('is off without a webhook secret', async () => {
    const res = await post(delivery('bounce', [address()]), () => off);
    expect(res.statusCode).toBe(404);
  });

  it('records a signed bounce once, however often it is delivered', async () => {
    const a = address();
    const d = delivery('bounce', [a.toUpperCase()]);
    const res = await post(d);
    expect(res.statusCode, res.body).toBe(204);
    expect(await suppression(a)).toEqual({ reason: 'bounce', event_count: 1, lifted: false });
    // The provider retries the same event: nothing changes.
    expect((await post(d)).statusCode).toBe(204);
    expect(await suppression(a)).toEqual({ reason: 'bounce', event_count: 1, lifted: false });
    const ledger = await pools.migrator.query(
      'SELECT kind, recipient_count FROM eventhub.email_feedback_event WHERE event_id = $1',
      [d.id],
    );
    expect(ledger.rows).toEqual([{ kind: 'bounce', recipient_count: 1 }]);
    // The ledger keeps no addresses.
    const columns = await pools.migrator.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'eventhub' AND table_name = 'email_feedback_event'`,
    );
    expect(columns.rows.map((c) => c.column_name)).not.toContain('address');
  });

  it('refuses forged, tampered, stale and malformed deliveries, recording nothing', async () => {
    const a = address();
    const forged = delivery('complaint', [a], {
      secret: `whsec_${randomBytes(24).toString('base64')}`,
    });
    const r1 = await post(forged);
    expect(r1.statusCode).toBe(401);
    expect(r1.json().error.details.reason).toBe('webhook_signature');
    const d = delivery('complaint', [a]);
    expect((await post({ ...d, body: d.body.replace(a, address()) })).statusCode).toBe(401);
    const { 'svix-signature': _drop, ...unsigned } = d.headers;
    expect((await post({ body: d.body, headers: unsigned })).statusCode).toBe(401);
    const stale = await post(
      delivery('complaint', [a], { sentAt: new Date(Date.now() - 10 * 60_000) }),
    );
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.details.reason).toBe('webhook_timestamp');
    // Correctly signed, but not something we understand.
    const id = 'msg_malformed1';
    const sentAt = new Date();
    const body = JSON.stringify({ type: 'email.bounced', data: { to: 'nobody' } });
    const malformed = await post({
      body,
      headers: {
        'content-type': 'application/json',
        'svix-id': id,
        'svix-timestamp': String(Math.floor(sentAt.getTime() / 1000)),
        'svix-signature': new Webhook(SECRET).sign(id, sentAt, body),
      },
    });
    expect(malformed.statusCode).toBe(400);
    expect(await suppression(a)).toBeNull();
    // Only JSON is accepted.
    const text = await call({
      method: 'POST',
      url: URL,
      payload: d.body,
      headers: { ...d.headers, 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(415);
  });

  it('acknowledges other event types without recording them', async () => {
    const a = address();
    expect((await post(delivery('other', [a]))).statusCode).toBe(204);
    expect(await suppression(a)).toBeNull();
  });

  it('lets a complaint win over a bounce; a later delivery lifts a bounce but never a complaint', async () => {
    const bounced = address();
    const complained = address();
    const t0 = new Date(Date.now() - 60_000);
    await post(delivery('bounce', [bounced, complained], { at: t0 }));
    await post(delivery('complaint', [complained], { at: t0 }));
    expect(await suppression(complained)).toMatchObject({ reason: 'complaint', event_count: 2 });
    // A later bounce does not turn a complaint back into a bounce.
    await post(delivery('bounce', [complained], { at: t0 }));
    expect(await suppression(complained)).toMatchObject({ reason: 'complaint', event_count: 3 });
    // A delivery from before the bounce changes nothing.
    await post(delivery('delivered', [bounced], { at: new Date(t0.getTime() - 60_000) }));
    expect(await suppression(bounced)).toMatchObject({ reason: 'bounce', lifted: false });
    // A later one does.
    await post(delivery('delivered', [bounced, complained]));
    expect(await suppression(bounced)).toMatchObject({ reason: 'bounce', lifted: true });
    expect(await suppression(complained)).toMatchObject({ reason: 'complaint', lifted: false });
    // Bouncing again puts it back.
    await post(delivery('bounce', [bounced]));
    expect(await suppression(bounced)).toMatchObject({
      reason: 'bounce',
      lifted: false,
      event_count: 2,
    });
  });

  it('keeps the list out of reach of the runtime roles except through its functions', async () => {
    for (const pool of [pools.app, pools.worker]) {
      await expect(pool.query('SELECT * FROM eventhub.email_suppression')).rejects.toThrow(
        /permission denied/,
      );
      await expect(pool.query('SELECT * FROM eventhub.email_feedback_event')).rejects.toThrow(
        /permission denied/,
      );
    }
    await expect(
      pools.worker.query(
        "SELECT eventhub.record_email_feedback('x','y','bounce','m',now(),'{a@b.c}')",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      pools.app.query("SELECT eventhub.email_suppression_reason('a@b.c')"),
    ).rejects.toThrow(/permission denied/);
  });

  /** A published event with people registered directly (sign-up has its own tests). */
  async function eventWith(addresses: string[]) {
    const owner = await createFixtureUser(pools.migrator);
    const orgId = await createFixtureOrganization(pools.migrator, owner.id);
    const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
    await pools.migrator.query(`UPDATE eventhub.event SET lifecycle = 'published' WHERE id = $1`, [
      eventId,
    ]);
    for (const [i, email] of addresses.entries()) {
      await pools.migrator.query(
        `INSERT INTO eventhub.registration (organization_id, event_id, email, name, status, privacy_policy_url)
         VALUES ($1, $2, $3, $4, 'confirmed', 'https://example.com/privacy')`,
        [orgId, eventId, email, `Person ${i}`],
      );
    }
    const base = `/v1/organizations/${orgId}/events/${eventId}`;
    return { owner, orgId, eventId, base };
  }

  it('shows organizers which attendees cannot receive email, without saying why', async () => {
    const [ok, gone, angry, back] = [address(), address(), address(), address()];
    const t = await eventWith([ok, gone, angry, back]);
    await post(delivery('bounce', [gone]));
    await post(delivery('complaint', [angry]));
    // Bounced once, then delivered again: deliverable.
    await post(delivery('bounce', [back], { at: new Date(Date.now() - 60_000) }));
    await post(delivery('delivered', [back]));
    const res = await call({
      method: 'GET',
      url: `${t.base}/registrations`,
      headers: auth(t.owner),
    });
    expect(res.statusCode, res.body).toBe(200);
    const flags = Object.fromEntries(
      (res.json().data as Array<{ email: string; emailUndeliverable: boolean }>).map((r) => [
        r.email,
        r.emailUndeliverable,
      ]),
    );
    expect(flags).toEqual({ [ok]: false, [gone]: true, [angry]: true, [back]: false });
    expect(res.body).not.toMatch(/bounce|complain/);
  });

  it('skips suppressed attendees when announcing, and counts them as skipped', async () => {
    const [ok, gone, angry] = [address(), address(), address()];
    const t = await eventWith([ok, gone, angry]);
    await post(delivery('bounce', [gone]));
    await post(delivery('complaint', [angry]));
    const sent = await call({
      method: 'POST',
      url: `${t.base}/announcements`,
      headers: { ...auth(t.owner), 'idempotency-key': `k-${randomUUID()}` },
      payload: { subject: 'Venue change', body: 'Hall B.', audience: 'registered' },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    for (let i = 0; i < 10; i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    }
    const to = (a: string) =>
      inbox.sent.filter((m) => m.to === a && m.template === 'event_announcement');
    expect([to(ok).length, to(gone).length, to(angry).length]).toEqual([1, 0, 0]);
    const listed = await call({
      method: 'GET',
      url: `${t.base}/announcements`,
      headers: auth(t.owner),
    });
    expect(listed.json().data[0]).toMatchObject({ recipients: 3, delivered: 1, skipped: 2 });
  });

  it('the worker still sends what the person asked for, even to a bounced address', async () => {
    const gone = address();
    await post(delivery('bounce', [gone]));
    await sender.send({
      messageId: randomUUID(),
      to: gone,
      template: 'password_reset',
      subject: 's',
      text: 't',
    });
    await sender.send({
      messageId: randomUUID(),
      to: gone,
      template: 'password_changed',
      subject: 's',
      text: 't',
    });
    await sender.send({
      messageId: randomUUID(),
      to: gone.toUpperCase(),
      template: 'organization_invitation',
      subject: 's',
      text: 't',
    });
    expect(inbox.sent.filter((m) => m.to.toLowerCase() === gone).map((m) => m.template)).toEqual([
      'password_reset',
    ]);
  });
});
