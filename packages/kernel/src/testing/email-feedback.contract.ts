import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WebhookRejected, type EmailFeedbackReceiver } from '../ports.ts';

export interface EmailFeedbackHarness {
  receiver: EmailFeedbackReceiver;
  /** A provider delivery of one event, signed as the provider would at `sentAt`. */
  delivery(
    event: {
      type: 'bounce' | 'complaint' | 'delivered' | 'other';
      to: string[];
      messageId: string;
    },
    sentAt: Date,
  ): { body: string; headers: Record<string, string> };
  /** The same delivery signed with a different secret. */
  forged(body: string, sentAt: Date): Record<string, string>;
}

/** Shared contract every EmailFeedbackReceiver adapter must pass. */
export function emailFeedbackContract(
  name: string,
  makeHarness: () => Promise<EmailFeedbackHarness>,
): void {
  describe(`EmailFeedbackReceiver contract: ${name}`, () => {
    const now = new Date('2027-03-01T09:00:00Z');
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
      expect((await makeHarness()).receiver.name).toMatch(/^[a-z][a-z0-9_]*$/);
    });

    it('maps bounces, complaints and deliveries, lowercasing addresses', async () => {
      const h = await makeHarness();
      for (const type of ['bounce', 'complaint', 'delivered'] as const) {
        const messageId = randomUUID();
        const d = h.delivery({ type, to: ['Ade@Example.TEST'], messageId }, now);
        const f = h.receiver.parse(d.body, d.headers, now);
        expect(f).toMatchObject({
          kind: type,
          recipients: ['ade@example.test'],
          providerMessageId: messageId,
        });
        expect(f!.eventId).toMatch(/\S/);
        expect(f!.occurredAt).toBeInstanceOf(Date);
      }
    });

    it('acknowledges other event types without feedback', async () => {
      const h = await makeHarness();
      const d = h.delivery({ type: 'other', to: ['a@example.test'], messageId: 'm' }, now);
      expect(h.receiver.parse(d.body, d.headers, now)).toBeNull();
    });

    it('rejects a forged, tampered or unsigned delivery', async () => {
      const h = await makeHarness();
      const d = h.delivery({ type: 'complaint', to: ['a@example.test'], messageId: 'm' }, now);
      expect(rejection(() => h.receiver.parse(d.body, h.forged(d.body, now), now))).toBe(
        'signature',
      );
      const tampered = d.body.replace('a@example.test', 'b@example.test');
      expect(rejection(() => h.receiver.parse(tampered, d.headers, now))).toBe('signature');
      expect(rejection(() => h.receiver.parse(d.body, {}, now))).toBe('signature');
    });

    it('rejects deliveries signed more than 5 minutes away from now (replay)', async () => {
      const h = await makeHarness();
      const old = new Date(now.getTime() - 6 * 60_000);
      const d = h.delivery({ type: 'bounce', to: ['a@example.test'], messageId: 'm' }, old);
      expect(rejection(() => h.receiver.parse(d.body, d.headers, now))).toBe('timestamp');
      const future = new Date(now.getTime() + 6 * 60_000);
      const f = h.delivery({ type: 'bounce', to: ['a@example.test'], messageId: 'm' }, future);
      expect(rejection(() => h.receiver.parse(f.body, f.headers, now))).toBe('timestamp');
    });
  });
}
