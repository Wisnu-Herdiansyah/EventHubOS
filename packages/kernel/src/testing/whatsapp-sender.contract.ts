import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidMessage, type WhatsAppSender, type WhatsAppTemplateMessage } from '../messaging.ts';

export interface WhatsAppSenderHarness {
  sender: WhatsAppSender;
  /** A test recipient registered with the provider. */
  testRecipient: string;
  /** Messages the provider accepted, most recent last. */
  delivered(): Promise<WhatsAppTemplateMessage[]>;
}

/**
 * Shared contract every WhatsAppSender adapter must pass (ADR-0072): the in-memory fake here,
 * the Meta Cloud API adapter against a test number before it is used.
 */
export function whatsAppSenderContract(
  name: string,
  makeHarness: () => Promise<WhatsAppSenderHarness>,
): void {
  describe(`WhatsAppSender contract: ${name}`, () => {
    const message = (h: WhatsAppSenderHarness, over: Partial<WhatsAppTemplateMessage> = {}) => ({
      messageId: randomUUID(),
      to: h.testRecipient,
      template: 'contract_test',
      language: 'id' as const,
      parameters: ['Ade', 'Jakarta Summit 2027'],
      ...over,
    });

    it('has a stable adapter name', async () => {
      expect((await makeHarness()).sender.name).toMatch(/^[a-z][a-z0-9_]*$/);
    });

    it('sends a template with its parameters in order', async () => {
      const h = await makeHarness();
      const m = message(h);
      const r = await h.sender.sendTemplate(m);
      expect(r.providerMessageId).toMatch(/\S/);
      expect((await h.delivered()).find((d) => d.messageId === m.messageId)).toMatchObject({
        to: m.to,
        template: m.template,
        language: 'id',
        parameters: m.parameters,
      });
    });

    it('sends a message once, however often it is sent', async () => {
      const h = await makeHarness();
      const m = message(h);
      const a = await h.sender.sendTemplate(m);
      const b = await h.sender.sendTemplate(m);
      expect(b.providerMessageId).toBe(a.providerMessageId);
      expect((await h.delivered()).filter((d) => d.messageId === m.messageId)).toHaveLength(1);
    });

    it('refuses messages that are wrong before reaching the provider', async () => {
      const h = await makeHarness();
      const bad: Partial<WhatsAppTemplateMessage>[] = [
        { messageId: ' ' },
        { to: '081234567890' },
        { to: '+0812345678' },
        { template: 'Has Spaces' },
        { language: 'fr' as never },
        { parameters: [''] },
        { parameters: ['two\nlines'] },
        { parameters: ['x'.repeat(201)] },
      ];
      for (const over of bad) {
        await expect(h.sender.sendTemplate(message(h, over)), JSON.stringify(over)).rejects.toThrow(
          InvalidMessage,
        );
      }
    });
  });
}
