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

/** Searching the attendee list and its export (ADR-0069). */
describe('attendee search', () => {
  const pools = createTestPools();
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.77.${Math.floor(++ip / 250)}.${ip % 250}` });
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
      sharing: { title: 'Approval test', description: 'An event used by the approval tests.' },
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
  const rows = async (eventId: string) =>
    (
      await pools.migrator.query<{
        id: string;
        email: string;
        status: string;
        decided_at: Date | null;
        decided_by: string | null;
      }>(
        `SELECT id, email, status, decided_at, decided_by FROM eventhub.registration
          WHERE event_id = $1 ORDER BY created_at, id`,
        [eventId],
      )
    ).rows;
  const rowOf = async (eventId: string, addr: string) =>
    (await rows(eventId)).find((r) => r.email === addr);
  const staffEvent = () =>
    publishedEvent({ capacity: 10 }, ['registration_manager', 'viewer', 'content_editor']);
  type S = Awaited<ReturnType<typeof staffEvent>>;
  /** Registers someone and returns the entry with the personal link from their email. */
  const setNote = (
    t: S,
    id: string,
    note: unknown,
    as: FixtureUser = t.owner,
    headers: Record<string, string> = idem(),
  ) =>
    call({
      method: 'PATCH',
      url: `${t.base}/${id}/note`,
      headers: { ...auth(as), ...headers },
      payload: { note },
    });
  type Entry = { id: string; name: string; email: string; staffNote: string | null };
  const search = async (t: S, q: string, status?: string, as: FixtureUser = t.owner) => {
    const params = new URLSearchParams({ q, ...(status ? { status } : {}) });
    return call({ method: 'GET', url: `${t.base}?${params.toString()}`, headers: auth(as) });
  };
  const names = async (t: S, q: string, status?: string) => {
    const res = await search(t, q, status);
    expect(res.statusCode, res.body).toBe(200);
    return res
      .json<{ data: Entry[] }>()
      .data.map((r) => r.name)
      .sort();
  };
  /** Registers someone with a chosen email address. */
  async function joinAs(t: S, name: string, addr: string) {
    const res = await t.register({ name, email: addr });
    expect(res.statusCode, res.body).toBe(202);
    return (await rowOf(t.eventId, addr))!;
  }
  const tag = () => randomUUID().slice(0, 8);

  it('finds people by part of their name, email or staff note, ignoring case', async () => {
    const t = await staffEvent();
    const k = tag();
    await joinAs(t, 'Ade Wisnu', `ade-${k}@example.test`);
    const budi = await joinAs(t, 'Budi Santoso', `budi-${k}@partner.example`);
    await joinAs(t, 'Citra Lestari', `citra-${k}@example.test`);
    await setNote(t, budi.id, 'VIP from the sponsor');
    expect(await names(t, 'ADE')).toEqual(['Ade Wisnu']);
    expect(await names(t, 'santo')).toEqual(['Budi Santoso']);
    expect(await names(t, 'partner.example')).toEqual(['Budi Santoso']);
    expect(await names(t, 'sponsor')).toEqual(['Budi Santoso']);
    expect(await names(t, k)).toEqual(['Ade Wisnu', 'Budi Santoso', 'Citra Lestari']);
    expect(await names(t, 'nobody-here')).toEqual([]);
    // Surrounding spaces are trimmed.
    expect(await names(t, '  citra  ')).toEqual(['Citra Lestari']);
  });

  it('works together with the status filter', async () => {
    const t = await staffEvent();
    const k = tag();
    const a = await joinAs(t, 'Dewi Same', `dewi-a-${k}@example.test`);
    await joinAs(t, 'Dewi Other', `dewi-b-${k}@example.test`);
    await call({
      method: 'POST',
      url: `${t.base}/${a.id}/cancel`,
      headers: { ...auth(t.owner), ...idem() },
    });
    expect(await names(t, 'dewi')).toEqual(['Dewi Other', 'Dewi Same']);
    expect(await names(t, 'dewi', 'confirmed')).toEqual(['Dewi Other']);
    expect(await names(t, 'dewi', 'cancelled')).toEqual(['Dewi Same']);
  });

  it('% and _ are matched as themselves, not as wildcards', async () => {
    const t = await staffEvent();
    const k = tag();
    const pct = await joinAs(t, 'Percent Person', `pct-${k}@example.test`);
    await joinAs(t, 'Plain Person', `plain-${k}@example.test`);
    const under = await joinAs(t, 'Under Score', `under_${k}@example.test`);
    await setNote(t, pct.id, 'Paid 100% upfront');
    expect(await names(t, '%')).toEqual(['Percent Person']);
    expect(await names(t, '100%')).toEqual(['Percent Person']);
    // "_" alone would otherwise match every row.
    expect(await names(t, '_')).toEqual(['Under Score']);
    expect(await names(t, 'under_')).toEqual(['Under Score']);
    // A backslash is literal too.
    await setNote(t, under.id, 'path a\\b');
    expect(await names(t, 'a\\b')).toEqual(['Under Score']);
  });

  it('validates the search: 1 to 100 characters of one line', async () => {
    const t = await staffEvent();
    await joinAs(t, 'Valid Person', `valid-${tag()}@example.test`);
    expect((await search(t, 'x'.repeat(100))).statusCode).toBe(200);
    for (const bad of ['', '   ', 'x'.repeat(101), 'two\nlines', 'tab\there']) {
      const res = await search(t, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('the download holds exactly what the search found, and the audit says only that it was searched', async () => {
    const t = await staffEvent();
    const k = tag();
    await joinAs(t, 'Eka Export', `eka-${k}@example.test`);
    await joinAs(t, 'Fajar Other', `fajar-${k}@example.test`);
    const res = await t.exportList(t.owner, { q: 'eka' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ data: Entry[] }>().data.map((r) => r.name)).toEqual(['Eka Export']);
    const all = await t.exportList(t.owner, {});
    expect(all.json<{ data: Entry[] }>().data).toHaveLength(2);
    const exported = (
      await pools.migrator.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM eventhub.audit_event
          WHERE organization_id = $1 AND action = 'registration.exported' ORDER BY occurred_at`,
        [t.orgId],
      )
    ).rows.map((r) => r.metadata);
    expect(exported).toEqual([
      { count: 1, status: 'all', truncated: false, searched: true },
      { count: 2, status: 'all', truncated: false, searched: false },
    ]);
    expect(JSON.stringify(exported)).not.toContain('eka');
    // The export validates the search like the list.
    expect((await t.exportList(t.owner, { q: 'x'.repeat(101) })).statusCode).toBe(400);
  });

  it('needs registration.manage; finds nothing in other organizations or events', async () => {
    const t = await staffEvent();
    const k = tag();
    await joinAs(t, 'Gita Mine', `gita-${k}@example.test`);
    expect((await search(t, 'gita', undefined, t.members.viewer)).statusCode).toBe(403);
    expect((await search(t, 'gita', undefined, t.members.content_editor)).statusCode).toBe(403);
    expect((await search(t, 'gita', undefined, t.members.registration_manager)).statusCode).toBe(
      200,
    );
    const other = await staffEvent();
    await joinAs(other, 'Gita Theirs', `gita-theirs-${k}@example.test`);
    // Another organization's owner at this event's address: 404.
    expect((await search(t, 'gita', undefined, other.owner)).statusCode).toBe(404);
    // Each organization's search finds only its own attendees.
    expect(await names(t, k)).toEqual(['Gita Mine']);
    expect(await names(other, k)).toEqual(['Gita Theirs']);
    // Another event in the same organization: not found here.
    const sibling = await createFixtureEvent(pools.migrator, t.orgId, t.owner.id);
    const res = await call({
      method: 'GET',
      url: `/v1/organizations/${t.orgId}/events/${sibling}/registrations?q=gita`,
      headers: auth(t.owner),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });
});
