import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ResendEmailSender } from '../src/adapters/resend-email-sender.ts';

/**
 * Live contract against the real Resend API (`pnpm test:live`). Requires:
 *   RESEND_API_KEY        a sending key for a test project
 *   RESEND_CONTRACT_FROM  a sender on a domain verified in that project
 *   RESEND_CONTRACT_TO    a recipient you control (or a provider test address)
 */
const apiKey = process.env.RESEND_API_KEY;
const from = process.env.RESEND_CONTRACT_FROM;
const to = process.env.RESEND_CONTRACT_TO;
const configured = Boolean(apiKey && from && to);

describe.skipIf(!configured)('Resend live contract', () => {
  const sender = () =>
    new ResendEmailSender({
      apiKey: apiKey!,
      from: from!,
      baseUrl: process.env.RESEND_BASE_URL ?? 'https://api.resend.com',
      timeoutMs: 15_000,
    });

  it('accepts a message and deduplicates a retry with the same idempotency key', async () => {
    const message = {
      messageId: randomUUID(),
      to: to!,
      template: 'contract_test',
      subject: `EventHub OS contract test ${new Date().toISOString()}`,
      text: 'Automated contract test. Safe to ignore.',
    };
    await sender().send(message);
    await sender().send(message); // must not throw: identical retry under the same key
  });

  it('classifies an invalid key as a non-retryable error', async () => {
    const bad = new ResendEmailSender({
      apiKey: 're_invalid_key_for_contract_test', // pragma: allowlist secret
      from: from!,
      baseUrl: process.env.RESEND_BASE_URL ?? 'https://api.resend.com',
      timeoutMs: 15_000,
    });
    await expect(
      bad.send({
        messageId: randomUUID(),
        to: to!,
        template: 'contract_test',
        subject: 's',
        text: 't',
      }),
    ).rejects.toMatchObject({ retryable: false });
  });
});
