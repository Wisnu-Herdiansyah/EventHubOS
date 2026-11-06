import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPools } from '@eventhub/db/testing';
import {
  ARGON2ID_BASELINE,
  Argon2idPasswordHasher,
} from '../src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../src/app.ts';
import { DatabaseSessionAuthenticator } from '../src/modules/identity/authenticator.ts';
import { LOG_REDACT_PATHS } from '@eventhub/kernel';

const pools = createTestPools();
const logLines: string[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logLines.push(chunk.toString());
      cb();
    },
  });
  app = await buildApp({
    pool: pools.app,
    authenticator: new DatabaseSessionAuthenticator(pools.app),
    passwordHasher: new Argon2idPasswordHasher(),
    identity: { sessionTtlSeconds: 3600, loginMaxFailures: 3, loginLockSeconds: 900 },
    logger: false,
    loggerInstance: pino(
      { level: 'info', redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' } },
      sink,
    ),
    validateResponses: true,
    rateLimitPerMinute: 10_000,
  });
});
afterAll(async () => {
  await app.close();
  await pools.end();
});

const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret (synthetic test password)
const newEmail = () => `user-${randomUUID()}@example.test`;
// Distinct client IPs keep each test within the per-route auth rate limit.
const fromIp = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const post = (
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
  remoteAddress = fromIp(),
) => app.inject({ method: 'POST', url, payload: payload as object, headers, remoteAddress });

async function signUp(email: string, password = PASSWORD) {
  return post('/v1/auth/signup', { email, password });
}

async function logIn(email: string, password = PASSWORD) {
  return post('/v1/auth/login', { email, password });
}

async function userIdFor(email: string): Promise<string> {
  const { rows } = await pools.migrator.query<{ id: string }>(
    'SELECT id FROM eventhub.app_user WHERE email = $1',
    [email],
  );
  return rows[0]!.id;
}

/** Plays the worker's role: issue a verification token for the latest requested credential. */
async function issueVerificationToken(userId: string): Promise<string | null> {
  const { rows } = await pools.migrator.query<{ payload: { credentialVersion: number | null } }>(
    `SELECT payload FROM eventhub.outbox_event
      WHERE aggregate_id = $1 AND event_type = 'identity.email_verification_requested'
      ORDER BY occurred_at DESC LIMIT 1`,
    [userId],
  );
  const token = randomBytes(32).toString('base64url');
  const issued = await pools.worker.query(
    'SELECT out_email FROM eventhub.auth_issue_verification($1, $2, $3, 3600)',
    [userId, rows[0]!.payload.credentialVersion, createHash('sha256').update(token).digest()],
  );
  return issued.rows.length ? token : null;
}

describe('sign-up', () => {
  it('accepts a new account, stores only an Argon2id hash, and requests verification via the outbox', async () => {
    const email = newEmail();
    const res = await signUp(email);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'accepted' });

    const id = await userIdFor(email);
    const { rows } = await pools.migrator.query(
      `SELECT c.password_hash, u.email_verified_at,
              (SELECT payload FROM eventhub.outbox_event WHERE aggregate_id = $1 AND event_type = 'identity.email_verification_requested') AS payload,
              (SELECT count(*)::int FROM eventhub.audit_event WHERE target_id = $1 AND action = 'identity.signed_up' AND organization_id IS NULL) AS audits
         FROM eventhub.user_credential c JOIN eventhub.app_user u ON u.id = c.user_id WHERE c.user_id = $1`,
      [id],
    );
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
    expect(rows[0].email_verified_at).toBeNull();
    expect(rows[0].payload).toEqual({ userId: id, credentialVersion: 1 }); // identifiers only, no token/email
    expect(rows[0].audits).toBe(1);
  });

  it('normalises the email address', async () => {
    const email = newEmail();
    await signUp(`  ${email.toUpperCase()} `);
    expect(await userIdFor(email)).toBeTruthy();
  });

  it('enforces the password policy with field errors', async () => {
    const res = await signUp(newEmail(), 'short');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.fields[0].path).toBe('body.password');
    const email = newEmail();
    const same = await signUp(email, email);
    expect(same.statusCode).toBe(400);
  });

  it('gives an identical response for an already verified address and leaves its password untouched', async () => {
    const email = newEmail();
    await signUp(email);
    await pools.migrator.query(
      'UPDATE eventhub.app_user SET email_verified_at = now() WHERE email = $1',
      [email],
    );
    const res = await signUp(email, 'attacker chosen password 123');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual((await signUp(newEmail())).json());
    expect((await logIn(email)).statusCode).toBe(200);
    expect((await logIn(email, 'attacker chosen password 123')).statusCode).toBe(401);
  });
});

describe('login and sessions', () => {
  it('issues a bearer token usable for authenticated routes', async () => {
    const email = newEmail();
    await signUp(email);
    const res = await logIn(email);
    expect(res.statusCode).toBe(200);
    const session = res.json();
    expect(session).toMatchObject({ tokenType: 'Bearer', emailVerified: false });
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(me.json()).toEqual({ userId: await userIdFor(email), email, emailVerified: false });
    // Only the SHA-256 of the token is stored.
    const { rows } = await pools.migrator.query(
      'SELECT count(*)::int AS n FROM eventhub.auth_session WHERE token_hash = $1',
      [createHash('sha256').update(session.token).digest()],
    );
    expect(rows[0].n).toBe(1);
  });

  it('returns the same 401 for an unknown account and a wrong password', async () => {
    const email = newEmail();
    await signUp(email);
    const unknown = await logIn(newEmail());
    const wrong = await logIn(email, 'not the right password');
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe('invalid_credentials');
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
  });

  it('locks the account after repeated failures, even for the right password, and records evidence', async () => {
    const email = newEmail();
    await signUp(email);
    for (let i = 0; i < 3; i++)
      expect((await logIn(email, 'wrong password attempt')).statusCode).toBe(401);
    const locked = await logIn(email);
    expect(locked.statusCode).toBe(401);
    expect(locked.json().error.code).toBe('invalid_credentials');
    const { rows } = await pools.migrator.query<{ reasons: string[] }>(
      `SELECT array_agg(metadata->>'reason' ORDER BY occurred_at) AS reasons FROM eventhub.audit_event
        WHERE target_id = $1 AND action = 'identity.login_failed'`,
      [await userIdFor(email)],
    );
    expect(rows[0]!.reasons).toEqual(['bad_password', 'bad_password', 'bad_password', 'locked']);
  });

  it('a successful login resets the failure counter', async () => {
    const email = newEmail();
    await signUp(email);
    await logIn(email, 'wrong password attempt');
    await logIn(email, 'wrong password attempt');
    expect((await logIn(email)).statusCode).toBe(200);
    await logIn(email, 'wrong password attempt');
    await logIn(email, 'wrong password attempt');
    expect((await logIn(email)).statusCode).toBe(200);
  });

  it('upgrades a hash made with weaker parameters on successful login', async () => {
    const email = newEmail();
    await signUp(email);
    const weak = await new Argon2idPasswordHasher({
      ...ARGON2ID_BASELINE,
      memoryCost: 8192,
      timeCost: 1,
    }).hash(PASSWORD);
    const id = await userIdFor(email);
    await pools.migrator.query(
      'UPDATE eventhub.user_credential SET password_hash = $2 WHERE user_id = $1',
      [id, weak],
    );
    expect((await logIn(email)).statusCode).toBe(200);
    const { rows } = await pools.migrator.query(
      'SELECT password_hash, credential_version FROM eventhub.user_credential WHERE user_id = $1',
      [id],
    );
    expect(rows[0].password_hash).toMatch(/m=19456,p=1,t=2/);
    expect(rows[0].credential_version).toBe(1); // same password: no credential change
    expect((await logIn(email)).statusCode).toBe(200);
  });

  it('logout revokes the session', async () => {
    const email = newEmail();
    await signUp(email);
    const { token } = (await logIn(email)).json();
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers })).statusCode).toBe(
      204,
    );
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(401);
  });

  it('rate-limits login attempts per client IP', async () => {
    const ip = '192.0.2.77';
    const codes: number[] = [];
    for (let i = 0; i < 11; i++)
      codes.push(
        (await post('/v1/auth/login', { email: newEmail(), password: 'x' }, {}, ip)).statusCode,
      );
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('never writes passwords or session tokens to logs', async () => {
    const email = newEmail();
    const secret = `log-probe ${randomUUID()}`; // pragma: allowlist secret
    await signUp(email, secret);
    const { token } = (await logIn(email, secret)).json();
    await post('/v1/auth/login', { email, password: secret, extra: 'triggers validation error' });
    const all = logLines.join('');
    expect(all).not.toContain(secret);
    expect(all).not.toContain(token);
    expect(all).not.toContain(email);
  });
});

describe('email verification', () => {
  it('verifies with a valid token, revokes earlier sessions, and enables organization creation', async () => {
    const email = newEmail();
    await signUp(email);
    const before = (await logIn(email)).json().token;
    const token = await issueVerificationToken(await userIdFor(email));
    const res = await post('/v1/auth/verify-email', { token: token! });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'verified' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: `Bearer ${before}` },
        })
      ).statusCode,
    ).toBe(401);

    const session = (await logIn(email)).json();
    expect(session.emailVerified).toBe(true);
    const org = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { authorization: `Bearer ${session.token}`, 'idempotency-key': `k-${randomUUID()}` },
      payload: { displayName: 'Verified Org', locale: 'en', timezone: 'UTC' },
    });
    expect(org.statusCode).toBe(201);
  });

  it('tokens are single-use and unknown tokens are rejected', async () => {
    const email = newEmail();
    await signUp(email);
    const token = (await issueVerificationToken(await userIdFor(email)))!;
    expect((await post('/v1/auth/verify-email', { token })).statusCode).toBe(200);
    const again = await post('/v1/auth/verify-email', { token });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.details.reason).toBe('invalid_or_expired_token');
    expect(
      (await post('/v1/auth/verify-email', { token: randomBytes(32).toString('base64url') }))
        .statusCode,
    ).toBe(400);
  });

  it('expired tokens are rejected', async () => {
    const email = newEmail();
    await signUp(email);
    const id = await userIdFor(email);
    const token = (await issueVerificationToken(id))!;
    await pools.migrator.query(
      `UPDATE eventhub.email_verification_token SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE user_id = $1`,
      [id],
    );
    expect((await post('/v1/auth/verify-email', { token })).statusCode).toBe(400);
  });

  it('defeats account pre-hijacking: a later sign-up by the mailbox owner invalidates the attacker', async () => {
    const email = newEmail();
    await signUp(email, 'attacker password 12345');
    const attackerSession = (await logIn(email, 'attacker password 12345')).json().token;
    const attackerToken = (await issueVerificationToken(await userIdFor(email)))!; // e.g. intercepted later

    await signUp(email, PASSWORD); // the real owner registers
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: `Bearer ${attackerSession}` },
        })
      ).statusCode,
    ).toBe(401);
    expect((await logIn(email, 'attacker password 12345')).statusCode).toBe(401);
    expect((await post('/v1/auth/verify-email', { token: attackerToken })).statusCode).toBe(400);

    const ownerToken = (await issueVerificationToken(await userIdFor(email)))!;
    expect((await post('/v1/auth/verify-email', { token: ownerToken })).statusCode).toBe(200);
    expect((await logIn(email)).json().emailVerified).toBe(true);
  });

  it('a verification token for a superseded credential cannot be issued', async () => {
    const email = newEmail();
    await signUp(email, 'first password 123456');
    const id = await userIdFor(email);
    await signUp(email, PASSWORD); // version 2
    const stale = await pools.worker.query(
      'SELECT out_email FROM eventhub.auth_issue_verification($1, 1, $2, 3600)',
      [id, randomBytes(32)],
    );
    expect(stale.rows).toEqual([]);
  });

  it('resend requires an Idempotency-Key and enqueues one request per key', async () => {
    const email = newEmail();
    await signUp(email);
    const { token } = (await logIn(email)).json();
    const auth = { authorization: `Bearer ${token}` };
    expect((await post('/v1/auth/resend-verification', {}, auth)).statusCode).toBe(400);
    const headers = { ...auth, 'idempotency-key': `k-${randomUUID()}` };
    expect((await post('/v1/auth/resend-verification', {}, headers)).statusCode).toBe(202);
    const replay = await post('/v1/auth/resend-verification', {}, headers);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const { rows } = await pools.migrator.query(
      `SELECT count(*)::int AS n FROM eventhub.outbox_event WHERE aggregate_id = $1 AND event_type = 'identity.email_verification_requested'`,
      [await userIdFor(email)],
    );
    expect(rows[0].n).toBe(2); // one from sign-up, one from the resend (not two)
  });
});
