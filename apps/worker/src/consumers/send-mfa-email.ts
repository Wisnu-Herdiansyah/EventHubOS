import { z } from 'zod';
import type { EmailSender } from '@eventhub/kernel';
import type { EventConsumer } from './consumer.ts';

export const MFA_CHANGED = 'identity.mfa_changed';

const payload = z.object({
  userId: z.uuid(),
  change: z.enum([
    'enabled',
    'disabled',
    'recovery_codes_regenerated',
    'recovery_code_used',
    'passkey_added',
    'passkey_removed',
  ]),
});

const MESSAGES: Record<z.infer<typeof payload>['change'], { subject: string; lines: string[] }> = {
  enabled: {
    subject: 'Two-step verification is on for your EventHub OS account',
    lines: [
      'Two-step verification was turned on for your EventHub OS account. Signing in now needs',
      'a code from your authenticator app, and your other sessions were signed out.',
    ],
  },
  disabled: {
    subject: 'Two-step verification was turned off',
    lines: [
      'Two-step verification was turned off for your EventHub OS account. Signing in now needs',
      'only your password.',
    ],
  },
  recovery_codes_regenerated: {
    subject: 'New recovery codes were created',
    lines: [
      'New recovery codes were created for your EventHub OS account. The previous codes no',
      'longer work.',
    ],
  },
  passkey_added: {
    subject: 'A passkey was added to your EventHub OS account',
    lines: [
      'A passkey was added to your EventHub OS account. It can now be used instead of a code',
      'from your authenticator app when you sign in.',
    ],
  },
  passkey_removed: {
    subject: 'A passkey was removed from your EventHub OS account',
    lines: [
      'A passkey was removed from your EventHub OS account. It no longer works for signing in.',
    ],
  },
  recovery_code_used: {
    subject: 'A recovery code was used to sign in',
    lines: [
      'Someone signed in to your EventHub OS account with a recovery code. Each code works',
      'once; you can create new ones from your Account page.',
    ],
  },
};

/**
 * Tells the account owner about every two-step verification change (ADR-0022), so a takeover
 * does not go unnoticed. No codes or secrets are included.
 */
export function sendMfaChangedEmailConsumer(
  sender: EmailSender,
  options: { appBaseUrl: string },
): EventConsumer {
  return {
    name: 'identity.send_mfa_changed_email',
    eventTypes: [MFA_CHANGED],
    async handle(event, client) {
      const p = payload.parse(event.payload);
      const { rows } = await client.query<{ out_email: string }>(
        'SELECT out_email FROM eventhub.auth_notification_email($1)',
        [p.userId],
      );
      const to = rows[0]?.out_email;
      if (!to) return;
      const m = MESSAGES[p.change];
      await sender.send({
        messageId: event.eventId,
        to,
        template: `mfa_${p.change}`,
        subject: m.subject,
        text: [
          ...m.lines,
          '',
          'If this was you, there is nothing else to do.',
          `If it was not, reset your password now: ${options.appBaseUrl}/forgot-password`,
        ].join('\n'),
      });
    },
  };
}
