import { withTransaction, type Pool } from '@eventhub/db';
import type { EmailSender } from '@eventhub/kernel';

export interface EventReminderOptions {
  /** {handle} template of public sites (ADR-0021), or null: no event link. */
  publicSiteUrl: string | null;
  /** People handled per pass. */
  batchSize?: number;
}

/** "1 Mar 2027, 09:00 GMT+7" in the event's time zone. */
export function eventTime(startsAt: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  }).format(startsAt);
}

/**
 * Reminds people with a confirmed seat that their event starts within 24 hours (ADR-0062).
 * Each pass locks a batch (other workers skip it), emails each person and marks them. If a send
 * fails, the whole batch rolls back and is tried on the next pass; the message ID is fixed per
 * person, so the provider does not deliver a second copy of an email that already went out.
 * Returns how many people were reminded.
 *
 * The email carries no personal link: the ticket and cancel links are in the confirmation, and
 * issuing new ones here would stop those from working.
 */
export async function sendEventRemindersOnce(
  pool: Pool,
  sender: EmailSender,
  options: EventReminderOptions,
): Promise<number> {
  return withTransaction(pool, {}, async (client) => {
    const { rows } = await client.query<{
      out_registration_id: string;
      out_organization_id: string;
      out_email: string;
      out_name: string;
      out_event_name: string;
      out_org_name: string;
      out_handle: string | null;
      out_event_slug: string;
      out_starts_at: Date;
      out_timezone: string;
    }>('SELECT * FROM eventhub.event_reminders_due($1)', [options.batchSize ?? 100]);
    for (const r of rows) {
      const site =
        options.publicSiteUrl && r.out_handle
          ? `${options.publicSiteUrl.replace('{handle}', r.out_handle)}/${r.out_event_slug}`
          : null;
      await sender.send({
        messageId: `event-reminder-${r.out_registration_id}`,
        to: r.out_email,
        template: 'event_reminder',
        subject: `Reminder: ${r.out_event_name} starts soon`,
        text: [
          `Hello ${r.out_name},`,
          '',
          `This is a reminder that ${r.out_event_name} starts soon.`,
          `When: ${eventTime(r.out_starts_at, r.out_timezone)}`,
          ...(site ? [`Event page: ${site}`] : []),
          '',
          'Your ticket, and the link to cancel if you can no longer come, are in your confirmation email.',
          '',
          '—',
          `Sent by ${r.out_org_name}.`,
        ].join('\n'),
      });
      await client.query('SELECT eventhub.event_reminder_mark($1, $2)', [
        r.out_registration_id,
        r.out_organization_id,
      ]);
    }
    return rows.length;
  });
}
