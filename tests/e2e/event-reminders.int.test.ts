import { randomUUID } from 'node:crypto';
import { InMemoryEmailSender, type EmailMessage } from '@eventhub/kernel';
import {
  createFixtureEvent,
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
} from '@eventhub/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { sendEventRemindersOnce } from '../../apps/worker/src/event-reminders.ts';

const SITE = 'https://{handle}.eventhub.example';
const HOUR = 3_600_000;

/** Event reminder emails (ADR-0062): who is due, exactly-once delivery, and tenant boundaries. */
describe('event reminders', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  afterAll(async () => {
    await pools.end();
  });

  const email = () => `rem-${randomUUID().slice(0, 12)}@example.test`;
  const to = (addr: string) => inbox.sent.filter((m) => m.to === addr);
  const pass = (sender: { name: string; send(m: EmailMessage): Promise<void> } = inbox) =>
    sendEventRemindersOnce(pools.worker, sender, { publicSiteUrl: SITE });
  /** Runs passes until none is due, as the worker loop would. */
  const drain = async () => {
    for (let i = 0; i < 20 && (await pass()) > 0; i++);
  };

  interface EventOptions {
    startsInHours?: number;
    lifecycle?: string;
    registration?: Record<string, unknown>;
    timezone?: string;
  }
  async function event(options: EventOptions = {}) {
    const owner = await createFixtureUser(pools.migrator);
    const orgId = await createFixtureOrganization(pools.migrator, owner.id);
    const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
    const handle = `m-${randomUUID().slice(0, 8)}`;
    await pools.migrator.query(
      `UPDATE eventhub.organization SET public_handle = $2, display_name = 'Reminder Org' WHERE id = $1`,
      [orgId, handle],
    );
    const starts = new Date(Date.now() + (options.startsInHours ?? 12) * HOUR);
    const { rows } = await pools.migrator.query<{ slug: string }>(
      `UPDATE eventhub.event SET name = 'Annual Gathering', lifecycle = $2, settings = $3, timezone = $6,
              starts_at = $4, ends_at = $5,
              archived_from = CASE WHEN $2 = 'archived' THEN 'ended' END
        WHERE id = $1 RETURNING slug`,
      [
        eventId,
        options.lifecycle ?? 'published',
        JSON.stringify({ registration: options.registration ?? {} }),
        starts,
        new Date(starts.getTime() + 2 * HOUR),
        options.timezone ?? 'UTC',
      ],
    );
    /** A registration made `agoHours` ago, with the given status. */
    const person = async (agoHours = 72, status = 'confirmed', name = 'Ada Attendee') => {
      const addr = email();
      const created = new Date(Date.now() - agoHours * HOUR);
      const { rows: r } = await pools.migrator.query<{ id: string }>(
        `INSERT INTO eventhub.registration (organization_id, event_id, email, name, status,
                                            privacy_policy_url, created_at, cancelled_at, cancelled_by)
         VALUES ($1, $2, $3, $4, $5, 'https://example.com/privacy', $6,
                 CASE WHEN $5 = 'cancelled' THEN now() END,
                 CASE WHEN $5 = 'cancelled' THEN 'attendee' END)
         RETURNING id`,
        [orgId, eventId, addr, name, status, created],
      );
      return { addr, id: r[0]!.id };
    };
    return { orgId, eventId, handle, slug: rows[0]!.slug, starts, person };
  }
  const remindedAt = async (id: string) =>
    (
      await pools.migrator.query<{ reminded_at: Date | null }>(
        'SELECT reminded_at FROM eventhub.registration WHERE id = $1',
        [id],
      )
    ).rows[0]!.reminded_at;

  it('reminds a person with a confirmed seat once, in the event’s own time zone', async () => {
    const t = await event({ startsInHours: 12, timezone: 'Asia/Jakarta' });
    const p = await t.person();
    await drain();
    const mails = to(p.addr);
    expect(mails).toHaveLength(1);
    const m = mails[0]!;
    expect(m.template).toBe('event_reminder');
    expect(m.subject).toBe('Reminder: Annual Gathering starts soon');
    expect(m.messageId).toBe(`event-reminder-${p.id}`);
    expect(m.text).toContain('Hello Ada Attendee,');
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(t.starts);
    expect(m.text).toMatch(new RegExp(`When: .*${local} GMT\\+7`));
    expect(m.text).toContain(`Event page: https://${t.handle}.eventhub.example/${t.slug}`);
    expect(m.text).toContain('Sent by Reminder Org.');
    // No personal link: a new one would stop the confirmation email's links from working.
    expect(m.text).not.toMatch(/token|cancel-registration|ticket#/i);
    expect(m.text).toContain('are in your confirmation email');
    expect(await remindedAt(p.id)).toBeInstanceOf(Date);

    // Later passes send nothing more.
    await drain();
    await drain();
    expect(to(p.addr)).toHaveLength(1);
  });

  it('reminds only inside the 24 hours before the start', async () => {
    const tooEarly = await event({ startsInHours: 30 });
    const early = await tooEarly.person(96);
    const started = await event({ startsInHours: -1 });
    const late = await started.person(96);
    const edge = await event({ startsInHours: 23.5 });
    const inWindow = await edge.person(96);
    await drain();
    expect(to(early.addr)).toHaveLength(0);
    expect(to(late.addr)).toHaveLength(0);
    expect(to(inWindow.addr)).toHaveLength(1);

    // The event is moved closer: the person becomes due.
    await pools.migrator.query(
      `UPDATE eventhub.event SET starts_at = now() + interval '20 hours', ends_at = now() + interval '22 hours'
        WHERE id = $1`,
      [tooEarly.eventId],
    );
    await drain();
    expect(to(early.addr)).toHaveLength(1);
  });

  it('skips people who signed up inside the window: they just had a confirmation', async () => {
    const t = await event({ startsInHours: 12 });
    const recent = await t.person(1);
    // Registered 11 hours ago for an event 12 hours away: 23 hours before the start.
    const alsoInside = await t.person(11);
    const before = await t.person(13);
    await drain();
    expect(to(recent.addr)).toHaveLength(0);
    expect(to(alsoInside.addr)).toHaveLength(0);
    expect(to(before.addr)).toHaveLength(1);
  });

  it('reminds only confirmed seats', async () => {
    const t = await event();
    const cancelled = await t.person(72, 'cancelled');
    const waiting = await t.person(72, 'waitlisted');
    const confirmed = await t.person(72);
    await drain();
    expect(to(cancelled.addr)).toHaveLength(0);
    expect(to(waiting.addr)).toHaveLength(0);
    expect(to(confirmed.addr)).toHaveLength(1);
  });

  it('reminds only for events that are public and going ahead', async () => {
    const people: Record<string, string> = {};
    for (const lifecycle of ['draft', 'scheduled', 'published', 'live', 'ended', 'archived']) {
      const t = await event({ lifecycle });
      people[lifecycle] = (await t.person()).addr;
    }
    const called = await event();
    const off = await called.person();
    const admin = await createFixtureUser(pools.migrator);
    await pools.migrator.query(
      `UPDATE eventhub.event SET cancelled_at = now(), cancelled_by = $2, cancellation_reason = 'Venue closed'
        WHERE id = $1`,
      [called.eventId, admin.id],
    );
    await drain();
    expect(
      Object.fromEntries(Object.entries(people).map(([k, addr]) => [k, to(addr).length])),
    ).toEqual({ draft: 0, scheduled: 0, published: 1, live: 1, ended: 0, archived: 0 });
    expect(to(off.addr)).toHaveLength(0);
  });

  it('follows the organizer’s switch: off sends nothing, unset and on both send', async () => {
    const off = await event({ registration: { reminder: false } });
    const offPerson = await off.person();
    const on = await event({ registration: { reminder: true } });
    const onPerson = await on.person();
    const unset = await event({ registration: { capacity: 50 } });
    const unsetPerson = await unset.person();
    await drain();
    expect(to(offPerson.addr)).toHaveLength(0);
    expect(to(onPerson.addr)).toHaveLength(1);
    expect(to(unsetPerson.addr)).toHaveLength(1);
    expect(await remindedAt(offPerson.id)).toBeNull();

    // Switched back on while still in the window: the reminder goes out.
    await pools.migrator.query(
      `UPDATE eventhub.event SET settings = jsonb_set(settings, '{registration,reminder}', 'true') WHERE id = $1`,
      [off.eventId],
    );
    await drain();
    expect(to(offPerson.addr)).toHaveLength(1);
  });

  it('a failed send marks nobody, and the retry delivers each reminder exactly once', async () => {
    await drain();
    const t = await event();
    const people = [await t.person(), await t.person(), await t.person()];
    const mine = (m: EmailMessage) => people.some((p) => p.addr === m.to);
    const delivered = new Map<string, EmailMessage>();
    let failures = 1;
    let seen = 0;
    const flaky = {
      name: 'flaky',
      send(m: EmailMessage): Promise<void> {
        if (mine(m) && ++seen === 2 && failures-- > 0)
          return Promise.reject(new Error('provider down'));
        // A provider keeps one copy per message ID.
        delivered.set(m.messageId, m);
        return Promise.resolve();
      },
    };
    await expect(pass(flaky)).rejects.toThrow('provider down');
    for (const p of people) expect(await remindedAt(p.id)).toBeNull();
    for (let i = 0; i < 20 && (await pass(flaky)) > 0; i++);
    const ours = [...delivered.values()].filter(mine);
    expect(ours.map((m) => m.to).sort()).toEqual(people.map((p) => p.addr).sort());
    expect(new Set(ours.map((m) => m.messageId)).size).toBe(3);
    for (const p of people) expect(await remindedAt(p.id)).toBeInstanceOf(Date);
  });

  it('two workers at once never remind the same person twice', async () => {
    await drain();
    const t = await event();
    const people = await Promise.all(Array.from({ length: 12 }, () => t.person()));
    const counts = new Map<string, number>();
    const slow = {
      name: 'slow',
      async send(m: EmailMessage): Promise<void> {
        await new Promise((r) => setTimeout(r, 5));
        counts.set(m.to, (counts.get(m.to) ?? 0) + 1);
      },
    };
    const run = () =>
      sendEventRemindersOnce(pools.worker, slow, { publicSiteUrl: SITE, batchSize: 4 });
    for (let i = 0; i < 10; i++) {
      const [a, b] = await Promise.all([run(), run()]);
      if (a + b === 0) break;
    }
    expect(people.map((p) => counts.get(p.addr))).toEqual(people.map(() => 1));
  });

  it('the event link is left out when there is no public site address', async () => {
    const t = await event();
    const p = await t.person();
    await sendEventRemindersOnce(pools.worker, inbox, { publicSiteUrl: null });
    await drain();
    const m = to(p.addr)[0]!;
    expect(m.text).not.toContain('Event page:');
    expect(m.text).toContain('When: ');
  });

  it('marking needs the registration’s own organization', async () => {
    const t = await event({ startsInHours: 30 });
    const other = await event({ startsInHours: 30 });
    const p = await t.person();
    await pools.worker.query('SELECT eventhub.event_reminder_mark($1, $2)', [p.id, other.orgId]);
    expect(await remindedAt(p.id)).toBeNull();
    await pools.worker.query('SELECT eventhub.event_reminder_mark($1, $2)', [p.id, t.orgId]);
    // To the microsecond: two statements can share a millisecond.
    const exact = async () =>
      (
        await pools.migrator.query<{ at: string | null }>(
          'SELECT reminded_at::text AS at FROM eventhub.registration WHERE id = $1',
          [p.id],
        )
      ).rows[0]!.at;
    const first = await exact();
    expect(first).not.toBeNull();
    // Marking again changes nothing.
    await pools.worker.query('SELECT pg_sleep(0.002)');
    await pools.worker.query('SELECT eventhub.event_reminder_mark($1, $2)', [p.id, t.orgId]);
    expect(await exact()).toBe(first);
  });

  it('a worker never waits for people another worker is already reminding', async () => {
    await drain();
    const t = await event();
    const p = await t.person();
    const busy = await pools.worker.connect();
    try {
      await busy.query('BEGIN');
      const held = await busy.query(
        'SELECT out_registration_id FROM eventhub.event_reminders_due(500)',
      );
      expect(
        held.rows.map((r: { out_registration_id: string }) => r.out_registration_id),
      ).toContain(p.id);
      const other = pass();
      const outcome = await Promise.race([
        other,
        new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 1500)),
      ]);
      await busy.query('ROLLBACK');
      await other;
      // It skipped the held rows at once, and reminded nobody.
      expect(outcome).toBe(0);
      expect(to(p.addr)).toHaveLength(0);
    } finally {
      busy.release();
    }
    await drain();
    expect(to(p.addr)).toHaveLength(1);
  });

  it('keeps the reminder functions to the worker', async () => {
    await expect(pools.app.query('SELECT * FROM eventhub.event_reminders_due(10)')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      pools.app.query('SELECT eventhub.event_reminder_mark($1, $2)', [randomUUID(), randomUUID()]),
    ).rejects.toThrow(/permission denied/);
  });

  it('the worker cannot read registrations directly, only through the due list', async () => {
    await expect(
      pools.worker.query('SELECT email FROM eventhub.registration LIMIT 1'),
    ).rejects.toThrow(/permission denied/);
  });
});
