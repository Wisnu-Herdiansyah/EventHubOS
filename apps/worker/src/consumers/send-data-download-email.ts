import { z } from 'zod';
import type { EmailSender } from '@eventhub/kernel';
import type { EventConsumer } from './consumer.ts';

export const DATA_DOWNLOADED = 'organization.data_downloaded';

const payload = z.object({
  organizationId: z.uuid(),
  what: z.enum(['attendee_list', 'audit_log']),
  count: z.number().int().min(0),
  truncated: z.boolean(),
  eventId: z.uuid().nullable(),
  eventName: z.string().nullable(),
});

/**
 * Data download alert (ADR-0049): tells the organization's other Owners and Admins when someone
 * downloads the attendee list or the audit log, so a bulk copy is never quiet. Says who, what and
 * how many rows; never attendee details. Each person can turn it off in Settings; the database
 * function applies that choice, the roles, and leaves out the person who downloaded.
 */
export function sendDataDownloadEmailConsumer(
  sender: EmailSender,
  options: { appBaseUrl: string },
): EventConsumer {
  return {
    name: 'organization.send_data_download_email',
    eventTypes: [DATA_DOWNLOADED],
    async handle(event, client) {
      const p = payload.parse(event.payload);
      if (!event.organizationId || event.organizationId !== p.organizationId) return;
      const actorId = event.actor.type === 'user' ? event.actor.id : null;
      const { rows } = await client.query<{
        out_user_id: string;
        out_email: string;
        out_display_name: string;
      }>(
        'SELECT out_user_id, out_email, out_display_name FROM eventhub.organization_notice_recipients($1, $2, $3)',
        [p.organizationId, 'data_download', actorId],
      );
      if (rows.length === 0) return;
      let who = 'Someone';
      if (actorId) {
        const actor = await client.query<{ out_email: string }>(
          'SELECT out_email FROM eventhub.auth_notification_email($1)',
          [actorId],
        );
        who = actor.rows[0]?.out_email ?? 'A former member';
      }
      const org = rows[0]!.out_display_name;
      const thing =
        p.what === 'audit_log'
          ? 'the audit log'
          : `the attendee list of ${p.eventName ?? 'an event'}`;
      const rowsLine = `${p.count.toLocaleString('en')} ${p.count === 1 ? 'row' : 'rows'}${
        p.truncated ? ' (the most one file holds; more matched)' : ''
      }`;
      const settings = `${options.appBaseUrl}/orgs/${p.organizationId}/settings#notifications-heading`;
      for (const r of rows) {
        await sender.send({
          messageId: `${event.eventId}-${r.out_user_id}`,
          to: r.out_email,
          template: 'organization_data_downloaded',
          subject: `${org}: ${who} downloaded ${thing}`,
          text: [
            `${who} downloaded ${thing} from ${org}.`,
            `When: ${event.occurredAt.toUTCString()}`,
            `Size: ${rowsLine}`,
            '',
            'If you did not expect this, check with them and review the audit log:',
            `${options.appBaseUrl}/orgs/${p.organizationId}/audit`,
            '',
            'You receive this because you are an Owner or Admin of this organization.',
            `Turn these emails off: ${settings}`,
          ].join('\n'),
        });
      }
    },
  };
}
