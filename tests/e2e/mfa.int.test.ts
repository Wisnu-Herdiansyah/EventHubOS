import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { InMemoryEmailSender } from '@eventhub/kernel';
import { createTestPools } from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';
import { base32Decode, hotp, totpStep } from '../../apps/api/src/modules/identity/totp.ts';
import { sendMfaChangedEmailConsumer } from '../../apps/worker/src/consumers/send-mfa-email.ts';
import { sendVerificationEmailConsumer } from '../../apps/worker/src/consumers/send-verification-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret
const PASSWORD = 'Systematic Elegance 2027'; // pragma: allowlist secret (synthetic)
const MFA_KEY = randomBytes(32);

/** Two-step verification with an authenticator app (ADR-0022), on the real schema and roles. */
describe('two-step verification', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendVerificationEmailConsumer(inbox, {
      appBaseUrl: 'https://app.example.test',
      ttlSeconds: 86_400,
      tokenSecret: SECRET,
    }),
    sendMfaChangedEmailConsumer(inbox, { appBaseUrl: 'https://app.example.test' }),
  ]);
  let app: FastifyInstance;
  let noKeyApp: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions, target = () => app) =>
    target().inject({ ...opts, remoteAddress: `10.60.${Math.floor(++ip / 250)}.${ip % 250}` });
  const mails = (to: string, template: string) =>
    inbox.sent.filter((m) => m.to === to && m.template === template);
  async function drain(until: () => boolean) {
    for (let i = 0; i < 30 && !until(); i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    }
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function account(): Promise<{ email: string; token: string; userId: string }> {
    const email = `mfa-${randomUUID()}@example.test`;
    await call({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: PASSWORD } });
    await drain(() => mails(email, 'verify_email').length > 0);
    const verify = /#token=([A-Za-z0-9_-]{43})$/m.exec(mails(email, 'verify_email')[0]!.text)![1]!;
    await call({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: verify } });
    const res = await login(email);
    const token = res.json().token as string;
    const me = await call({ method: 'GET', url: '/v1/me', headers: auth(token) });
    return { email, token, userId: me.json().userId };
  }
  const login = (email: string, password = PASSWORD) =>
    call({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  const post = (url: string, token: string, payload: object, target = () => app) =>
    call({ method: 'POST', url, headers: auth(token), payload }, target);
  const codeAt = (secret: Buffer, offset = 0) => hotp(secret, totpStep(Date.now()) + offset);
  /** Pretend time moved on, so the next code is not a replay (tests cannot wait 30 s). */
  const forgetUsedSteps = (userId: string) =>
    pools.migrator.query(
      'UPDATE eventhub.auth_mfa_factor SET last_used_step = 0 WHERE user_id = $1',
      [userId],
    );

  /** Turns MFA on and returns the decoded secret and recovery codes. */
  async function enable(a: { token: string; userId: string }) {
    const setup = await post('/v1/auth/mfa/setup', a.token, { currentPassword: PASSWORD });
    expect(setup.statusCode, setup.body).toBe(200);
    const secret = base32Decode(setup.json().secret);
    const confirm = await post('/v1/auth/mfa/confirm', a.token, { code: codeAt(secret) });
    expect(confirm.statusCode, confirm.body).toBe(200);
    await forgetUsedSteps(a.userId);
    return { secret, recoveryCodes: confirm.json().recoveryCodes as string[] };
  }
  async function challenge(email: string): Promise<string> {
    const res = await login(email);
    expect(res.json()).toMatchObject({ mfaRequired: true });
    expect(res.json().token).toBeUndefined();
    return res.json().challengeToken as string;
  }
  const complete = (challengeToken: string, factor: { code?: string; recoveryCode?: string }) =>
    call({ method: 'POST', url: '/v1/auth/login/mfa', payload: { challengeToken, ...factor } });

  beforeAll(async () => {
    const base = {
      pool: pools.app,
      authenticator: new DatabaseSessionAuthenticator(pools.app),
      passwordHasher: new Argon2idPasswordHasher(),
      logger: false as const,
      validateResponses: true,
    };
    const identity = { sessionTtlSeconds: 3600, loginMaxFailures: 5, loginLockSeconds: 900 };
    app = await buildApp({ ...base, identity: { ...identity, mfaEncryptionKey: MFA_KEY } });
    noKeyApp = await buildApp({ ...base, identity });
  });
  afterAll(async () => {
    await app.close();
    await noKeyApp.close();
    await pools.end();
  });

  it('turns on with password, app code and recovery codes, and signs out other sessions', async () => {
    const a = await account();
    const other = (await login(a.email)).json().token as string;
    const off = await call({ method: 'GET', url: '/v1/auth/mfa', headers: auth(a.token) });
    expect(off.json()).toEqual({
      available: true,
      status: 'off',
      enabledAt: null,
      recoveryCodesRemaining: 0,
    });

    const wrongPassword = await post('/v1/auth/mfa/setup', a.token, { currentPassword: 'nope' });
    expect(wrongPassword.statusCode).toBe(400);
    expect(wrongPassword.json().error.details.reason).toBe('bad_current_password');

    const setup = await post('/v1/auth/mfa/setup', a.token, { currentPassword: PASSWORD });
    expect(setup.statusCode).toBe(200);
    const secret = base32Decode(setup.json().secret);
    expect(secret).toHaveLength(20);
    expect(setup.json().otpauthUri).toContain('issuer=EventHub+OS');
    // Sealed at rest: the raw secret is not in the database.
    const stored = await pools.migrator.query(
      'SELECT secret_sealed, status FROM eventhub.auth_mfa_factor WHERE user_id = $1',
      [a.userId],
    );
    expect(stored.rows[0].status).toBe('pending');
    expect((stored.rows[0].secret_sealed as Buffer).includes(secret)).toBe(false);

    const wrong = await post('/v1/auth/mfa/confirm', a.token, { code: '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.details.reason).toBe('bad_code');

    const confirm = await post('/v1/auth/mfa/confirm', a.token, { code: codeAt(secret) });
    expect(confirm.statusCode).toBe(200);
    const codes = confirm.json().recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    const on = (await call({ method: 'GET', url: '/v1/auth/mfa', headers: auth(a.token) })).json();
    expect(on).toMatchObject({ status: 'on', recoveryCodesRemaining: 10 });
    // This session stays; others end.
    expect((await call({ method: 'GET', url: '/v1/me', headers: auth(a.token) })).statusCode).toBe(
      200,
    );
    expect((await call({ method: 'GET', url: '/v1/me', headers: auth(other) })).statusCode).toBe(
      401,
    );
    // Only hashes of recovery codes are stored.
    const stored2 = await pools.migrator.query(
      'SELECT code_hash FROM eventhub.auth_mfa_recovery_code WHERE user_id = $1',
      [a.userId],
    );
    expect(JSON.stringify(stored2.rows)).not.toContain(codes[0]!.replace('-', ''));
    await drain(() => mails(a.email, 'mfa_enabled').length > 0);
    expect(mails(a.email, 'mfa_enabled')[0]!.text).not.toMatch(/\d{6}/);

    // Already on: a second setup is refused.
    const again = await post('/v1/auth/mfa/setup', a.token, { currentPassword: PASSWORD });
    expect(again.json().error.details.reason).toBe('mfa_already_enabled');
  });

  it('asks for a code at sign-in; challenges and codes work once', async () => {
    const a = await account();
    const { secret } = await enable(a);

    const ch = await challenge(a.email);
    const bad = await complete(ch, { code: '000000' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.details.reason).toBe('bad_code');

    const code = codeAt(secret);
    const ok = await complete(ch, { code });
    expect(ok.statusCode).toBe(200);
    const session = ok.json().token as string;
    expect((await call({ method: 'GET', url: '/v1/me', headers: auth(session) })).statusCode).toBe(
      200,
    );

    // The challenge is spent.
    const reuse = await complete(ch, { code: codeAt(secret, 1) });
    expect(reuse.json().error.details.reason).toBe('challenge_invalid');
    // The same app code cannot be replayed on a new challenge.
    const replay = await complete(await challenge(a.email), { code });
    expect(replay.json().error.details.reason).toBe('bad_code');

    const audit = await pools.migrator.query(
      `SELECT metadata FROM eventhub.audit_event
        WHERE target_id = $1 AND action = 'identity.logged_in' ORDER BY occurred_at DESC LIMIT 1`,
      [a.userId],
    );
    expect(audit.rows[0].metadata.mfa).toBe('totp');
  });

  it('accepts each recovery code once and tells the owner', async () => {
    const a = await account();
    const { recoveryCodes } = await enable(a);
    const first = recoveryCodes[0]!;
    const ok = await complete(await challenge(a.email), { recoveryCode: first.toUpperCase() });
    expect(ok.statusCode).toBe(200);
    const again = await complete(await challenge(a.email), { recoveryCode: first });
    expect(again.json().error.details.reason).toBe('bad_code');
    const status = await call({ method: 'GET', url: '/v1/auth/mfa', headers: auth(a.token) });
    expect(status.json().recoveryCodesRemaining).toBe(9);
    await drain(() => mails(a.email, 'mfa_recovery_code_used').length > 0);
    expect(mails(a.email, 'mfa_recovery_code_used')).toHaveLength(1);
  });

  it('locks the account after repeated wrong codes, like wrong passwords', async () => {
    const a = await account();
    const { secret } = await enable(a);
    for (let i = 0; i < 5; i++) {
      await complete(await challenge(a.email), { code: '000000' });
    }
    // Locked: the right password no longer even yields a challenge, and a live challenge with the
    // right code is refused.
    expect((await login(a.email)).statusCode).toBe(401);
    const manual = randomBytes(32).toString('base64url');
    await pools.migrator.query(
      `INSERT INTO eventhub.auth_mfa_challenge (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '5 minutes')`,
      [a.userId, createHash('sha256').update(manual).digest()],
    );
    const locked = await complete(manual, { code: codeAt(secret) });
    expect(locked.json().error.details.reason).toBe('locked');
    expect(locked.statusCode).toBe(401);
  });

  it('refuses expired challenges and caps attempts per challenge', async () => {
    const a = await account();
    const { secret } = await enable(a);
    const ch = await challenge(a.email);
    await pools.migrator.query(
      `UPDATE eventhub.auth_mfa_challenge SET expires_at = now() - interval '1 second'
        WHERE user_id = $1`,
      [a.userId],
    );
    expect((await complete(ch, { code: codeAt(secret) })).json().error.details.reason).toBe(
      'challenge_invalid',
    );
    // Attempts: a challenge with 5 failures is dead even with a correct code.
    await pools.migrator.query(
      'UPDATE eventhub.user_credential SET failed_login_count = 0, locked_until = NULL WHERE user_id = $1',
      [a.userId],
    );
    const ch2 = await challenge(a.email);
    await pools.migrator.query(
      `UPDATE eventhub.auth_mfa_challenge SET attempts = 5 WHERE user_id = $1 AND consumed_at IS NULL`,
      [a.userId],
    );
    expect((await complete(ch2, { code: codeAt(secret) })).json().error.details.reason).toBe(
      'challenge_invalid',
    );
  });

  it('turns off only with password and a second factor', async () => {
    const a = await account();
    const { secret } = await enable(a);
    const noCode = await post('/v1/auth/mfa/disable', a.token, { currentPassword: PASSWORD });
    expect(noCode.statusCode).toBe(400);
    const wrongCode = await post('/v1/auth/mfa/disable', a.token, {
      currentPassword: PASSWORD,
      code: '000000',
    });
    expect(wrongCode.json().error.details.reason).toBe('bad_code');
    const wrongPassword = await post('/v1/auth/mfa/disable', a.token, {
      currentPassword: 'nope',
      code: codeAt(secret),
    });
    expect(wrongPassword.json().error.details.reason).toBe('bad_current_password');

    const ok = await post('/v1/auth/mfa/disable', a.token, {
      currentPassword: PASSWORD,
      code: codeAt(secret),
    });
    expect(ok.statusCode).toBe(200);
    // Sign-in is password-only again (after the failures above were cleared by a success).
    await pools.migrator.query(
      'UPDATE eventhub.user_credential SET failed_login_count = 0, locked_until = NULL WHERE user_id = $1',
      [a.userId],
    );
    expect((await login(a.email)).json().token).toEqual(expect.any(String));
    const rows = await pools.migrator.query(
      'SELECT 1 FROM eventhub.auth_mfa_recovery_code WHERE user_id = $1',
      [a.userId],
    );
    expect(rows.rowCount).toBe(0);
    await drain(() => mails(a.email, 'mfa_disabled').length > 0);
    expect(mails(a.email, 'mfa_disabled')).toHaveLength(1);
  });

  it('replaces recovery codes; the old ones stop working', async () => {
    const a = await account();
    const { recoveryCodes: old } = await enable(a);
    const res = await post('/v1/auth/mfa/recovery-codes', a.token, { currentPassword: PASSWORD });
    expect(res.statusCode).toBe(200);
    const fresh = res.json().recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(old[0]);
    expect((await complete(await challenge(a.email), { recoveryCode: old[0]! })).statusCode).toBe(
      401,
    );
    expect((await complete(await challenge(a.email), { recoveryCode: fresh[0]! })).statusCode).toBe(
      200,
    );
  });

  it('fails closed without an encryption key', async () => {
    const a = await account();
    const status = await call(
      { method: 'GET', url: '/v1/auth/mfa', headers: auth(a.token) },
      () => noKeyApp,
    );
    expect(status.json().available).toBe(false);
    const setup = await post(
      '/v1/auth/mfa/setup',
      a.token,
      { currentPassword: PASSWORD },
      () => noKeyApp,
    );
    expect(setup.statusCode).toBe(503);
  });
});
