import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { InMemoryEmailSender } from '@eventhub/kernel';
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
import {
  sendRegistrationCancelledConsumer,
  sendRegistrationConfirmationConsumer,
  sendRegistrationDeclinedConsumer,
} from '../../apps/worker/src/consumers/send-registration-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';
import { sendAnnouncementConsumer } from '../../apps/worker/src/consumers/send-announcement.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret
const SITE = 'https://{handle}.eventhub.example';

/** Staff's private notes on registrations (ADR-0067). */
describe('organizer notes', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendRegistrationConfirmationConsumer(inbox, { publicSiteUrl: SITE, tokenSecret: SECRET }),
    sendRegistrationCancelledConsumer(inbox),
    sendRegistrationDeclinedConsumer(inbox),
    sendAnnouncementConsumer(inbox, { publicSiteUrl: SITE }),
  ]);
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.75.${Math.floor(++ip / 250)}.${ip % 250}` });
  const mails = (to: string, template?: string) =>
    inbox.sent.filter((m) => m.to === to && (!template || m.template === template));
  async function drain(until: () => boolean) {
    for (let i = 0; i < 30 && !until(); i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    }
  }
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
  const email = () => `attendee-${randomUUID()}@example.test`;
  const tokenFrom = (text: string) => /#token=([A-Za-z0-9_-]{43})/.exec(text)![1]!;

  const approving = (registration: Record<string, unknown> = {}) =>
    publishedEvent({ approval: true, ...registration }, [
      'registration_manager',
      'viewer',
      'content_editor',
    ]);
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
  type T = Awaited<ReturnType<typeof approving>>;
  /** Asks for a place and returns the request with its withdraw link. */
  async function ask(t: T, name = 'Rae Requester') {
    const addr = email();
    const res = await t.register({ name, email: addr });
    expect(res.statusCode, res.body).toBe(202);
    await drain(() => mails(addr, 'registration_requested').length > 0);
    const mail = mails(addr, 'registration_requested')[0]!;
    const row = (await rowOf(t.eventId, addr))!;
    return { addr, id: row.id, token: tokenFrom(mail.text), mail };
  }

  const staffEvent = () =>
    publishedEvent({ capacity: 10 }, ['registration_manager', 'viewer', 'content_editor']);
  type S = Awaited<ReturnType<typeof staffEvent>>;
  /** Registers someone and returns the entry with the personal link from their email. */
  async function join(t: S, name = 'Nia Noted') {
    const addr = email();
    const res = await t.register({ name, email: addr });
    expect(res.statusCode, res.body).toBe(202);
    await drain(() => mails(addr, 'registration_confirmed').length > 0);
    const mail = mails(addr, 'registration_confirmed')[0]!;
    const row = (await rowOf(t.eventId, addr))!;
    return { addr, id: row.id, token: tokenFrom(mail.text) };
  }
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
  const noteRow = async (id: string) =>
    (
      await pools.migrator.query<{
        staff_note: string | null;
        staff_note_updated_at: Date | null;
        staff_note_updated_by: string | null;
      }>(
        'SELECT staff_note, staff_note_updated_at, staff_note_updated_by FROM eventhub.registration WHERE id = $1',
        [id],
      )
    ).rows[0]!;
  const auditsFor = async (orgId: string) =>
    (
      await pools.migrator.query<{ target_id: string; metadata: Record<string, unknown> }>(
        `SELECT target_id, metadata FROM eventhub.audit_event
          WHERE organization_id = $1 AND action = 'registration.note_changed' ORDER BY occurred_at`,
        [orgId],
      )
    ).rows;

  it('staff write a note; it shows in the list, the export and at the door', async () => {
    const t = await staffEvent();
    const r = await join(t);
    const note = 'VIP: front row.\nNeeds step-free access.';
    const res = await setNote(t, r.id, `  ${note}  `);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: r.id, staffNote: note });
    expect(res.json().staffNoteUpdatedAt).not.toBeNull();
    expect(await noteRow(r.id)).toMatchObject({
      staff_note: note,
      staff_note_updated_by: t.owner.id,
    });

    const listed = (await t.list()).json<{ data: { id: string; staffNote: string | null }[] }>();
    expect(listed.data.find((x) => x.id === r.id)!.staffNote).toBe(note);
    const exported = await t.exportList();
    expect(exported.statusCode).toBe(200);
    expect(exported.json().data[0].staffNote).toBe(note);
    const door = await call({
      method: 'GET',
      url: `/v1/organizations/${t.orgId}/events/${t.eventId}/check-in?ticket=${r.id}`,
      headers: auth(t.owner),
    });
    expect(door.statusCode).toBe(200);
    expect(door.json().data[0].staffNote).toBe(note);
    // The answers stay off the door list; the note is there for the door.
    expect(door.json().data[0].answers).toBeUndefined();

    // The audit says the note changed, never what it says.
    const audit = await auditsFor(t.orgId);
    expect(audit).toEqual([{ target_id: r.id, metadata: { eventId: t.eventId, cleared: false } }]);
    expect(JSON.stringify(audit)).not.toContain('VIP');
  });

  it('the same note again records nothing; an empty note clears it', async () => {
    const t = await staffEvent();
    const r = await join(t);
    await setNote(t, r.id, 'Speaker');
    const first = (await noteRow(r.id)).staff_note_updated_at;
    const again = await setNote(t, r.id, ' Speaker ');
    expect(again.statusCode).toBe(200);
    expect((await noteRow(r.id)).staff_note_updated_at).toEqual(first);
    expect(await auditsFor(t.orgId)).toHaveLength(1);

    for (const empty of ['', '   \n  ']) {
      await setNote(t, r.id, 'Something');
      const cleared = await setNote(t, r.id, empty);
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().staffNote).toBeNull();
      expect((await noteRow(r.id)).staff_note).toBeNull();
    }
    expect((await auditsFor(t.orgId)).at(-1)!.metadata).toEqual({
      eventId: t.eventId,
      cleared: true,
    });
    // Clearing an empty note records nothing either.
    const before = (await auditsFor(t.orgId)).length;
    await setNote(t, r.id, '');
    expect(await auditsFor(t.orgId)).toHaveLength(before);
  });

  it('one entry changes, not its neighbours', async () => {
    const t = await staffEvent();
    const a = await join(t, 'Ana');
    const b = await join(t, 'Ben');
    await setNote(t, a.id, 'Only Ana');
    expect((await noteRow(a.id)).staff_note).toBe('Only Ana');
    expect(await noteRow(b.id)).toEqual({
      staff_note: null,
      staff_note_updated_at: null,
      staff_note_updated_by: null,
    });
  });

  it('notes can be kept on any entry: cancelled, waitlisted, pending', async () => {
    const t = await staffEvent();
    const r = await join(t);
    await call({
      method: 'POST',
      url: `${t.base}/${r.id}/cancel`,
      headers: { ...auth(t.owner), ...idem() },
    });
    const res = await setNote(t, r.id, 'Cancelled by phone');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'cancelled', staffNote: 'Cancelled by phone' });
    const ap = await approving();
    const req = await ask(ap);
    const p = await call({
      method: 'PATCH',
      url: `${ap.base}/${req.id}/note`,
      headers: { ...auth(ap.owner), ...idem() },
      payload: { note: 'Partner list' },
    });
    expect(p.json()).toMatchObject({ status: 'pending', staffNote: 'Partner list' });
  });

  it('validates the note: up to 500 characters of plain text, nothing else', async () => {
    const t = await staffEvent();
    const r = await join(t);
    expect((await setNote(t, r.id, 'x'.repeat(500))).statusCode).toBe(200);
    // Line breaks from a browser form (CRLF, or a lone CR) are kept as plain line breaks.
    const crlf = await setNote(t, r.id, 'Line one\r\nLine two\rLine three');
    expect(crlf.statusCode, crlf.body).toBe(200);
    expect(crlf.json().staffNote).toBe('Line one\nLine two\nLine three');
    // Trimmed first, so surrounding spaces do not count.
    expect((await setNote(t, r.id, ` ${'y'.repeat(500)} `)).statusCode).toBe(200);
    for (const bad of [
      'x'.repeat(501),
      'tab\there',
      'bell\u0007',
      'nul\u0000',
      'del\u007f',
      42,
      null,
    ]) {
      const res = await setNote(t, r.id, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const extra = await call({
      method: 'PATCH',
      url: `${t.base}/${r.id}/note`,
      headers: { ...auth(t.owner), ...idem() },
      payload: { note: 'ok', status: 'confirmed' },
    });
    expect(extra.statusCode).toBe(400);
    const missing = await call({
      method: 'PATCH',
      url: `${t.base}/${r.id}/note`,
      headers: { ...auth(t.owner), ...idem() },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const noKey = await call({
      method: 'PATCH',
      url: `${t.base}/${r.id}/note`,
      headers: auth(t.owner),
      payload: { note: 'ok' },
    });
    expect(noKey.statusCode).toBe(400);
    expect((await noteRow(r.id)).staff_note).toBe('y'.repeat(500));
  });

  it('a repeated save with the same key replays; the same key with another note is refused', async () => {
    const t = await staffEvent();
    const r = await join(t);
    const key = idem();
    const a = await setNote(t, r.id, 'First', t.owner, key);
    const b = await setNote(t, r.id, 'First', t.owner, key);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect((await setNote(t, r.id, 'Second', t.owner, key)).statusCode).toBe(422);
    expect((await noteRow(r.id)).staff_note).toBe('First');
    expect(await auditsFor(t.orgId)).toHaveLength(1);
  });

  it('needs registration.manage; other organizations and events find nothing', async () => {
    const t = await staffEvent();
    const r = await join(t);
    for (const role of ['viewer', 'content_editor'] as const) {
      expect((await setNote(t, r.id, 'No', t.members[role])).statusCode, role).toBe(403);
    }
    const ok = await setNote(t, r.id, 'By the manager', t.members.registration_manager);
    expect(ok.statusCode).toBe(200);
    expect((await noteRow(r.id)).staff_note_updated_by).toBe(t.members.registration_manager!.id);

    const other = await staffEvent();
    // Another organization's owner at this address: refused.
    expect((await setNote(t, r.id, 'Theirs', other.owner)).statusCode).toBe(404);
    // At their own event's address, with this entry's ID: not found.
    expect((await setNote(other, r.id, 'Crossed')).statusCode).toBe(404);
    // Another event in the same organization: not found either.
    const sid = await createFixtureEvent(pools.migrator, t.orgId, t.owner.id);
    const crossed = await call({
      method: 'PATCH',
      url: `/v1/organizations/${t.orgId}/events/${sid}/registrations/${r.id}/note`,
      headers: { ...auth(t.owner), ...idem() },
      payload: { note: 'Wrong event' },
    });
    expect(crossed.statusCode).toBe(404);
    expect((await setNote(t, randomUUID(), 'Nobody')).statusCode).toBe(404);
    expect((await noteRow(r.id)).staff_note).toBe('By the manager');
    // Listing their own registrations, the other organization sees none of this.
    expect(JSON.stringify((await other.list()).json())).not.toContain('By the manager');
  });

  it('the person never sees the note, on the page their link opens or anywhere public', async () => {
    const t = await staffEvent();
    const r = await join(t);
    await setNote(t, r.id, 'Private: difficult on the phone');
    const own = await call({
      method: 'POST',
      url: '/v1/public/registrations/details',
      payload: { token: r.token },
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.body).not.toContain('Private');
    expect(own.json().staffNote).toBeUndefined();
    // Saving their own details leaves the note alone.
    const saved = await call({
      method: 'POST',
      url: '/v1/public/registrations/details/update',
      payload: { token: r.token, name: 'Nia Renamed' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain('Private');
    expect((await noteRow(r.id)).staff_note).toBe('Private: difficult on the phone');
    // Nor does any email the person gets.
    expect(mails(r.addr).some((m) => m.text.includes('Private'))).toBe(false);
  });

  it('only the API role, within the tenant, can write a note; the database keeps the rules', async () => {
    const t = await staffEvent();
    const r = await join(t);
    await expect(
      pools.worker.query(`UPDATE eventhub.registration SET staff_note = 'x' WHERE id = $1`, [r.id]),
    ).rejects.toThrow(/permission denied/);
    // Without the tenant set, the API role sees no rows to change.
    const changed = await pools.app.query(
      `UPDATE eventhub.registration SET staff_note = 'x' WHERE id = $1`,
      [r.id],
    );
    expect(changed.rowCount).toBe(0);
    // An empty or overlong note, or a change time without who made it, is refused outright.
    for (const sql of [
      `UPDATE eventhub.registration SET staff_note = '' WHERE id = $1`,
      `UPDATE eventhub.registration SET staff_note = repeat('x', 501) WHERE id = $1`,
      `UPDATE eventhub.registration SET staff_note_updated_at = now() WHERE id = $1`,
    ]) {
      await expect(pools.migrator.query(sql, [r.id]), sql).rejects.toThrow(/check constraint/);
    }
  });
});
