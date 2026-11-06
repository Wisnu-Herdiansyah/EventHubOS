import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addFixtureMembership,
  createFixtureOrganization,
  createFixtureUser,
  createTestPools,
  type FixtureUser,
} from '@eventhub/db/testing';
import { Argon2idPasswordHasher } from '../src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../src/app.ts';
import { DatabaseSessionAuthenticator } from '../src/modules/identity/authenticator.ts';

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
const idem = () => ({ 'idempotency-key': `k-${randomUUID()}` });

interface AuditItem {
  id: string;
  action: string;
  actor: { id: string | null; email: string | null };
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

/** An organization with real activity produced through the API. */
async function busyOrg(roles: string[] = []) {
  const owner = await createFixtureUser(pools.migrator);
  const orgId = await createFixtureOrganization(pools.migrator, owner.id);
  const members: Record<string, FixtureUser> = {};
  for (const role of roles) {
    const u = await createFixtureUser(pools.migrator);
    await addFixtureMembership(pools.migrator, orgId, u.id, role);
    members[role] = u;
  }
  const base = `/v1/organizations/${orgId}`;
  const evt = (
    await app.inject({
      method: 'POST',
      url: `${base}/events`,
      headers: { ...auth(owner), ...idem() },
      payload: {
        name: 'Audit Fest',
        slug: `audit-${randomUUID().slice(0, 8)}`,
        timezone: 'UTC',
        startsAt: '2027-03-01T09:00:00Z',
        endsAt: '2027-03-01T17:00:00Z',
        venueMode: 'virtual',
        primaryLanguage: 'en',
      },
    })
  ).json();
  await app.inject({
    method: 'PATCH',
    url: `${base}/events/${evt.id}`,
    headers: { ...auth(owner), ...idem() },
    payload: { expectedVersion: 1, name: 'Audit Fest 2027' },
  });
  const invitee = `invitee-${randomUUID()}@example.test`;
  await app.inject({
    method: 'POST',
    url: `${base}/invitations`,
    headers: { ...auth(owner), ...idem() },
    payload: { email: invitee, role: 'viewer' },
  });
  const list = (query = '', as: FixtureUser = owner) =>
    app.inject({ method: 'GET', url: `${base}/audit-events${query}`, headers: auth(as) });
  return { owner, orgId, members, eventId: evt.id as string, invitee, list };
}

describe('audit log viewer', () => {
  it('shows this organization’s actions newest first, with actor emails and minimised metadata', async () => {
    const t = await busyOrg();
    const res = await t.list();
    expect(res.statusCode).toBe(200);
    const data: AuditItem[] = res.json().data;
    expect(data.map((d) => d.action)).toEqual([
      'membership.invited',
      'event.updated',
      'event.created',
    ]);
    expect(data[0]!.actor).toEqual({ type: 'user', id: t.owner.id, email: t.owner.email });
    expect(data[1]!.metadata).toEqual({ fields: ['name'] });
    // The invitee address is masked in metadata and never appears in plain form.
    expect(JSON.stringify(data)).not.toContain(t.invitee);
  });

  it('only roles with audit.read may view it; other tenants get 404', async () => {
    const t = await busyOrg(['admin', 'event_manager', 'billing_admin', 'viewer']);
    expect((await t.list('', t.members.admin)).statusCode).toBe(200);
    for (const role of ['event_manager', 'billing_admin', 'viewer']) {
      expect((await t.list('', t.members[role])).statusCode, role).toBe(403);
    }
    const outsider = (await busyOrg()).owner;
    expect((await t.list('', outsider)).statusCode).toBe(404);
  });

  it('never shows another tenant’s rows or platform-level identity events', async () => {
    const a = await busyOrg();
    const b = await busyOrg();
    const ids = new Set(((await a.list('?limit=100')).json().data as AuditItem[]).map((d) => d.id));
    const bRows = await pools.migrator.query<{ id: string }>(
      'SELECT id FROM eventhub.audit_event WHERE organization_id = $1',
      [b.orgId],
    );
    for (const r of bRows.rows) expect(ids.has(r.id)).toBe(false);
    // Owner A's own sign-in style events (org NULL) never leak into the tenant view.
    await pools.migrator.query(
      `INSERT INTO eventhub.audit_event (organization_id, actor_type, actor_id, action, target_type, target_id, correlation_id)
       VALUES (NULL, 'user', $1, 'identity.logged_in', 'user', $1, 'c')`,
      [a.owner.id],
    );
    const actions = ((await a.list('?limit=100')).json().data as AuditItem[]).map((d) => d.action);
    expect(actions.some((x) => x.startsWith('identity.'))).toBe(false);
  });

  it('filters by action, category, object, actor and time range', async () => {
    const t = await busyOrg(['admin']);
    await app.inject({
      method: 'POST',
      url: `/v1/organizations/${t.orgId}/invitations`,
      headers: { ...auth(t.members.admin!), ...idem() },
      payload: { email: `x-${randomUUID()}@example.test`, role: 'viewer' },
    });
    const actions = async (q: string) =>
      ((await t.list(q)).json().data as AuditItem[]).map((d) => d.action);

    expect(await actions('?action=event.created')).toEqual(['event.created']);
    expect(await actions('?actionPrefix=event.')).toEqual(['event.updated', 'event.created']);
    expect(await actions(`?targetType=event&targetId=${t.eventId}`)).toEqual([
      'event.updated',
      'event.created',
    ]);
    expect(await actions(`?actorId=${t.members.admin!.id}`)).toEqual(['membership.invited']);
    expect(
      await actions(`?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`),
    ).toEqual([]);
    expect((await t.list('?action=membership.')).statusCode).toBe(400);
  });

  it('pages with a stable cursor and no duplicates', async () => {
    const t = await busyOrg();
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: 'POST',
        url: `/v1/organizations/${t.orgId}/invitations`,
        headers: { ...auth(t.owner), ...idem() },
        payload: { email: `p${i}-${randomUUID()}@example.test`, role: 'viewer' },
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await t.list(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      const page = res.json();
      seen.push(...(page.data as AuditItem[]).map((d) => d.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7); // event.created, event.updated, 5 invitations
    expect(new Set(seen).size).toBe(7);
  });

  it('the audit log stays immutable through the viewer’s database role', async () => {
    const t = await busyOrg();
    const id = ((await t.list()).json().data as AuditItem[])[0]!.id;
    await expect(
      pools.app.query(`UPDATE eventhub.audit_event SET action = 'x.y' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pools.app.query('DELETE FROM eventhub.audit_event WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
