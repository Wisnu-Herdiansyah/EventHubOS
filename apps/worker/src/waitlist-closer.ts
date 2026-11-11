import { withTransaction, type Pool } from '@eventhub/db';
import type { EmailSender } from '@eventhub/kernel';

export interface WaitlistCloserOptions {
  /** {handle} template of public sites (ADR-0021), or null: no event link. */
  publicSiteUrl: string | null;
  /** People handled per pass. */
  batchSize?: number;
}

/**
 * Tells people still waiting that the waitlist has closed (ADR-0038), once registration has
 * closed. Each pass locks a batch (other workers skip it), emails each person and marks them.
 * If a send fails, the whole batch rolls back and is tried on the next pass; the message ID is
 * fixed per person, so the provider does not deliver a second copy of an email that went out.
 * Returns how many people were told.
 */
export async function closeWaitlistsOnce(
  pool: Pool,
  sender: EmailSender,
  options: WaitlistCloserOptions,
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
    }>('SELECT * FROM eventhub.waitlist_closing($1)', [options.batchSize ?? 100]);
    for (const r of rows) {
      const site =
        options.publicSiteUrl && r.out_handle
          ? `${options.publicSiteUrl.replace('{handle}', r.out_handle)}/${r.out_event_slug}`
          : null;
      await sender.send({
        messageId: `waitlist-closed-${r.out_registration_id}`,
        to: r.out_email,
        template: 'registration_waitlist_closed',
        subject: `The waitlist has closed: ${r.out_event_name}`,
        text: [
          `Hello ${r.out_name},`,
          '',
          `Registration for ${r.out_event_name} has closed, and no seat became free for you on the waitlist. We're sorry.`,
          "You don't need to do anything.",
          '',
          '—',
          `Sent by ${r.out_org_name}.`,
          ...(site ? [`Event page: ${site}`] : []),
        ].join('\n'),
      });
      await client.query('SELECT eventhub.waitlist_mark_closed($1, $2)', [
        r.out_registration_id,
        r.out_organization_id,
      ]);
    }
    return rows.length;
  });
}
