import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WebhookRejected } from '../ports.ts';
import {
  InvalidPaymentRequest,
  type CheckoutRequest,
  type PaymentGateway,
  type PaymentOutcome,
} from '../payments.ts';

export interface PaymentGatewayHarness {
  gateway: PaymentGateway;
  /** A seller account in the provider's test mode, able to take payments. */
  sellerAccountId: string;
  /** The webhook the provider sends for this checkout's outcome, signed as it would at `sentAt`. */
  webhookFor(
    reference: string,
    outcome: PaymentOutcome | 'other',
    sentAt: Date,
  ): Promise<{ body: string; headers: Record<string, string> }>;
  /** The same body signed with a different secret. */
  forge(body: string, sentAt: Date): Record<string, string>;
}

/**
 * Shared contract every PaymentGateway adapter must pass (ADR-0070): the in-memory fake here,
 * the provider adapter against the provider's test mode before it is used.
 */
export function paymentGatewayContract(
  name: string,
  makeHarness: () => Promise<PaymentGatewayHarness>,
): void {
  describe(`PaymentGateway contract: ${name}`, () => {
    const now = new Date('2027-03-01T09:00:00Z');
    const request = (h: PaymentGatewayHarness, over: Partial<CheckoutRequest> = {}) =>
      ({
        reference: `order-${randomUUID()}`,
        sellerAccountId: h.sellerAccountId,
        amount: 150_000,
        platformFee: 7_500,
        description: 'Jakarta Summit 2027: 1 ticket',
        payerEmail: 'buyer@example.test',
        successUrl: 'https://site.example.test/paid',
        failureUrl: 'https://site.example.test/not-paid',
        expiresAt: new Date(now.getTime() + 30 * 60_000),
        ...over,
      }) satisfies CheckoutRequest;
    const rejection = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        if (error instanceof WebhookRejected) return error.reason;
        throw error;
      }
      throw new Error('expected a rejection');
    };

    it('has a stable adapter name', async () => {
      expect((await makeHarness()).gateway.name).toMatch(/^[a-z][a-z0-9_]*$/);
    });

    it('opens a checkout with an https payment page', async () => {
      const h = await makeHarness();
      const c = await h.gateway.createCheckout(request(h));
      expect(c.providerCheckoutId).toMatch(/\S/);
      expect(new URL(c.paymentUrl).protocol).toBe('https:');
    });

    it('returns the same checkout for the same reference, and refuses a changed one', async () => {
      const h = await makeHarness();
      const r = request(h);
      const a = await h.gateway.createCheckout(r);
      const b = await h.gateway.createCheckout(r);
      expect(b.providerCheckoutId).toBe(a.providerCheckoutId);
      await expect(h.gateway.createCheckout({ ...r, amount: r.amount + 1 })).rejects.toThrow(
        InvalidPaymentRequest,
      );
    });

    it('refuses requests that are wrong before reaching the provider', async () => {
      const h = await makeHarness();
      const bad: Partial<CheckoutRequest>[] = [
        { reference: 'Short' },
        { amount: 0 },
        { amount: 1.5 },
        { amount: 1_000_000_001 },
        { platformFee: -1 },
        { platformFee: 150_000 },
        { platformFee: 0.5 },
        { description: '  ' },
        { successUrl: 'http://site.example.test/paid' },
        { failureUrl: 'javascript:alert(1)' },
      ];
      for (const over of bad) {
        await expect(
          h.gateway.createCheckout(request(h, over)),
          JSON.stringify(over),
        ).rejects.toThrow(InvalidPaymentRequest);
      }
      // A fee of zero is allowed.
      await expect(h.gateway.createCheckout(request(h, { platformFee: 0 }))).resolves.toBeTruthy();
    });

    it('maps paid, expired and failed outcomes with the reference and amount', async () => {
      const h = await makeHarness();
      for (const outcome of ['paid', 'expired', 'failed'] as const) {
        const r = request(h);
        const c = await h.gateway.createCheckout(r);
        const d = await h.webhookFor(r.reference, outcome, now);
        const e = h.gateway.parseWebhook(d.body, d.headers, now);
        expect(e).toMatchObject({
          outcome,
          reference: r.reference,
          providerCheckoutId: c.providerCheckoutId,
          amount: r.amount,
        });
        expect(e!.eventId).toMatch(/\S/);
        expect(e!.occurredAt).toBeInstanceOf(Date);
      }
    });

    it('acknowledges other event types without an outcome', async () => {
      const h = await makeHarness();
      const r = request(h);
      await h.gateway.createCheckout(r);
      const d = await h.webhookFor(r.reference, 'other', now);
      expect(h.gateway.parseWebhook(d.body, d.headers, now)).toBeNull();
    });

    it('refuses forged, unsigned, stale and malformed webhooks', async () => {
      const h = await makeHarness();
      const r = request(h);
      await h.gateway.createCheckout(r);
      const d = await h.webhookFor(r.reference, 'paid', now);
      expect(rejection(() => h.gateway.parseWebhook(d.body, h.forge(d.body, now), now))).toBe(
        'signature',
      );
      expect(rejection(() => h.gateway.parseWebhook(d.body, {}, now))).toBe('signature');
      // A changed body no longer matches its signature.
      expect(
        rejection(() => h.gateway.parseWebhook(d.body.replace('150000', '1'), d.headers, now)),
      ).toBe('signature');
      const late = new Date(now.getTime() + 10 * 60_000);
      expect(rejection(() => h.gateway.parseWebhook(d.body, d.headers, late))).toBe('timestamp');
    });
  });
}
