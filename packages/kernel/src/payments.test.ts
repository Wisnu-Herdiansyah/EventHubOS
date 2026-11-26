import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryPaymentGateway, InvalidPaymentRequest } from './payments.ts';
import { paymentGatewayContract } from './testing/index.ts';

const KEY = `test-signing-${'x'.repeat(32)}`;

paymentGatewayContract('in_memory', async () => {
  const gateway = new InMemoryPaymentGateway(KEY);
  const account = await gateway.createSellerAccount({
    organizationId: '00000000-0000-4000-8000-000000000001',
    businessName: 'Contract Org',
    email: 'org@example.test',
  });
  return {
    gateway,
    sellerAccountId: account.providerAccountId,
    webhookFor: (reference, outcome, sentAt) =>
      Promise.resolve(gateway.webhookFor(reference, outcome, sentAt)),
    forge: (body, sentAt) => gateway.forge(body, sentAt),
  };
});

describe('InMemoryPaymentGateway', () => {
  it('refuses a short signing key', () => {
    expect(() => new InMemoryPaymentGateway('short')).toThrow('signing key too short');
  });

  it('keeps one seller account per organization', async () => {
    const g = new InMemoryPaymentGateway(KEY);
    const req = { organizationId: 'org-1', businessName: 'Org', email: 'o@example.test' };
    const a = await g.createSellerAccount(req);
    expect(a.status).toBe('active');
    expect((await g.createSellerAccount(req)).providerAccountId).toBe(a.providerAccountId);
    expect(
      (await g.createSellerAccount({ ...req, organizationId: 'org-2' })).providerAccountId,
    ).not.toBe(a.providerAccountId);
  });

  it('names the field a request got wrong', async () => {
    const g = new InMemoryPaymentGateway(KEY);
    const error = await g
      .createCheckout({
        reference: 'order-00000001',
        sellerAccountId: 'acct',
        amount: 100,
        platformFee: 100,
        description: 'Ticket',
        payerEmail: 'b@example.test',
        successUrl: 'https://s.example.test/ok',
        failureUrl: 'https://s.example.test/no',
        expiresAt: new Date(),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidPaymentRequest);
    expect((error as InvalidPaymentRequest).field).toBe('platformFee');
  });

  it('an amount of nothing is refused as the amount, not the fee', async () => {
    const g = new InMemoryPaymentGateway(KEY);
    const error = await g
      .createCheckout({
        reference: 'order-00000002',
        sellerAccountId: 'acct',
        amount: 0,
        platformFee: 0,
        description: 'Ticket',
        payerEmail: 'b@example.test',
        successUrl: 'https://s.example.test/ok',
        failureUrl: 'https://s.example.test/no',
        expiresAt: new Date(),
      })
      .catch((e: unknown) => e);
    expect((error as InvalidPaymentRequest).field).toBe('amount');
  });

  it('ignores event types it does not know, rather than reading them as an outcome', () => {
    const g = new InMemoryPaymentGateway(KEY);
    const now = new Date('2027-03-01T09:00:00Z');
    for (const type of ['refunded', 'payment.pending', 'PAID']) {
      const body = JSON.stringify({
        id: 'evt_1',
        type,
        reference: 'order-00000003',
        checkout_id: 'chk_1',
        amount: 1000,
        occurred_at: now.toISOString(),
      });
      expect(g.parseWebhook(body, signLike(KEY, body, now), now), type).toBeNull();
    }
  });

  it('refuses a correctly signed webhook whose body is not JSON, or misses fields', () => {
    const g = new InMemoryPaymentGateway(KEY);
    const now = new Date('2027-03-01T09:00:00Z');
    for (const body of ['not json', JSON.stringify({ id: 'e', type: 'paid' })]) {
      expect(() => g.parseWebhook(body, signLike(KEY, body, now), now)).toThrow('malformed');
    }
  });
});

/** Signs a body the way the in-memory gateway does, for bodies no checkout produces. */
function signLike(key: string, body: string, at: Date): Record<string, string> {
  const ts = String(Math.floor(at.getTime() / 1000));
  return {
    'x-in-memory-signature': createHmac('sha256', key).update(`${ts}.${body}`).digest('hex'),
    'x-in-memory-timestamp': ts,
  };
}
