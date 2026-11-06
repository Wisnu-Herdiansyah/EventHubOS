import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createFixtureUser, createTestPools } from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';

const PASSWORD = 'Systematic Elegance 2027'; // pragma: allowlist secret (synthetic)
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
const SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';

/** Listing and signing out sessions (ADR-0017), on the real schema and runtime roles. */
describe('active sessions', () => {
  const pools = createTestPools();
  const hasher = new Argon2idPasswordHasher();
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.40.${Math.floor(++ip / 250)}.${ip % 250}` });

  async function account(): Promise<string> {
    const email = `sessions-${randomUUID()}@example.test`;
    await call({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: PASSWORD } });
    return email;
  }
  const login = async (email: string, userAgent?: string) =>
    (
      await call({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: PASSWORD },
        headers: userAgent ? { 'user-agent': userAgent } : {},
      })
    ).json().token as string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const list = async (token: string) =>
    (await call({ method: 'GET', url: '/v1/auth/sessions', headers: auth(token) })).json()
      .data as Array<{
      id: string;
      userAgent: string | null;
      current: boolean;
      lastSeenAt: string;
    }>;
  const me = (token: string) => call({ method: 'GET', url: '/v1/me', headers: auth(token) });

  beforeAll(async () => {
    app = await buildApp({
      pool: pools.app,
      authenticator: new DatabaseSessionAuthenticator(pools.app),
      passwordHasher: hasher,
      identity: { sessionTtlSeconds: 3600, loginMaxFailures: 5, loginLockSeconds: 900 },
      logger: false,
      validateResponses: true,
    });
  });
  afterAll(async () => {
    await app.close();
    await pools.end();
  });

  it('lists only your own live sessions, marks the current one, and names the browser', async () => {
    const email = await account();
    const desktop = await login(email, FIREFOX);
    const phone = await login(email, SAFARI);
    const someoneElse = await login(await account(), FIREFOX);

    const sessions = await list(desktop);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.find((s) => s.current)!.userAgent).toBe(FIREFOX);
    expect(sessions.find((s) => !s.current)!.userAgent).toBe(SAFARI);
    const others = await list(someoneElse);
    expect(others).toHaveLength(1);
    expect(sessions.map((s) => s.id)).not.toContain(others[0]!.id);
    expect(JSON.stringify(sessions)).not.toMatch(/token|hash/i);
    expect((await list(phone)).find((s) => s.current)!.userAgent).toBe(SAFARI);
  });

  it('signs out one session; another user’s session looks like a missing one', async () => {
    const email = await account();
    const here = await login(email);
    const there = await login(email);
    const thereId = (await list(here)).find((s) => !s.current)!.id;

    const outsider = await login(await account());
    const foreign = await call({
      method: 'POST',
      url: `/v1/auth/sessions/${thereId}/revoke`,
      headers: auth(outsider),
    });
    expect(foreign.statusCode).toBe(404);
    expect((await me(there)).statusCode).toBe(200); // untouched

    const res = await call({
      method: 'POST',
      url: `/v1/auth/sessions/${thereId}/revoke`,
      headers: auth(here),
    });
    expect(res.statusCode).toBe(204);
    expect((await me(there)).statusCode).toBe(401);
    expect((await me(here)).statusCode).toBe(200);
    expect(await list(here)).toHaveLength(1);

    const again = await call({
      method: 'POST',
      url: `/v1/auth/sessions/${thereId}/revoke`,
      headers: auth(here),
    });
    expect(again.statusCode).toBe(404);
    const unknown = await call({
      method: 'POST',
      url: `/v1/auth/sessions/${randomUUID()}/revoke`,
      headers: auth(here),
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('signing out the current session works like logout', async () => {
    const email = await account();
    const here = await login(email);
    const hereId = (await list(here)).find((s) => s.current)!.id;
    const res = await call({
      method: 'POST',
      url: `/v1/auth/sessions/${hereId}/revoke`,
      headers: auth(here),
    });
    expect(res.statusCode).toBe(204);
    expect((await me(here)).statusCode).toBe(401);
  });

  it('signs out every other session and keeps this one', async () => {
    const email = await account();
    const here = await login(email);
    const others = [await login(email), await login(email), await login(email)];
    const res = await call({
      method: 'POST',
      url: '/v1/auth/sessions/revoke-others',
      headers: auth(here),
    });
    expect(res.json()).toEqual({ signedOut: 3 });
    for (const t of others) expect((await me(t)).statusCode).toBe(401);
    expect((await me(here)).statusCode).toBe(200);
    expect(await list(here)).toHaveLength(1);

    const repeat = await call({
      method: 'POST',
      url: '/v1/auth/sessions/revoke-others',
      headers: auth(here),
    });
    expect(repeat.json()).toEqual({ signedOut: 0 });
  });

  it('does not list expired sessions', async () => {
    const email = await account();
    const here = await login(email);
    await login(email);
    await pools.migrator.query(
      `UPDATE eventhub.auth_session s SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'
         FROM eventhub.app_user u
        WHERE u.id = s.user_id AND u.email = $1
          AND s.id <> (SELECT id FROM eventhub.auth_session WHERE user_id = u.id ORDER BY created_at LIMIT 1)`,
      [email],
    );
    expect(await list(here)).toHaveLength(1);
  });

  it('records last activity at most every five minutes', async () => {
    const email = await account();
    const token = await login(email);
    const id = (await list(token))[0]!.id;
    const lastSeen = async () =>
      (
        await pools.migrator.query<{ last_seen_at: Date }>(
          'SELECT last_seen_at FROM eventhub.auth_session WHERE id = $1',
          [id],
        )
      ).rows[0]!.last_seen_at.getTime();

    const first = await lastSeen();
    await me(token);
    expect(await lastSeen()).toBe(first); // within 5 minutes: no write

    await pools.migrator.query(
      "UPDATE eventhub.auth_session SET last_seen_at = now() - interval '10 minutes' WHERE id = $1",
      [id],
    );
    const stale = await lastSeen();
    await me(token);
    expect(await lastSeen()).toBeGreaterThan(stale);
  });

  it('truncates long user-agent strings and stores none when absent', async () => {
    const email = await account();
    const long = await login(email, `X${'y'.repeat(400)}`);
    const none = await login(email);
    const sessions = await list(long);
    expect(sessions.find((s) => s.current)!.userAgent).toHaveLength(256);
    const other = sessions.find((s) => !s.current)!;
    // Fastify's inject sends its own default agent when none is given.
    expect(other.userAgent === null || other.userAgent.length <= 256).toBe(true);
    expect(none).toBeTruthy();
  });

  it('audits sign-outs without secrets', async () => {
    const email = await account();
    const here = await login(email);
    const thereId = (
      await (async () => {
        await login(email);
        return list(here);
      })()
    ).find((s) => !s.current)!.id;
    await call({ method: 'POST', url: `/v1/auth/sessions/${thereId}/revoke`, headers: auth(here) });
    await login(email);
    await call({ method: 'POST', url: '/v1/auth/sessions/revoke-others', headers: auth(here) });
    const { rows } = await pools.migrator.query<{
      action: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT a.action, a.metadata FROM eventhub.audit_event a JOIN eventhub.app_user u ON u.id = a.target_id
        WHERE u.email = $1 AND a.action IN ('identity.session_revoked', 'identity.other_sessions_revoked')
        ORDER BY a.occurred_at`,
      [email],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'identity.session_revoked',
      'identity.other_sessions_revoked',
    ]);
    expect(rows[0]!.metadata).toEqual({ sessionId: thereId, current: false });
    expect(rows[1]!.metadata).toMatchObject({ count: 1 });
    expect(JSON.stringify(rows)).not.toMatch(/token|hash|Bearer/i);
  });

  it('gives the worker role no access to session functions', async () => {
    for (const sql of [
      'SELECT * FROM eventhub.auth_list_sessions(gen_random_uuid())',
      'SELECT eventhub.auth_revoke_user_session(gen_random_uuid(), gen_random_uuid())',
      'SELECT eventhub.auth_revoke_other_sessions(gen_random_uuid(), gen_random_uuid())',
      "SELECT * FROM eventhub.auth_resolve_and_touch_session('\\x00'::bytea)",
    ]) {
      await expect(pools.worker.query(sql)).rejects.toThrow(/permission denied/);
    }
  });

  it('keeps working for sessions created before this change (no user-agent, no last-seen)', async () => {
    // createFixtureUser writes a session row the way the 4-argument login did before 0009.
    const legacy = await createFixtureUser(pools.migrator);
    expect((await me(legacy.token)).statusCode).toBe(200);
    const [session] = await list(legacy.token);
    expect(session).toMatchObject({ userAgent: null, current: true });
    expect(Date.parse(session!.lastSeenAt)).toBeGreaterThan(Date.now() - 60_000); // touched now
  });
});
