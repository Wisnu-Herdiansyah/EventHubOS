import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createFixtureUser, createTestPools } from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';

const PASSWORD = 'Systematic Elegance 2027'; // pragma: allowlist secret (synthetic)
const IDLE_SECONDS = 15 * 60;

/** Idle session timeout (ADR-0018), with a 15-minute setting. */
describe('idle session timeout', () => {
  const pools = createTestPools();
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.50.${Math.floor(++ip / 250)}.${ip % 250}` });

  async function signedIn(): Promise<{ email: string; token: string }> {
    const email = `idle-${randomUUID()}@example.test`;
    await call({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: PASSWORD } });
    const res = await call({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    return { email, token: res.json().token };
  }
  const me = (token: string) =>
    call({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
  /** Pretends the session's last request was `minutes` ago. */
  const lastActive = (token: string, minutes: number) =>
    pools.migrator.query(
      `UPDATE eventhub.auth_session SET last_seen_at = now() - make_interval(mins => $2)
        WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [token, minutes],
    );
  const row = async (token: string) =>
    (
      await pools.migrator.query<{ revoked_at: Date | null; last_seen_at: Date | null }>(
        `SELECT revoked_at, last_seen_at FROM eventhub.auth_session
          WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
        [token],
      )
    ).rows[0]!;

  beforeAll(async () => {
    app = await buildApp({
      pool: pools.app,
      authenticator: new DatabaseSessionAuthenticator(pools.app, { idleSeconds: IDLE_SECONDS }),
      passwordHasher: new Argon2idPasswordHasher(),
      identity: {
        sessionTtlSeconds: 3600,
        sessionIdleSeconds: IDLE_SECONDS,
        loginMaxFailures: 5,
        loginLockSeconds: 900,
      },
      logger: false,
      validateResponses: true,
    });
  });
  afterAll(async () => {
    await app.close();
    await pools.end();
  });

  it('keeps a session alive while it is used within the timeout', async () => {
    const { token } = await signedIn();
    await lastActive(token, 14);
    expect((await me(token)).statusCode).toBe(200);
    // The request counted as activity: the clock was reset.
    const seen = (await row(token)).last_seen_at!.getTime();
    expect(Date.now() - seen).toBeLessThan(60_000);
  });

  it('ends a session idle for longer than the timeout, for good', async () => {
    const { token } = await signedIn();
    await lastActive(token, 16);
    const res = await me(token);
    expect(res.statusCode).toBe(401);
    // The reason is not disclosed.
    expect(res.json().error).toMatchObject({ code: 'unauthenticated' });
    expect(JSON.stringify(res.json())).not.toMatch(/idle/i);
    expect((await row(token)).revoked_at).not.toBeNull();

    // Making it look recent again does not bring it back: it was revoked.
    await lastActive(token, 0);
    expect((await me(token)).statusCode).toBe(401);
  });

  it('hides idle sessions from the sessions list and reports the policy', async () => {
    const { email, token: stale } = await signedIn();
    const fresh = (
      await call({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } })
    ).json().token as string;
    await lastActive(stale, 20); // idle but not yet touched by a request
    const res = await call({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].current).toBe(true);
    expect(res.json().policy).toEqual({ idleMinutes: 15, maxHours: 1 });
  });

  it('gives sessions without recorded activity (from before 0009) a fresh start', async () => {
    // createFixtureUser writes a session created 2 hours ago with no last activity.
    const legacy = await createFixtureUser(pools.migrator);
    expect((await me(legacy.token)).statusCode).toBe(200);
    expect((await row(legacy.token)).last_seen_at).not.toBeNull(); // the clock starts now
    await lastActive(legacy.token, 16);
    expect((await me(legacy.token)).statusCode).toBe(401);
  });

  it('still enforces the absolute expiry', async () => {
    const { token } = await signedIn();
    await pools.migrator.query(
      `UPDATE eventhub.auth_session SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 minute', last_seen_at = now()
        WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [token],
    );
    expect((await me(token)).statusCode).toBe(401);
  });
});
