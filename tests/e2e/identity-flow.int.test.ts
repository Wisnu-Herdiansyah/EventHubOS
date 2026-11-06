import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { InMemoryEmailSender } from '@eventhub/kernel';
import { createTestPools } from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';
import { sendVerificationEmailConsumer } from '../../apps/worker/src/consumers/send-verification-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

/**
 * Cross-process journey: API (sign-up) -> outbox -> worker relay -> email -> API (verify, login)
 * -> tenant creation. Proves the pieces compose without any test-only shortcuts in between.
 */
describe('identity journey end to end', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendVerificationEmailConsumer(inbox, {
      appBaseUrl: 'https://app.example.test',
      ttlSeconds: 86_400,
      tokenSecret: 'test-token-secret-0123456789abcdef', // pragma: allowlist secret
    }),
  ]);
  let app: FastifyInstance;

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

  it('sign up -> email -> verify -> log in -> create organization', async () => {
    const email = `journey-${randomUUID()}@example.test`;
    const password = 'Systematic Elegance 2027'; // pragma: allowlist secret (synthetic test password)
    expect(
      (await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email, password } }))
        .statusCode,
    ).toBe(202);

    // Unverified users can sign in but cannot create a tenant yet.
    const early = (
      await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } })
    ).json();
    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { authorization: `Bearer ${early.token}`, 'idempotency-key': `k-${randomUUID()}` },
      payload: { displayName: 'Too Early', locale: 'en', timezone: 'UTC' },
    });
    expect(blocked.json().error.code).toBe('email_not_verified');

    // Drain the outbox until our verification email is delivered (other tests' events may queue too).
    for (let i = 0; i < 20 && !inbox.sent.some((m) => m.to === email); i++) {
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
    }
    const mail = inbox.sent.find((m) => m.to === email)!;
    expect(mail.subject).toContain('Verify your email');
    const token = /#token=([A-Za-z0-9_-]{43})$/m.exec(mail.text)![1]!;

    expect(
      (await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token } }))
        .statusCode,
    ).toBe(200);

    const session = (
      await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } })
    ).json();
    expect(session.emailVerified).toBe(true);
    const org = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { authorization: `Bearer ${session.token}`, 'idempotency-key': `k-${randomUUID()}` },
      payload: { displayName: 'Journey Events', locale: 'id-ID', timezone: 'Asia/Jakarta' },
    });
    expect(org.statusCode).toBe(201);
    expect(org.json().role).toBe('owner');
  });
});
