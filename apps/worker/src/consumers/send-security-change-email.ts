import { z } from 'zod';
import type { EmailSender } from '@eventhub/kernel';
import type { EventConsumer } from './consumer.ts';

export const ORGANIZATION_SECURITY_CHANGED = 'organization.security_changed';

const payload = z.object({
  organizationId: z.uuid(),
  setting: z.literal('requireMfaForAdmins'),
  value: z.boolean(),
});

/**
 * Tells every active Owner when an organization's security settings change (ADR-0026), so a
 * misused Admin account or a takeover cannot weaken them quietly. Says who made the change and
 * where to review it; contains nothing secret.
 */
export function sendSecurityChangedEmailConsumer(
  sender: EmailSender,
  options: { appBaseUrl: string },
): EventConsumer {
  return {
    name: 'organization.send_security_changed_email',
    eventTypes: [ORGANIZATION_SECURITY_CHANGED],
    async handle(event, client) {
      const p = payload.parse(event.payload);
      // The organization comes from the event envelope; the payload must agree with it.
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
      let changedBy = 'An EventHub OS administrator';
      if (event.actor.type === 'user' && event.actor.id) {
        const actor = await client.query<{ out_email: string }>(
          'SELECT out_email FROM eventhub.auth_notification_email($1)',
          [event.actor.id],
        );
        changedBy = actor.rows[0]?.out_email ?? 'A former member';
      }
      const org = rows[0]!.out_display_name;
      const subject = p.value
        ? `${org} now requires two-step verification for Owners and Admins`
        : `${org} no longer requires two-step verification for Owners and Admins`;
      const what = p.value
        ? [
            `${changedBy} turned on "Require two-step verification for Owners and Admins" for`,
            `${org}. Owners and Admins without it can’t open the organization until they set it up.`,
          ]
        : [
            `${changedBy} turned off "Require two-step verification for Owners and Admins" for`,
            `${org}. Owners and Admins can now work in the organization with a password only.`,
          ];
      for (const r of rows) {
        await sender.send({
          // One message per recipient, stable across retries.
          messageId: `${event.eventId}-${r.out_user_id}`,
          to: r.out_email,
          template: 'organization_security_changed',
          subject,
          text: [
            ...what,
            '',
            `Review security settings: ${options.appBaseUrl}/orgs/${p.organizationId}/settings`,
            `See who did what: ${options.appBaseUrl}/orgs/${p.organizationId}/audit`,
            '',
            'You receive this because you are an Owner of this organization.',
          ].join('\n'),
        });
      }
    },
  };
}
