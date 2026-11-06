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

/**
 * Password reset (ADR-0015) across API -> outbox -> worker -> email -> API, on the real schema
 * with the least-privilege runtime roles.
 */
describe('password reset', () => {
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
  // Each call comes from its own address so the per-IP auth limit does not interfere.
  const call = (opts: InjectOptions) =>
    app.inject({ ...opts, remoteAddress: `10.20.${Math.floor(++ip / 250)}.${ip % 250}` });

  const mails = (to: string, template: string) =>
    inbox.sent.filter((m) => m.to === to && m.template === template);
  async function drain(until: () => boolean) {
    for (let i = 0; i < 30 && !until(); i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    }
  }
  const tokenOf = (text: string) => /#token=([A-Za-z0-9_-]{43})$/m.exec(text)![1]!;

  async function account(opts: { verify?: boolean } = {}): Promise<string> {
    const email = `reset-${randomUUID()}@example.test`;
    await call({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email, password: OLD_PASSWORD },
    });
    if (opts.verify !== false) {
      await drain(() => mails(email, 'verify_email').length > 0);
      const token = tokenOf(mails(email, 'verify_email')[0]!.text);
      await call({ method: 'POST', url: '/v1/auth/verify-email', payload: { token } });
    }
    return email;
  }
  const login = (email: string, password: string) =>
    call({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  const requestReset = (email: string) =>
    call({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email } });
  const complete = (token: string, password: string) =>
    call({ method: 'POST', url: '/v1/auth/password-reset/complete', payload: { token, password } });
  async function resetLink(email: string, nth = 1): Promise<string> {
    await drain(() => mails(email, 'password_reset').length >= nth);
    const mail = mails(email, 'password_reset')[nth - 1];
    expect(mail, `reset email #${nth} for ${email}`).toBeDefined();
    return tokenOf(mail!.text);
  }

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

  it('resets the password, signs out every session and notifies the owner', async () => {
    const email = await account();
    const session = (await login(email, OLD_PASSWORD)).json();
    const me = () =>
      call({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${session.token}` } });
    expect((await me()).statusCode).toBe(200);

    const res = await requestReset(email);
    expect(res.statusCode).toBe(202);
    const token = await resetLink(email);
    const mail = mails(email, 'password_reset')[0]!;
    expect(mail.subject).toBe('Reset your EventHub OS password');
    expect(mail.text).toContain(`https://app.example.test/reset-password#token=${token}`);

    const done = await complete(token, NEW_PASSWORD);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ status: 'password_reset' });

    expect((await me()).statusCode).toBe(401); // every session revoked
    expect((await login(email, OLD_PASSWORD)).statusCode).toBe(401);
    expect((await login(email, NEW_PASSWORD)).statusCode).toBe(200);

    await drain(() => mails(email, 'password_changed').length > 0);
    const notice = mails(email, 'password_changed')[0]!;
    expect(notice.text).toContain('https://app.example.test/forgot-password');
    expect(notice.text).not.toMatch(/token=/);

    // Single use.
    const again = await complete(token, 'Another fine passphrase 1');
    expect(again.statusCode).toBe(400);
    expect(again.json().error.details.reason).toBe('invalid_or_expired_token');
  });

  it('answers the same for unknown addresses and sends nothing', async () => {
    const known = await account();
    const unknown = `nobody-${randomUUID()}@example.test`;
    const a = await requestReset(known);
    const b = await requestReset(unknown);
    expect(b.statusCode).toBe(a.statusCode);
    expect(b.json()).toEqual(a.json());
    await resetLink(known);
    expect(inbox.sent.some((m) => m.to === unknown)).toBe(false);
  });

  it('caps reset emails per account, whatever the client address', async () => {
    const email = await account();
    for (let i = 0; i < 5; i++) expect((await requestReset(email)).statusCode).toBe(202);
    await drain(() => mails(email, 'password_reset').length >= 3);
    await drain(() => false); // let anything else queued go out
    expect(mails(email, 'password_reset')).toHaveLength(3);

    const { rows } = await pools.migrator.query<{ metadata: { outcome: string } }>(
      `SELECT a.metadata FROM eventhub.audit_event a JOIN eventhub.app_user u ON u.id = a.target_id
        WHERE u.email = $1 AND a.action = 'identity.password_reset_requested' ORDER BY a.occurred_at`,
      [email],
    );
    expect(rows.map((r) => r.metadata.outcome)).toEqual([
      'sent',
      'sent',
      'sent',
      'throttled',
      'throttled',
    ]);
  });

  it('a reset kills every other outstanding reset link (bound to the credential version)', async () => {
    const email = await account();
    await requestReset(email);
    const first = await resetLink(email, 1);
    await requestReset(email);
    const second = await resetLink(email, 2);
    expect((await complete(second, NEW_PASSWORD)).statusCode).toBe(200);
    const stale = await complete(first, 'Yet another passphrase 9');
    expect(stale.statusCode).toBe(400);
    expect((await login(email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('enforces the password policy without using up the link', async () => {
    const email = await account();
    await requestReset(email);
    const token = await resetLink(email);

    const short = await complete(token, 'too short');
    expect(short.statusCode).toBe(400);
    expect(short.json().error.details.fields[0].path).toBe('body.password');

    const sameAsEmail = await complete(token, email.toUpperCase());
    expect(sameAsEmail.statusCode).toBe(400);
    expect(sameAsEmail.json().error.details.fields[0].message).toMatch(/email address/);

    expect((await complete(token, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('rejects expired links', async () => {
    const email = await account();
    await requestReset(email);
    const token = await resetLink(email);
    await pools.migrator.query(
      `UPDATE eventhub.password_reset_token t SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'
         FROM eventhub.app_user u WHERE u.id = t.user_id AND u.email = $1`,
      [email],
    );
    expect((await complete(token, NEW_PASSWORD)).json().error.details.reason).toBe(
      'invalid_or_expired_token',
    );
  });

  it('unlocks a locked account and verifies an unverified one', async () => {
    const email = await account({ verify: false });
    for (let i = 0; i < 6; i++) await login(email, 'wrong password attempt');
    expect((await login(email, OLD_PASSWORD)).statusCode).toBe(401); // locked

    await requestReset(email);
    expect((await complete(await resetLink(email), NEW_PASSWORD)).statusCode).toBe(200);
    const session = await login(email, NEW_PASSWORD);
    expect(session.statusCode).toBe(200);
    expect(session.json().emailVerified).toBe(true);
  });

  it('a stale request (password changed since) sends no email', async () => {
    const email = await account();
    await requestReset(email);
    // Change the credential version before the worker runs, as a completed reset would.
    await pools.migrator.query(
      `UPDATE eventhub.user_credential c SET credential_version = credential_version + 1
         FROM eventhub.app_user u WHERE u.id = c.user_id AND u.email = $1`,
      [email],
    );
    await drain(() => false);
    expect(mails(email, 'password_reset')).toHaveLength(0);
  });

  it('keeps addresses and secrets out of the audit log and outbox', async () => {
    const email = await account();
    await requestReset(email);
    await complete(await resetLink(email), NEW_PASSWORD);
    const { rows } = await pools.migrator.query<{ blob: string }>(
      `SELECT a.metadata::text || coalesce(o.payload::text, '') AS blob
         FROM eventhub.audit_event a
         JOIN eventhub.app_user u ON u.id = a.target_id
         LEFT JOIN eventhub.outbox_event o ON o.aggregate_id = u.id
        WHERE u.email = $1 AND a.action LIKE 'identity.password_%'`,
      [email],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.blob).not.toContain(email);
      expect(r.blob).not.toContain(NEW_PASSWORD);
      expect(r.blob).not.toMatch(/token/i);
    }
  });

  it('gives the runtime roles no direct access to reset tokens', async () => {
    await expect(pools.app.query('SELECT * FROM eventhub.password_reset_token')).rejects.toThrow(
      /permission denied/,
    );
    await expect(pools.worker.query('SELECT * FROM eventhub.password_reset_token')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      pools.worker.query(
        "SELECT * FROM eventhub.auth_complete_password_reset('\\x00'::bytea, '$argon2id$x')",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      pools.app.query(
        "SELECT * FROM eventhub.auth_issue_password_reset(gen_random_uuid(), 1, '\\x00'::bytea, 60)",
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
