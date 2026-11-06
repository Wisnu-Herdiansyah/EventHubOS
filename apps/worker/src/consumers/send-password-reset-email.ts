import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EmailSender } from '@eventhub/kernel';
import type { EventConsumer } from './consumer.ts';
import { deriveEmailToken } from './verification-token.ts';

export const PASSWORD_RESET_REQUESTED = 'identity.password_reset_requested'; // pragma: allowlist secret (event name)
export const PASSWORD_CHANGED = 'identity.password_changed'; // pragma: allowlist secret (event name)

const resetPayload = z.object({
  userId: z.uuid(),
  credentialVersion: z.number().int().positive(),
});
const changedPayload = z.object({ userId: z.uuid() });

export interface PasswordResetEmailOptions {
  appBaseUrl: string;
  ttlSeconds: number;
  /** Secret for deterministic, retry-stable token derivation (EMAIL_TOKEN_SECRET). */
  tokenSecret: string;
}

/**
 * Sends a password reset link (ADR-0015). As with verification (ADR-0008), the token is derived
 * per event so a retry sends a byte-identical email, only its SHA-256 hash is stored, and it is
 * bound to the credential version the request saw: a stale request sends nothing.
 */
export function sendPasswordResetEmailConsumer(
  sender: EmailSender,
  options: PasswordResetEmailOptions,
): EventConsumer {
  return {
    name: 'identity.send_password_reset_email',
    eventTypes: [PASSWORD_RESET_REQUESTED],
    async handle(event, client) {
      const payload = resetPayload.parse(event.payload);
      const token = deriveEmailToken(options.tokenSecret, 'password-reset', event.eventId);
      const tokenHash = createHash('sha256').update(token).digest();
      const { rows } = await client.query<{ out_email: string }>(
        'SELECT out_email FROM eventhub.auth_issue_password_reset($1, $2, $3, $4)',
        [payload.userId, payload.credentialVersion, tokenHash, options.ttlSeconds],
      );
      const to = rows[0]?.out_email;
      // The password changed since the request: the link would be useless, so send nothing.
      if (!to) return;
      const minutes = Math.round(options.ttlSeconds / 60);
      await sender.send({
        messageId: event.eventId,
        to,
        template: 'password_reset',
        subject: 'Reset your EventHub OS password',
        text: [
          'We received a request to reset the password for your EventHub OS account.',
          '',
          'Choose a new password by opening this link:',
          `${options.appBaseUrl}/reset-password#token=${token}`,
          '',
          `The link expires in ${minutes} minutes and can be used once.`,
          'If you did not ask for this, ignore this email: your password stays the same.',
        ].join('\n'),
      });
    },
  };
}

/**
 * Tells the account owner their password changed, so a takeover does not go unnoticed. No token
 * or secret is included: the email only points to the "forgot password" page.
 */
export function sendPasswordChangedEmailConsumer(
  sender: EmailSender,
  options: { appBaseUrl: string },
): EventConsumer {
  return {
    name: 'identity.send_password_changed_email',
    eventTypes: [PASSWORD_CHANGED],
    async handle(event, client) {
      const payload = changedPayload.parse(event.payload);
      const { rows } = await client.query<{ out_email: string }>(
        'SELECT out_email FROM eventhub.auth_notification_email($1)',
        [payload.userId],
      );
      const to = rows[0]?.out_email;
      if (!to) return;
      await sender.send({
        messageId: event.eventId,
        to,
        template: 'password_changed',
        subject: 'Your EventHub OS password was changed',
        text: [
          'The password for your EventHub OS account was just changed, and your other',
          'signed-in sessions were signed out.',
          '',
          'If this was you, there is nothing else to do.',
          `If it was not, reset your password now: ${options.appBaseUrl}/forgot-password`,
        ].join('\n'),
      });
    },
  };
}
