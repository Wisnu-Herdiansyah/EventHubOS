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
  const report = (as: FixtureUser = owner) =>
    app.inject({ method: 'GET', url: `/v1/organizations/${orgId}/report`, headers: auth(as) });
  const member = async (role: string) => {
    const u = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgId, u.id, role);
    return u;
  };
  return { owner, orgId, event, report, member };
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
  });
});
