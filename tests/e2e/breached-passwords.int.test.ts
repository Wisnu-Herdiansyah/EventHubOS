import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { InMemoryBreachedPasswordChecker, InMemoryEmailSender } from '@eventhub/kernel';
import { createTestPools } from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';
import { BREACHED_PASSWORD_MESSAGE } from '../../apps/api/src/modules/identity/routes.ts';
import { sendPasswordResetEmailConsumer } from '../../apps/worker/src/consumers/send-password-reset-email.ts';
import { sendVerificationEmailConsumer } from '../../apps/worker/src/consumers/send-verification-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret
const GOOD = 'Systematic Elegance 2027'; // pragma: allowlist secret (synthetic)
const OTHER_GOOD = 'Precision and grace 2028'; // pragma: allowlist secret (synthetic)
const BREACHED = 'password1234'; // pragma: allowlist secret (well-known breached example)

/** Breached-password screening (ADR-0078) on sign-up, reset and change, on the real schema. */
describe('breached passwords', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const checker = new InMemoryBreachedPasswordChecker();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendVerificationEmailConsumer(inbox, {
      appBaseUrl: 'https://app.example.test',
      ttlSeconds: 86_400,
      tokenSecret: SECRET,
    }),
    sendPasswordResetEmailConsumer(inbox, {
      appBaseUrl: 'https://app.example.test',
      ttlSeconds: 3_600,
      tokenSecret: SECRET,
    }),
  ]);
  let app: FastifyInstance;
  let lengthOnly: FastifyInstance;
  let ip = 0;
  const on = (a: () => FastifyInstance) => (opts: InjectOptions) =>
    a().inject({ ...opts, remoteAddress: `10.78.${Math.floor(++ip / 250)}.${ip % 250}` });
  const call = on(() => app);
  const mails = (to: string, template: string) =>
    inbox.sent.filter((m) => m.to === to && m.template === template);
  async function drain(until: () => boolean) {
    for (let i = 0; i < 30 && !until(); i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    }
  }
  const tokenOf = (text: string) => /#token=([A-Za-z0-9_-]{43})$/m.exec(text)![1]!;
  const signup = (email: string, password: string, via = call) =>
    via({ method: 'POST', url: '/v1/auth/signup', payload: { email, password } });
  const login = (email: string, password: string) =>
    call({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  const fieldsOf = (res: { json: () => unknown }) =>
    (res.json() as { error: { details: { fields: { path: string; message: string }[] } } }).error
      .details.fields;
  const users = async (email: string) =>
    (await pools.migrator.query('SELECT 1 FROM eventhub.app_user WHERE lower(email) = $1', [email]))
      .rowCount;

  async function account(): Promise<string> {
    const email = `breach-${randomUUID()}@example.test`;
    expect((await signup(email, GOOD)).statusCode).toBe(202);
    await drain(() => mails(email, 'verify_email').length > 0);
    const token = tokenOf(mails(email, 'verify_email')[0]!.text);
    await call({ method: 'POST', url: '/v1/auth/verify-email', payload: { token } });
    return email;
  }

  beforeAll(async () => {
    const deps = {
      pool: pools.app,
      authenticator: new DatabaseSessionAuthenticator(pools.app),
      passwordHasher: new Argon2idPasswordHasher(),
      logger: false as const,
      validateResponses: true,
    };
    const identity = { sessionTtlSeconds: 3600, loginMaxFailures: 5, loginLockSeconds: 900 };
    app = await buildApp({ ...deps, identity: { ...identity, breachedPasswords: checker } });
    lengthOnly = await buildApp({ ...deps, identity });
  });
  afterAll(async () => {
    await app.close();
    await lengthOnly.close();
    await pools.end();
  });

  it('sign-up refuses a breached password, creates nothing and sends nothing', async () => {
    const email = `breach-${randomUUID()}@example.test`;
    const res = await signup(email, BREACHED);
    expect(res.statusCode).toBe(400);
    expect(fieldsOf(res)).toEqual([{ path: 'body.password', message: BREACHED_PASSWORD_MESSAGE }]);
    expect(await users(email)).toBe(0);
    await drain(() => false);
    expect(mails(email, 'verify_email')).toHaveLength(0);
    // The same address with a good password is fine.
    expect((await signup(email, GOOD)).statusCode).toBe(202);
    expect(await users(email)).toBe(1);
  });

  it('the answer depends on the password only: a registered address gets the same refusal', async () => {
    const email = await account();
    const res = await signup(email, BREACHED);
    expect(res.statusCode).toBe(400);
    expect(fieldsOf(res)).toEqual([{ path: 'body.password', message: BREACHED_PASSWORD_MESSAGE }]);
    // And the length rule still runs first, before any outside check.
    expect((await signup(email, 'short')).statusCode).toBe(400);
  });

  it('a reset refuses a breached password and leaves the link working', async () => {
    const email = await account();
    await call({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email } });
    await drain(() => mails(email, 'password_reset').length > 0);
    const token = tokenOf(mails(email, 'password_reset')[0]!.text);
    const complete = (password: string) =>
      call({
        method: 'POST',
        url: '/v1/auth/password-reset/complete',
        payload: { token, password },
      });
    const refused = await complete(BREACHED);
    expect(refused.statusCode).toBe(400);
    expect(fieldsOf(refused)).toEqual([
      { path: 'body.password', message: BREACHED_PASSWORD_MESSAGE },
    ]);
    expect((await login(email, GOOD)).statusCode).toBe(200);
    expect((await complete(OTHER_GOOD)).statusCode).toBe(200);
    expect((await login(email, OTHER_GOOD)).statusCode).toBe(200);
  });

  it('a change refuses a breached new password; a wrong current password is said first', async () => {
    const email = await account();
    const token = (await login(email, GOOD)).json<{ token: string }>().token;
    const change = (currentPassword: string, newPassword: string) =>
      call({
        method: 'POST',
        url: '/v1/auth/password/change',
        headers: { authorization: `Bearer ${token}` },
        payload: { currentPassword, newPassword },
      });
    const refused = await change(GOOD, BREACHED);
    expect(refused.statusCode).toBe(400);
    expect(fieldsOf(refused)).toEqual([
      { path: 'body.newPassword', message: BREACHED_PASSWORD_MESSAGE },
    ]);
    expect((await login(email, GOOD)).statusCode).toBe(200);
    // Someone without the current password learns nothing about the new one.
    const wrong = await change('Not the password at all', BREACHED);
    expect(fieldsOf(wrong).map((f) => f.path)).toEqual(['body.currentPassword']);
    expect((await change(GOOD, OTHER_GOOD)).statusCode).toBe(200);
  });

  it('when the source cannot be asked, the password is accepted on length alone', async () => {
    checker.setUnavailable(true);
    try {
      const email = `breach-${randomUUID()}@example.test`;
      expect((await signup(email, BREACHED)).statusCode).toBe(202);
      expect(await users(email)).toBe(1);
    } finally {
      checker.setUnavailable(false);
    }
  });

  it('without a checker (screening off), only the length rule applies', async () => {
    const email = `breach-${randomUUID()}@example.test`;
    expect(
      (
        await signup(
          email,
          BREACHED,
          on(() => lengthOnly),
        )
      ).statusCode,
    ).toBe(202);
  });
});
