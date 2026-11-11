import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addFixtureMembership,
  createFixtureEvent,
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
  type FixtureUser,
} from '@eventhub/db/testing';
import { Argon2idPasswordHasher } from '../src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../src/app.ts';
import { DatabaseSessionAuthenticator } from '../src/modules/identity/authenticator.ts';

/** Organization-wide reporting (ADR-0032): counts only, across every event. */
const pools = createTestPools();
let app: FastifyInstance;

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

const auth = (u: FixtureUser) => ({ authorization: `Bearer ${u.token}` });

/** Registers someone; `made` is an SQL timestamptz expression. */
async function register(
  orgId: string,
  eventId: string,
  opts: { made?: string; cancelled?: boolean; checkedInBy?: string } = {},
) {
  await pools.migrator.query(
    `INSERT INTO eventhub.registration (organization_id, event_id, email, name, status,
            privacy_policy_url, created_at, consented_at, cancelled_at, cancelled_by,
            checked_in_at, checked_in_by)
     VALUES ($1, $2, $3, 'Hidden Person', $4, 'https://example.com/privacy',
             ${opts.made ?? 'now()'}, now(), $5, $6, $7, $8)`,
    [
      orgId,
      eventId,
      `p-${randomUUID()}@example.test`,
      opts.cancelled ? 'cancelled' : 'confirmed',
      opts.cancelled ? new Date() : null,
      opts.cancelled ? 'attendee' : null,
      opts.checkedInBy ? new Date() : null,
      opts.checkedInBy ?? null,
    ],
  );
}

async function setup() {
  const owner = await createFixtureUser(pools.migrator);
  const orgId = await createFixtureOrganization(pools.migrator, owner.id);
  await pools.migrator.query(
    `UPDATE eventhub.organization SET timezone = 'Asia/Jakarta' WHERE id = $1`,
    [orgId],
  );
  const event = async (when: 'past' | 'future', name: string) => {
    const id = await createFixtureEvent(pools.migrator, orgId, owner.id);
    const shift = when === 'past' ? "- interval '10 days'" : "+ interval '10 days'";
    await pools.migrator.query(
      `UPDATE eventhub.event SET name = $2, starts_at = now() ${shift},
              ends_at = now() ${shift} + interval '8 hours' WHERE id = $1`,
      [id, name],
    );
    return id;
  };
  const report = (as: FixtureUser = owner, query = '') =>
    app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/report${query}`,
      headers: auth(as),
    });
  /** An event at a fixed time (UTC ISO). */
  const eventAt = async (startsAt: string, name: string) => {
    const id = await createFixtureEvent(pools.migrator, orgId, owner.id);
    await pools.migrator.query(
      `UPDATE eventhub.event SET name = $2, starts_at = $3,
              ends_at = $3::timestamptz + interval '2 hours' WHERE id = $1`,
      [id, name, startsAt],
    );
    return id;
  };
  const member = async (role: string) => {
    const u = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgId, u.id, role);
    return u;
  };
  return { owner, orgId, event, eventAt, report, member };
}

// The first instant of this month in Jakarta, as SQL.
const MONTH_START =
  "(date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta')";

describe('organization report', () => {
  it('totals every event; attendance counts ended events only', async () => {
    const t = await setup();
    const past = await t.event('past', 'Past Summit');
    const future = await t.event('future', 'Future Forum');
    await register(t.orgId, past, { checkedInBy: t.owner.id });
    await register(t.orgId, past);
    await register(t.orgId, past, { cancelled: true });
    await register(t.orgId, future);

    const res = await t.report();
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.timezone).toBe('Asia/Jakarta');
    expect(r.totals).toEqual({
      events: 2,
      registered: 3,
      cancelled: 1,
      checkedIn: 1,
      endedEvents: 1,
      endedRegistered: 2,
      endedCheckedIn: 1,
    });
    // Newest start first.
    expect(r.events.map((e: { name: string }) => e.name)).toEqual(['Future Forum', 'Past Summit']);
    expect(r.events[1]).toMatchObject({ ended: true, registered: 2, cancelled: 1, checkedIn: 1 });
    expect(r.events[0]).toMatchObject({ ended: false, registered: 1, checkedIn: 0 });
    expect(r.truncated).toBe(false);
    expect(res.body).not.toContain('Hidden Person');
    expect(res.body).not.toContain('@example.test');
  });

  it('counts sign-ups by month in the organization time zone, for the last 12 months', async () => {
    const t = await setup();
    const ev = await t.event('future', 'Monthly');
    // One hour into this month in Jakarta, and two hours before it (last month in Jakarta,
    // though possibly still this month in UTC).
    await register(t.orgId, ev, { made: `${MONTH_START} + interval '1 hour'` });
    await register(t.orgId, ev, { made: `${MONTH_START} - interval '2 hours'` });
    // Thirteen months ago: outside the window.
    await register(t.orgId, ev, { made: `${MONTH_START} - interval '13 months'` });
    const r = (await t.report()).json();
    expect(r.signUpsByMonth).toHaveLength(12);
    const [thisMonth, lastMonth] = [r.signUpsByMonth.at(-1), r.signUpsByMonth.at(-2)];
    expect(thisMonth.signUps).toBe(1);
    expect(lastMonth.signUps).toBe(1);
    expect(r.signUpsByMonth.reduce((n: number, m: { signUps: number }) => n + m.signUps, 0)).toBe(
      2,
    );
    expect(thisMonth.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it('lists at most 500 events but totals all of them', async () => {
    const t = await setup();
    await pools.migrator.query(
      `INSERT INTO eventhub.event (organization_id, name, slug, timezone, starts_at, ends_at,
                                   venue_mode, primary_language, created_by)
       SELECT $1, 'Bulk ' || g, 'bulk-' || g, 'UTC', now() + g * interval '1 day',
              now() + g * interval '1 day' + interval '1 hour', 'virtual', 'en', $2
         FROM generate_series(1, 501) AS g`,
      [t.orgId, t.owner.id],
    );
    const r = (await t.report()).json();
    expect(r.events).toHaveLength(500);
    expect(r.totals.events).toBe(501);
    expect(r.truncated).toBe(true);
  });

  it('without a period reports all time', async () => {
    const t = await setup();
    const r = (await t.report()).json();
    expect(r.period).toBeNull();
    expect(r.monthsTruncated).toBe(false);
  });

  it('a period selects events that start on its days in the organization time zone', async () => {
    const t = await setup();
    // 23:30 on 1 March in Jakarta (UTC+7), and 00:30 on 2 March.
    const inside = await t.eventAt('2030-03-01T16:30:00Z', 'Late Night');
    const after = await t.eventAt('2030-03-01T17:30:00Z', 'Early Morning');
    // 00:00 on 28 February in Jakarta, still 27 February in UTC.
    const first = await t.eventAt('2030-02-27T17:00:00Z', 'Midnight Start');
    await register(t.orgId, inside, { checkedInBy: t.owner.id });
    await register(t.orgId, inside, { cancelled: true });
    await register(t.orgId, after);
    await register(t.orgId, first);

    const res = await t.report(t.owner, '?from=2030-02-28&to=2030-03-01');
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r.period).toEqual({ from: '2030-02-28', to: '2030-03-01' });
    expect(r.events.map((e: { name: string }) => e.name)).toEqual(['Late Night', 'Midnight Start']);
    expect(r.totals).toMatchObject({ events: 2, registered: 2, cancelled: 1, checkedIn: 1 });
    // A single day works too.
    const day = (await t.report(t.owner, '?from=2030-03-02&to=2030-03-02')).json();
    expect(day.events.map((e: { name: string }) => e.name)).toEqual(['Early Morning']);
    expect(day.totals).toMatchObject({ events: 1, registered: 1 });
    // A period with nothing in it is empty, not an error.
    const none = (await t.report(t.owner, '?from=2031-01-01&to=2031-01-31')).json();
    expect(none.totals.events).toBe(0);
    expect(none.events).toEqual([]);
  });

  it('charts sign-ups made during the period, month by month', async () => {
    const t = await setup();
    const ev = await t.eventAt('2030-06-01T02:00:00Z', 'Summer');
    // Jakarta days: 14 Jan (before), 15 Jan, 10 Mar 23:30, 11 Mar 00:30 (after).
    for (const made of [
      '2030-01-14T10:00:00Z',
      '2030-01-14T17:30:00Z',
      '2030-03-10T16:30:00Z',
      '2030-03-10T17:30:00Z',
    ]) {
      await register(t.orgId, ev, { made: `'${made}'::timestamptz` });
    }
    const r = (await t.report(t.owner, '?from=2030-01-15&to=2030-03-10')).json();
    expect(r.signUpsByMonth).toEqual([
      { month: '2030-01', signUps: 1 },
      { month: '2030-02', signUps: 0 },
      { month: '2030-03', signUps: 1 },
    ]);
    expect(r.monthsTruncated).toBe(false);
    // The event starts outside the period, so it is not listed.
    expect(r.events).toEqual([]);
  });

  it('keeps the latest 24 months of a long period', async () => {
    const t = await setup();
    const r = (await t.report(t.owner, '?from=2000-01-01&to=2030-12-31')).json();
    expect(r.signUpsByMonth).toHaveLength(24);
    expect(r.signUpsByMonth[0].month).toBe('2029-01');
    expect(r.signUpsByMonth.at(-1).month).toBe('2030-12');
    expect(r.monthsTruncated).toBe(true);
    const exact = (await t.report(t.owner, '?from=2029-01-01&to=2030-12-31')).json();
    expect(exact.signUpsByMonth).toHaveLength(24);
    expect(exact.monthsTruncated).toBe(false);
  });

  it('rejects an incomplete or invalid period', async () => {
    const t = await setup();
    for (const q of [
      '?from=2030-01-01',
      '?to=2030-01-01',
      '?from=2030-02-01&to=2030-01-31',
      '?from=2030-02-30&to=2030-03-01',
      '?from=2030-1-1&to=2030-01-31',
      '?from=1999-12-31&to=2000-01-31',
      '?from=2030-01-01&to=2100-01-01',
      "?from=2030-01-01'&to=2030-01-31",
      '?from=2030-01-01&to=2030-01-31&organizationId=x',
    ]) {
      const res = await t.report(t.owner, q);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code, q).toBe('validation_failed');
    }
  });

  it('needs report.read and keeps organizations apart', async () => {
    const t = await setup();
    expect((await t.report(await t.member('analyst'))).statusCode).toBe(200);
    for (const role of ['viewer', 'content_editor', 'billing_admin']) {
      const res = await t.report(await t.member(role));
      expect(res.statusCode, role).toBe(403);
    }
    const other = await setup();
    await register(other.orgId, await other.event('past', 'Elsewhere'));
    expect((await t.report(other.owner)).statusCode).toBe(404);
    expect((await t.report()).json().totals.registered).toBe(0);
    // A period does not widen what is visible.
    const period = `?from=2000-01-01&to=2099-12-31`;
    expect((await t.report(other.owner, period)).statusCode).toBe(404);
    const mine = (await t.report(t.owner, period)).json();
    expect(mine.totals).toMatchObject({ events: 0, registered: 0 });
    expect(mine.signUpsByMonth.every((m: { signUps: number }) => m.signUps === 0)).toBe(true);
    expect((await t.report(await t.member('viewer'), period)).statusCode).toBe(403);
  });
});
