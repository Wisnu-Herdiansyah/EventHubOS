import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EmailSender } from '@eventhub/kernel';
import type { EventConsumer } from './consumer.ts';
import { deriveVerificationToken } from './verification-token.ts';

export const EMAIL_VERIFICATION_REQUESTED = 'identity.email_verification_requested';

const payloadSchema = z.object({
  userId: z.uuid(),
  credentialVersion: z.number().int().positive().nullable(),
});

export interface VerificationEmailOptions {
  appBaseUrl: string;
  ttlSeconds: number;
  /** Secret for deterministic, retry-stable token derivation (EMAIL_TOKEN_SECRET). */
  tokenSecret: string;
}

/**
 * Derives the single-use verification token at send time (so it never exists in the outbox or
 * the database in raw form), stores only its SHA-256 hash, and emails the link. The token travels in
 * the URL fragment, which browsers do not send to servers or in Referer headers.
 */
export function sendVerificationEmailConsumer(
  sender: EmailSender,
  options: VerificationEmailOptions,
): EventConsumer {
  return {
    name: 'identity.send_verification_email',
    eventTypes: [EMAIL_VERIFICATION_REQUESTED],
    async handle(event, client) {
      const payload = payloadSchema.parse(event.payload);
      const token = deriveVerificationToken(options.tokenSecret, event.eventId);
      const tokenHash = createHash('sha256').update(token).digest();
      const { rows } = await client.query<{ out_email: string }>(
        'SELECT out_email FROM eventhub.auth_issue_verification($1, $2, $3, $4)',
        [payload.userId, payload.credentialVersion, tokenHash, options.ttlSeconds],
      );
      const to = rows[0]?.out_email;
      // Already verified, or superseded by a newer credential: nothing to send.
      if (!to) return;
      const hours = Math.round(options.ttlSeconds / 3600);
      await sender.send({
        messageId: event.eventId,
        to,
        template: 'verify_email',
        subject: 'Verify your email address for EventHub OS',
        text: [
          'Welcome to EventHub OS.',
          '',
          'Confirm your email address by opening this link:',
          `${options.appBaseUrl}/verify-email#token=${token}`,
          '',
          `The link expires in ${hours} hour${hours === 1 ? '' : 's'} and can be used once.`,
          'If you did not create an account, you can ignore this email.',
        ].join('\n'),
      });
    },
  };
}
