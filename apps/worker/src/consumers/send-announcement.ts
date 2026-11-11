import { z } from 'zod';
import type { EmailSender } from '@eventhub/kernel';
import type { EventConsumer } from './consumer.ts';

export const ANNOUNCEMENT_REQUESTED = 'announcement.requested';

const payload = z.object({ announcementId: z.uuid() });

export interface AnnouncementEmailOptions {
  /** {handle} template of public sites (ADR-0021), or null: no event link. */
  publicSiteUrl: string | null;
}

/**
 * Emails an announcement to its recipients (ADR-0037), one message each. Someone who cancelled
 * after it was sent is skipped, never emailed. Each recipient is marked delivered or skipped in
 * the consumer's transaction. If sending fails partway, the marks roll back with it and the retry
 * goes through the list again: the per-recipient message ID is the provider's idempotency key, so
 * the people already emailed are not emailed twice.
 */
export function sendAnnouncementConsumer(
  sender: EmailSender,
  options: AnnouncementEmailOptions,
): EventConsumer {
  return {
    name: 'announcement.send_emails',
    eventTypes: [ANNOUNCEMENT_REQUESTED],
    async handle(event, client) {
      const p = payload.parse(event.payload);
      if (!event.organizationId) return;
      const { rows } = await client.query<{
        out_registration_id: string;
        out_email: string;
        out_name: string;
        out_active: boolean;
        out_subject: string;
        out_body: string;
        out_event_name: string;
        out_org_name: string;
        out_handle: string | null;
        out_event_slug: string;
      }>('SELECT * FROM eventhub.announcement_pending($1, $2)', [
        p.announcementId,
        event.organizationId,
      ]);
      for (const r of rows) {
        if (r.out_active) {
          const site =
            options.publicSiteUrl && r.out_handle
              ? `${options.publicSiteUrl.replace('{handle}', r.out_handle)}/${r.out_event_slug}`
              : null;
          await sender.send({
            messageId: `${event.eventId}-${r.out_registration_id}`,
            to: r.out_email,
            template: 'event_announcement',
            // The event name first, so people see at once where it comes from.
            subject: `${r.out_event_name}: ${r.out_subject}`,
            text: [
              `Hello ${r.out_name},`,
              '',
              r.out_body,
              '',
              '—',
              `Sent by ${r.out_org_name} to people who signed up for ${r.out_event_name}.`,
              ...(site ? [`Event page: ${site}`] : []),
            ].join('\n'),
          });
        }
        await client.query('SELECT eventhub.announcement_mark($1, $2, $3, $4)', [
          p.announcementId,
          event.organizationId,
          r.out_registration_id,
          r.out_active,
        ]);
      }
    },
  };
}
