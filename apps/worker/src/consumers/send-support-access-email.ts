import { z } from 'zod';
import type { EmailSender } from '@eventhub/kernel';
import type { EventConsumer } from './consumer.ts';

export const SUPPORT_ACCESS_CHANGED = 'organization.support_access_changed';

const payload = z.object({
  organizationId: z.uuid(),
  granted: z.boolean(),
  expiresAt: z.iso.datetime(),
});

/**
 * Tells every active Owner when support access to their organization is granted or revoked
 * (ADR-0045), naming who did it and until when, so nobody can open the organization to EventHub
 * staff quietly. Contains nothing secret.
 */
export function sendSupportAccessEmailConsumer(
  sender: EmailSender,
  options: { appBaseUrl: string },
): EventConsumer {
  return {
    name: 'organization.send_support_access_email',
    eventTypes: [SUPPORT_ACCESS_CHANGED],
    async handle(event, client) {
      const p = payload.parse(event.payload);
      if (!event.organizationId || event.organizationId !== p.organizationId) return;
      const { rows } = await client.query<{
        out_user_id: string;
        out_email: string;
        out_display_name: string;
      }>(
        'SELECT out_user_id, out_email, out_display_name FROM eventhub.organization_security_contacts($1)',
        [p.organizationId],
      );
      if (rows.length === 0) return;
      let who = 'An administrator';
      if (event.actor.type === 'user' && event.actor.id) {
        const actor = await client.query<{ out_email: string }>(
          'SELECT out_email FROM eventhub.auth_notification_email($1)',
          [event.actor.id],
        );
        who = actor.rows[0]?.out_email ?? 'A former member';
      }
      const org = rows[0]!.out_display_name;
      const until = new Date(p.expiresAt).toUTCString();
      const subject = p.granted
        ? `${org}: EventHub support can view your organization until ${until}`
        : `${org}: EventHub support access was turned off`;
      const what = p.granted
        ? [
            `${who} let EventHub support view ${org} until ${until}.`,
            'Support can read settings, team, events, reports and the audit log, but cannot change',
            'anything or see attendee details. Every view is in your audit log.',
          ]
        : [`${who} turned off EventHub support access to ${org}. Support can no longer view it.`];
      for (const r of rows) {
        await sender.send({
          messageId: `${event.eventId}-${r.out_user_id}`,
          to: r.out_email,
          template: 'organization_security_changed',
          subject,
          text: [
            ...what,
            '',
            `Review or turn it off: ${options.appBaseUrl}/orgs/${p.organizationId}/settings`,
            `See who did what: ${options.appBaseUrl}/orgs/${p.organizationId}/audit`,
            '',
            'You receive this because you are an Owner of this organization.',
          ].join('\n'),
        });
      }
    },
  };
}
