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

/** Searching and filtering the event list. */
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

async function setup() {
  const owner = await createFixtureUser(pools.migrator);
  const orgId = await createFixtureOrganization(pools.migrator, owner.id);
  /** An event with a name, slug, lifecycle and whether it is over. */
  const event = async (name: string, slug: string, lifecycle: string, past = false) => {
    const id = await createFixtureEvent(pools.migrator, orgId, owner.id, slug);
    const shift = past ? "- interval '10 days'" : "+ interval '10 days'";
    await pools.migrator.query(
      `UPDATE eventhub.event SET name = $2, lifecycle = $3,
              archived_from = CASE WHEN $3 = 'archived' THEN 'ended' END,
              starts_at = now() ${shift}, ends_at = now() ${shift} + interval '2 hours'
        WHERE id = $1`,
      [id, name, lifecycle],
    );
    return id;
  };
  const list = (query: string, as: FixtureUser = owner) =>
    app.inject({
      method: 'GET',
      url: `/v1/organizations/${orgId}/events${query}`,
      headers: auth(as),
    });
  const names = async (query: string) =>
    ((await list(query)).json().data as Array<{ name: string }>).map((e) => e.name).sort();
  return { owner, orgId, event, list, names };
}

describe('event list search', () => {
  it('finds events by name or slug, ignoring case', async () => {
    const t = await setup();
    await t.event('Jakarta Summit 2026', 'jakarta-2026', 'ended', true);
    await t.event('Jakarta Summit 2027', 'jakarta-2027', 'published');
    await t.event('Bandung Meetup', 'meetup-bdg', 'draft');
    expect(await t.names('?q=JAKARTA')).toEqual(['Jakarta Summit 2026', 'Jakarta Summit 2027']);
    expect(await t.names('?q=bdg')).toEqual(['Bandung Meetup']);
    expect(await t.names('?q=nothing-like-this')).toEqual([]);
    // Surrounding spaces are ignored.
    expect(await t.names('?q=%20meetup%20')).toEqual(['Bandung Meetup']);
  });

  it('treats % and _ literally', async () => {
    const t = await setup();
    await t.event('100% Fun', 'fun', 'draft');
    await t.event('100 Fun', 'fun-two', 'draft');
    await t.event('a_b event', 'ab-one', 'draft');
    await t.event('axb event', 'ab-two', 'draft');
    expect(await t.names(`?q=${encodeURIComponent('100%')}`)).toEqual(['100% Fun']);
    expect(await t.names('?q=a_b')).toEqual(['a_b event']);
  });

  it('filters upcoming and past by end time, combined with status and search', async () => {
    const t = await setup();
    await t.event('Old Summit', 'old', 'ended', true);
    await t.event('Archived Summit', 'arch', 'archived', true);
    await t.event('Next Summit', 'next', 'published');
    await t.event('Draft Summit', 'draft-one', 'draft');
    expect(await t.names('?when=past')).toEqual(['Archived Summit', 'Old Summit']);
    expect(await t.names('?when=upcoming')).toEqual(['Draft Summit', 'Next Summit']);
    expect(await t.names('?when=past&lifecycle=ended')).toEqual(['Old Summit']);
    expect(await t.names('?when=upcoming&q=draft')).toEqual(['Draft Summit']);
    expect(await t.names('?when=upcoming&lifecycle=ended')).toEqual([]);
  });

  it('pages through filtered results without gaps or repeats', async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++) await t.event(`Match ${i}`, `match-${i}`, 'draft');
    for (let i = 0; i < 3; i++) await t.event(`Other ${i}`, `other-${i}`, 'draft');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?q=match&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await t.list(query)).json();
      seen.push(...page.data.map((e: { name: string }) => e.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(['Match 0', 'Match 1', 'Match 2', 'Match 3', 'Match 4']);
  });

  it('validates the filters', async () => {
    const t = await setup();
    for (const q of [
      '?when=soon',
      `?q=${'x'.repeat(101)}`,
      '?q=%20%20',
      '?q=tab%09inside',
      '?lifecycle=gone',
      '?search=x',
    ]) {
      const res = await t.list(q);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code, q).toBe('validation_failed');
    }
  });

  it('only searches the organization in the URL, for members who can read events', async () => {
    const a = await setup();
    const b = await setup();
    await a.event('Shared Name', 'shared-a', 'draft');
    await b.event('Shared Name', 'shared-b', 'draft');
    expect((await a.list('?q=shared')).json().data).toHaveLength(1);
    expect((await a.list('?q=shared', b.owner)).statusCode).toBe(404);
    const billing = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, a.orgId, billing.id, 'billing_admin');
    expect((await a.list('?q=shared', billing)).statusCode).toBe(403);
  });
});
