import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { InMemoryEmailSender } from '@eventhub/kernel';
import { createTestPools } from '@eventhub/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../apps/api/src/adapters/argon2id-password-hasher.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { DatabaseSessionAuthenticator } from '../../apps/api/src/modules/identity/authenticator.ts';
import { sendInvitationEmailConsumer } from '../../apps/worker/src/consumers/send-invitation-email.ts';
import { sendVerificationEmailConsumer } from '../../apps/worker/src/consumers/send-verification-email.ts';
import { OutboxDispatchPublisher } from '../../apps/worker/src/outbox-dispatch-publisher.ts';
import { relayOnce } from '../../apps/worker/src/outbox-relay.ts';

const SECRET = 'test-token-secret-0123456789abcdef'; // pragma: allowlist secret

/** Owner invites a teammate who has no account yet; the teammate joins from the emailed link. */
describe('team invitation journey end to end', () => {
  const pools = createTestPools();
  const inbox = new InMemoryEmailSender();
  const publisher = new OutboxDispatchPublisher(pools.worker, [
    sendVerificationEmailConsumer(inbox, {
      appBaseUrl: 'https://app.example.test',
      ttlSeconds: 86_400,
      tokenSecret: SECRET,
    }),
    sendInvitationEmailConsumer(inbox, {
      appBaseUrl: 'https://app.example.test',
      tokenSecret: SECRET,
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

  const drainUntil = async (predicate: () => boolean) => {
    for (let i = 0; i < 30 && !predicate(); i++)
      await relayOnce(pools.worker, publisher, { batchSize: 100, maxAttempts: 5 });
  };
  const linkToken = (to: string, template: string) => {
    const m = inbox.sent.filter((x) => x.to === to && x.template === template).at(-1)!;
    return /#token=([A-Za-z0-9_-]{43})$/m.exec(m.text)![1]!;
  };
  async function signUpVerifyLogin(email: string, password: string): Promise<string> {
    await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email, password } });
    await drainUntil(() => inbox.sent.some((m) => m.to === email && m.template === 'verify_email'));
    await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: linkToken(email, 'verify_email') },
    });
    return (
      await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } })
    ).json().token as string;
  }

  it('owner invites → email → invitee signs up, verifies, accepts → member with the invited role', async () => {
    const ownerEmail = `owner-${randomUUID()}@example.test`;
    const ownerToken = await signUpVerifyLogin(ownerEmail, 'Owner password 2027!');
    const org = (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { authorization: `Bearer ${ownerToken}`, 'idempotency-key': `k-${randomUUID()}` },
        payload: {
          displayName: 'Systematic Elegance Events',
          locale: 'id-ID',
          timezone: 'Asia/Jakarta',
        },
      })
    ).json();

    const teammate = `teammate-${randomUUID()}@example.test`;
    const inv = await app.inject({
      method: 'POST',
      url: `/v1/organizations/${org.id}/invitations`,
      headers: { authorization: `Bearer ${ownerToken}`, 'idempotency-key': `k-${randomUUID()}` },
      payload: { email: teammate, role: 'registration_manager' },
    });
    expect(inv.statusCode).toBe(201);

    await drainUntil(() =>
      inbox.sent.some((m) => m.to === teammate && m.template === 'organization_invitation'),
    );
    const invitationToken = linkToken(teammate, 'organization_invitation');

    const teammateToken = await signUpVerifyLogin(teammate, 'Teammate password 2027!');
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      headers: { authorization: `Bearer ${teammateToken}` },
      payload: { token: invitationToken },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ organizationId: org.id, role: 'registration_manager' });

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/me/organizations',
      headers: { authorization: `Bearer ${teammateToken}` },
    });
    expect(mine.json().data).toEqual([
      {
        organizationId: org.id,
        displayName: 'Systematic Elegance Events',
        role: 'registration_manager',
      },
    ]);
  });
});
