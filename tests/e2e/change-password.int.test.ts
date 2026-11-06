import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { InMemoryEmailSender } from '@eventhub/kernel';
import { createTestPools } from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';
import {
  sendPasswordChangedEmailConsumer,
  sendPasswordResetEmailConsumer,
} from '../../apps/worker/src/consumers/send-password-reset-email.ts';
import { sendVerificationEmailConsumer } from '../../apps/worker/src/consumers/send-verification-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret
const OLD_PASSWORD = 'Systematic Elegance 2027'; // pragma: allowlist secret (synthetic)
const NEW_PASSWORD = 'Precision and grace 2028'; // pragma: allowlist secret (synthetic)

/** Changing the password while signed in (ADR-0016), on the real schema and runtime roles. */
describe('change password', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
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
    sendPasswordChangedEmailConsumer(inbox, { appBaseUrl: 'https://app.example.test' }),
  ]);
  let app: FastifyInstance;
  let ip = 0;
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.30.${Math.floor(++ip / 250)}.${ip % 250}` });
  const mails = (to: string, template: string) =>
    inbox.sent.filter((m) => m.to === to && m.template === template);
  async function drain(until: () => boolean) {
    for (let i = 0; i < 30 && !until(); i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    }
  }
  const tokenOf = (text: string) => /#token=([A-Za-z0-9_-]{43})$/m.exec(text)![1]!;

  async function account(): Promise<string> {
    const email = `change-${randomUUID()}@example.test`;
    await call({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email, password: OLD_PASSWORD },
    });
    await drain(() => mails(email, 'verify_email').length > 0);
    const token = tokenOf(mails(email, 'verify_email')[0]!.text);
    await call({ method: 'POST', url: '/v1/auth/verify-email', payload: { token } });
    return email;
  }
  const login = (email: string, password: string) =>
    call({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  const sessionFor = async (email: string, password = OLD_PASSWORD) =>
    (await login(email, password)).json().token as string;
  const me = (token: string) =>
    call({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
  const change = (token: string, currentPassword: string, newPassword: string) =>
    call({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword, newPassword },
    });

  beforeAll(async () => {
    app = await buildApp({
      pool: pools.app,
      authenticator: new DatabaseSessionAuthenticator(pools.app),
      passwordHasher: new Argon2idPasswordHasher(),
      identity: { sessionTtlSeconds: 3600, loginMaxFailures: 5, loginLockSeconds: 900 },
      logger: false,
      validateResponses: true,
    });
  });
  afterAll(async () => {
    await app.close();
    await pools.end();
  });

  it('changes the password, keeps this session and signs out the others', async () => {
    const email = await account();
    const here = await sessionFor(email);
    const elsewhere = await sessionFor(email);
    const another = await sessionFor(email);

    const res = await change(here, OLD_PASSWORD, NEW_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'password_changed', otherSessionsSignedOut: 2 });

    expect((await me(here)).statusCode).toBe(200);
    expect((await me(elsewhere)).statusCode).toBe(401);
    expect((await me(another)).statusCode).toBe(401);
    expect((await login(email, OLD_PASSWORD)).statusCode).toBe(401);
    expect((await login(email, NEW_PASSWORD)).statusCode).toBe(200);

    await drain(() => mails(email, 'password_changed').length > 0);
    expect(mails(email, 'password_changed')[0]!.text).toContain('other');

    // A repeat fails re-authentication (the current password is now the new one).
    const again = await change(here, OLD_PASSWORD, 'Another fine passphrase 7');
    expect(again.statusCode).toBe(400);
    expect(again.json().error.details.reason).toBe('bad_current_password');
  });

  it('refuses a wrong current password and counts it toward the lockout', async () => {
    const email = await account();
    const token = await sessionFor(email);
    const wrong = await change(token, 'not my password at all', NEW_PASSWORD);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.details.fields).toEqual([
      { path: 'body.currentPassword', message: 'Your current password is incorrect.' },
    ]);
    for (let i = 0; i < 3; i++) await change(token, 'not my password at all', NEW_PASSWORD);
    const fifth = await change(token, 'not my password at all', NEW_PASSWORD);
    expect(fifth.json().error.details.reason).toBe('locked');

    // Locked: even the right password is refused, here and at login, and nothing changed.
    const right = await change(token, OLD_PASSWORD, NEW_PASSWORD);
    expect(right.json().error.details.reason).toBe('locked');
    expect((await login(email, OLD_PASSWORD)).statusCode).toBe(401);
    expect((await login(email, NEW_PASSWORD)).statusCode).toBe(401);
  });

  it('applies the password policy and refuses the current password or the email', async () => {
    const email = await account();
    const token = await sessionFor(email);
    const short = await change(token, OLD_PASSWORD, 'too short');
    expect(short.json().error.details.fields[0].path).toBe('body.newPassword');
    const same = await change(token, OLD_PASSWORD, OLD_PASSWORD);
    expect(same.json().error.details.fields[0].message).toMatch(/different from your current/);
    const asEmail = await change(token, OLD_PASSWORD, email);
    expect(asEmail.json().error.details.fields[0].message).toMatch(/email address/);
    // None of these counted as failures or changed anything.
    expect((await change(token, OLD_PASSWORD, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('kills outstanding password reset links', async () => {
    const email = await account();
    await call({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email } });
    await drain(() => mails(email, 'password_reset').length > 0);
    const resetToken = tokenOf(mails(email, 'password_reset')[0]!.text);

    expect((await change(await sessionFor(email), OLD_PASSWORD, NEW_PASSWORD)).statusCode).toBe(
      200,
    );
    const stale = await call({
      method: 'POST',
      url: '/v1/auth/password-reset/complete',
      payload: { token: resetToken, password: 'Attacker chosen passphrase' }, // pragma: allowlist secret (synthetic)
    });
    expect(stale.json().error.details.reason).toBe('invalid_or_expired_token');
  });

  it('requires a session', async () => {
    const res = await call({
      method: 'POST',
      url: '/v1/auth/password/change',
      payload: { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it('keeps passwords out of the audit log and outbox', async () => {
    const email = await account();
    const token = await sessionFor(email);
    await change(token, 'not my password at all', NEW_PASSWORD);
    await change(token, OLD_PASSWORD, NEW_PASSWORD);
    const { rows } = await pools.migrator.query<{ action: string; blob: string }>(
      `SELECT a.action, a.metadata::text || coalesce(o.payload::text, '') AS blob
         FROM eventhub.audit_event a
         JOIN eventhub.app_user u ON u.id = a.target_id
         LEFT JOIN eventhub.outbox_event o ON o.aggregate_id = u.id AND o.event_type = a.action
        WHERE u.email = $1 AND a.action LIKE 'identity.password_change%'
        ORDER BY a.occurred_at`,
      [email],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'identity.password_change_failed',
      'identity.password_changed',
    ]);
    for (const r of rows) {
      expect(r.blob).not.toContain(OLD_PASSWORD);
      expect(r.blob).not.toContain(NEW_PASSWORD);
      expect(r.blob).not.toContain(email);
    }
  });

  it('gives the worker role no access to the change functions', async () => {
    await expect(
      pools.worker.query('SELECT * FROM eventhub.auth_credential_for_user(gen_random_uuid())'),
    ).rejects.toThrow(/permission denied/);
    await expect(
      pools.worker.query(
        "SELECT * FROM eventhub.auth_change_password(gen_random_uuid(), gen_random_uuid(), '$argon2id$x')",
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
