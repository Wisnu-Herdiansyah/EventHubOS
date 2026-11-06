import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EmailMessage, EmailSender } from '../ports.ts';

export interface EmailSenderHarness {
  sender: EmailSender;
  /** Messages observed by the provider (sandbox inbox), most recent last. */
  delivered(): Promise<EmailMessage[]>;
}

/** Shared contract every EmailSender adapter must pass (against the provider sandbox). */
export function emailSenderContract(
  name: string,
  makeHarness: () => Promise<EmailSenderHarness>,
): void {
  describe(`EmailSender contract: ${name}`, () => {
    const message = (): EmailMessage => ({
      messageId: randomUUID(),
      to: `contract-${randomUUID()}@example.test`,
      template: 'contract_test',
      subject: 'Contract test',
      text: 'Body with a link https://app.example.test/#token=abc',
    });

    it('has a stable adapter name', async () => {
      expect((await makeHarness()).sender.name).toMatch(/^[a-z][a-z0-9_]*$/);
    });

    it('delivers recipient, subject, and body intact', async () => {
      const h = await makeHarness();
      const m = message();
      await h.sender.send(m);
      expect((await h.delivered()).find((d) => d.messageId === m.messageId)).toMatchObject({
        to: m.to,
        subject: m.subject,
        text: m.text,
      });
    });
  });
}
