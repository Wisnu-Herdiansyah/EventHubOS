import { z } from 'zod';
import type { EmailSender } from '@eventhub/kernel';
import type { EventConsumer } from './consumer.ts';

export const TWO_STEP_REMINDER_SENT = 'membership.two_step_reminder_sent';

const payload = z.object({ membershipId: z.uuid() });

/**
 * Asks a member to turn on two-step verification (ADR-0031). Sent only while they are still an
 * active member without it, so a reminder that waited in the outbox never nags someone who has
 * already done it. Says who asked and links to the Account page; nothing secret.
 */
export function sendTwoStepReminderConsumer(
  sender: EmailSender,
  options: { appBaseUrl: string },
): EventConsumer {
  return {
    name: 'membership.send_two_step_reminder',
    eventTypes: [TWO_STEP_REMINDER_SENT],
    async handle(event, client) {
      const p = payload.parse(event.payload);
      if (!event.organizationId) return;
      const { rows } = await client.query<{
        out_email: string;
        out_display_name: string;
        out_role: string;
        out_required: boolean;
      }>('SELECT * FROM eventhub.two_step_reminder_details($1, $2)', [
        p.membershipId,
        event.organizationId,
      ]);
      const r = rows[0];
      if (!r) return;
      let asker = 'An administrator';
      if (event.actor.type === 'user' && event.actor.id) {
        const a = await client.query<{ out_email: string }>(
          'SELECT out_email FROM eventhub.auth_notification_email($1)',
          [event.actor.id],
        );
        asker = a.rows[0]?.out_email ?? asker;
      }
      const blocked = r.out_required && (r.out_role === 'owner' || r.out_role === 'admin');
      await sender.send({
        messageId: event.eventId,
        to: r.out_email,
        template: 'two_step_reminder',
        subject: `${r.out_display_name}: please turn on two-step verification`,
        text: [
          `${asker} asks you to turn on two-step verification for your EventHub OS account,`,
          `which you use with ${r.out_display_name}.`,
          '',
          blocked
            ? `${r.out_display_name} requires it for Owners and Admins: until it is on, you can't open the organization's events, team or settings.`
            : 'It protects the organization if your password is ever stolen: signing in will also need a code from your phone.',
          '',
          `Turn it on (takes a minute with an authenticator app): ${options.appBaseUrl}/account#two-step-heading`,
        ].join('\n'),
      });
    },
  };
}
