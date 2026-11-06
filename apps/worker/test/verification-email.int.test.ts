import { createHash, randomUUID } from 'node:crypto';
import {
  createDomainEvent,
  InMemoryEmailSender,
  type DomainEvent,
  type EmailMessage,
  type EmailSender,
} from '@eventhub/kernel';
import { createTestPools } from '@eventhub/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import {
  sendVerificationEmailConsumer,
  EMAIL_VERIFICATION_REQUESTED,
} from '../src/consumers/send-verification-email.ts';
import { OutboxDispatchPublisher } from '../src/outbox-dispatch-publisher.ts';

const HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';

describe('send-verification-email consumer', () => {
  const pools = createTestPools();
  afterAll(() => pools.end());

  async function registered(): Promise<{ userId: string; email: string; version: number }> {
    const email = `v-${randomUUID()}@example.test`;
    const { rows } = await pools.app.query<{ out_user_id: string; out_credential_version: number }>(
      'SELECT out_user_id, out_credential_version FROM eventhub.auth_register($1, $2)',
      [email, HASH],
    );
    return { userId: rows[0]!.out_user_id, email, version: rows[0]!.out_credential_version };
  }

  const request = (userId: string, credentialVersion: number | null): DomainEvent =>
    createDomainEvent({
      eventType: EMAIL_VERIFICATION_REQUESTED,
      schemaVersion: 1,
      actor: { type: 'user', id: userId },
      organizationId: null,
      aggregateType: 'user',
      aggregateId: userId,
      correlationId: randomUUID(),
      payload: { userId, credentialVersion },
    });

  const setup = () => {
    const sender = new InMemoryEmailSender();
    const consumer = sendVerificationEmailConsumer(sender, {
      appBaseUrl: 'https://app.example.test',
      ttlSeconds: 86_400,
      tokenSecret: 'test-token-secret-0123456789abcdef', // pragma: allowlist secret
    });
    return { sender, publisher: new OutboxDispatchPublisher(pools.worker, [consumer]) };
  };

  it('sends one email with a fragment link and stores only the token hash', async () => {
    const { userId, email, version } = await registered();
    const { sender, publisher } = setup();
    await publisher.publish(request(userId, version));
    expect(sender.sent).toHaveLength(1);
    const m = sender.sent[0]!;
    expect(m.to).toBe(email);
    const token = /#token=([A-Za-z0-9_-]{43})$/m.exec(m.text)?.[1];
    expect(token).toBeDefined();
    const { rows } = await pools.migrator.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM eventhub.email_verification_token WHERE user_id = $1',
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash.toString('base64url')).not.toBe(token);
  });

  it('delivers at most once per event even when the broker re-delivers', async () => {
    const { userId, version } = await registered();
    const { sender, publisher } = setup();
    const event = request(userId, version);
    await publisher.publish(event);
    await publisher.publish(event);
    expect(sender.sent).toHaveLength(1);
  });

  it('sends nothing for a superseded credential or an already verified account', async () => {
    const { userId, email } = await registered();
    await pools.app.query('SELECT * FROM eventhub.auth_register($1, $2)', [email, HASH]); // version 2
    const { sender, publisher } = setup();
    await publisher.publish(request(userId, 1));
    expect(sender.sent).toHaveLength(0);

    const other = await registered();
    await pools.migrator.query(
      'UPDATE eventhub.app_user SET email_verified_at = now() WHERE id = $1',
      [other.userId],
    );
    await publisher.publish(request(other.userId, other.version));
    expect(sender.sent).toHaveLength(0);
  });

  it('rolls back the token and ledger when sending fails, so a retry sends exactly one email', async () => {
    const { userId, version } = await registered();
    const { sender, publisher } = setup();
    const event = request(userId, version);
    sender.failNext(1);
    await expect(publisher.publish(event)).rejects.toThrow('simulated outage');
    const before = await pools.migrator.query(
      'SELECT count(*)::int AS n FROM eventhub.email_verification_token WHERE user_id = $1',
      [userId],
    );
    expect(before.rows[0].n).toBe(0);
    await publisher.publish(event);
    expect(sender.sent).toHaveLength(1);
  });

  it('provider accepted but our transaction rolled back: the retry is deduplicated and the delivered link works', async () => {
    const { userId, version } = await registered();
    // Behaves like Resend: dedupes on messageId, rejects a reused key with a different payload,
    // and here also "times out" after accepting the first request.
    const accepted = new Map<string, string>();
    let deliveredToUser: EmailMessage | null = null;
    let timeoutAfterAccept = true;
    const provider: EmailSender = {
      name: 'fake_provider',
      send(m) {
        const payload = JSON.stringify(m);
        const prior = accepted.get(m.messageId);
        if (prior !== undefined && prior !== payload) {
          return Promise.reject(new Error('invalid_idempotent_request'));
        }
        if (prior === undefined) {
          accepted.set(m.messageId, payload);
          deliveredToUser = m;
        }
        if (timeoutAfterAccept) {
          timeoutAfterAccept = false;
          return Promise.reject(new Error('timeout'));
        }
        return Promise.resolve();
      },
    };
    const publisher = new OutboxDispatchPublisher(pools.worker, [
      sendVerificationEmailConsumer(provider, {
        appBaseUrl: 'https://app.example.test',
        ttlSeconds: 86_400,
        tokenSecret: 'test-token-secret-0123456789abcdef', // pragma: allowlist secret
      }),
    ]);
    const event = request(userId, version);

    await expect(publisher.publish(event)).rejects.toThrow('timeout'); // rolled back
    await publisher.publish(event); // outbox retry: identical payload, deduplicated by provider

    expect(accepted.size).toBe(1); // exactly one email reached the user
    const token = /#token=([A-Za-z0-9_-]{43})$/m.exec(deliveredToUser!.text)![1]!;
    const { rows } = await pools.app.query<{ out_user_id: string }>(
      'SELECT out_user_id FROM eventhub.auth_consume_verification($1)',
      [createHash('sha256').update(token).digest()],
    );
    expect(rows[0]?.out_user_id).toBe(userId); // the link the user actually received is valid
  });
});
