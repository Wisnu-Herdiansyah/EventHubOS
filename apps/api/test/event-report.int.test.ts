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

/** Event reports (ADR-0030): counts only, in the event's own calendar. */
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

interface Seed {
  made: string;
  cancelled?: string;
  checkedIn?: string;
}

async function setup(seeds: Seed[], ends = "now() - interval '1 day'") {
  const owner = await createFixtureUser(pools.migrator);
  const orgId = await createFixtureOrganization(pools.migrator, owner.id);
  const eventId = await createFixtureEvent(pools.migrator, orgId, owner.id);
  await pools.migrator.query(
    `UPDATE eventhub.event SET timezone = 'Asia/Jakarta', starts_at = (${ends}) - interval '8 hours',
            ends_at = ${ends}, settings = '{"registration":{"capacity":10}}'
      WHERE id = $1`,
    [eventId],
  );
  const emails: string[] = [];
  for (const s of seeds) {
    const email = `attendee-${randomUUID()}@example.test`;
    emails.push(email);
    await pools.migrator.query(
      `INSERT INTO eventhub.registration (organization_id, event_id, email, name, status,
              privacy_policy_url, created_at, consented_at, cancelled_at, cancelled_by,
              checked_in_at, checked_in_by)
       VALUES ($1, $2, $3, 'Secret Name', $4, 'https://example.com/privacy', $5, $5, $6,
               CASE WHEN $6::timestamptz IS NULL THEN NULL ELSE 'attendee' END,
               $7, CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE $8::uuid END)`,
      [
        orgId,
        eventId,
        email,
        s.cancelled ? 'cancelled' : 'confirmed',
        s.made,
        s.cancelled ?? null,
        s.checkedIn ?? null,
        owner.id,
      ],
    );
  }
  const member = async (role: string) => {
    const u = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgId, u.id, role);
    return u;
  };
  const url = `/v1/organizations/${orgId}/events/${eventId}/report`;
  const report = (as: FixtureUser = owner) => app.inject({ method: 'GET', url, headers: auth(as) });
  return { owner, orgId, eventId, emails, member, report, url };
}

describe('event report', () => {
  it('counts sign-ups, cancellations, check-ins and no-shows, by day in the event time zone', async () => {
    const t = await setup([
      // 18:30 UTC on 1 Feb is 01:30 on 2 Feb in Jakarta (UTC+7).
      { made: '2027-02-01T18:30:00Z', checkedIn: '2027-03-01T02:05:00Z' },
      { made: '2027-02-02T03:00:00Z', checkedIn: '2027-03-01T02:40:00Z' },
      { made: '2027-02-02T04:00:00Z' },
      // A gap day (3 Feb), then a sign-up cancelled two days later.
      { made: '2027-02-04T05:00:00Z', cancelled: '2027-02-06T06:00:00Z' },
      // Cancelled after checking in: not counted as attending.
      {
        made: '2027-02-04T06:00:00Z',
        cancelled: '2027-03-01T05:00:00Z',
        checkedIn: '2027-03-01T03:10:00Z',
      },
    ]);
    const res = await t.report();
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({
      timezone: 'Asia/Jakarta',
      ended: true,
      capacity: 10,
      truncated: false,
    });
    expect(r.totals).toEqual({
      signUps: 5,
      registered: 3,
      cancelled: 2,
      checkedIn: 2,
      noShows: 1,
    });
    expect(r.byDay.slice(0, 5)).toEqual([
      { date: '2027-02-02', registered: 3, cancelled: 0 },
      { date: '2027-02-03', registered: 0, cancelled: 0 },
      { date: '2027-02-04', registered: 2, cancelled: 0 },
      { date: '2027-02-05', registered: 0, cancelled: 0 },
      { date: '2027-02-06', registered: 0, cancelled: 1 },
    ]);
    // Runs to the last cancellation (1 Mar), every day present.
    expect(r.byDay.at(-1)).toEqual({ date: '2027-03-01', registered: 0, cancelled: 1 });
    expect(r.byDay).toHaveLength(28);
    expect(r.checkInsByHour).toEqual([{ hour: '2027-03-01T09:00', checkedIn: 2 }]);
    // Counts only: no attendee details anywhere in the response.
    expect(res.body).not.toContain('Secret Name');
    for (const e of t.emails) expect(res.body).not.toContain(e);
  });

  it('is empty, not an error, for an event without registrations', async () => {
    const t = await setup([], "now() + interval '30 days'");
    const r = (await t.report()).json();
    expect(r.ended).toBe(false);
    expect(r.totals).toEqual({ signUps: 0, registered: 0, cancelled: 0, checkedIn: 0, noShows: 0 });
    expect(r.byDay).toEqual([]);
    expect(r.checkInsByHour).toEqual([]);
  });

  it('keeps the newest year of days when activity spans longer', async () => {
    const t = await setup([{ made: '2025-01-01T03:00:00Z' }, { made: '2026-06-01T03:00:00Z' }]);
    const r = (await t.report()).json();
    expect(r.truncated).toBe(true);
    expect(r.byDay).toHaveLength(366);
    expect(r.byDay.at(-1)).toEqual({ date: '2026-06-01', registered: 1, cancelled: 0 });
    expect(r.totals.signUps).toBe(2);
  });

  it('needs report.read; Analysts may, Viewers and Content editors may not; tenants stay apart', async () => {
    const t = await setup([{ made: '2027-02-02T03:00:00Z' }]);
    expect((await t.report(await t.member('analyst'))).statusCode).toBe(200);
    expect((await t.report(await t.member('event_manager'))).statusCode).toBe(200);
    for (const role of ['viewer', 'content_editor', 'billing_admin']) {
      const res = await t.report(await t.member(role));
      expect(res.statusCode, role).toBe(403);
      expect(res.json().error.details.reason).toBe('missing_permission:report.read');
    }
    const other = await setup([]);
    expect((await t.report(other.owner)).statusCode).toBe(404);
    // Another organization's event under this organization's URL: not found.
    const crossed = await app.inject({
      method: 'GET',
      url: `/v1/organizations/${t.orgId}/events/${other.eventId}/report`,
      headers: auth(t.owner),
    });
    expect(crossed.statusCode).toBe(404);
  });
});
