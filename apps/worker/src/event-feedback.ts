import { createHash } from 'node:crypto';
import { withTransaction, type Pool } from '@eventhub/db';
import type { EmailSender } from '@eventhub/kernel';
import { deriveEmailToken } from './consumers/verification-token.ts';

export interface EventFeedbackOptions {
  /** {handle} template of public sites (ADR-0021). Without it nobody can be asked. */
  publicSiteUrl: string | null;
  tokenSecret: string;
  /** People handled per pass. */
  batchSize?: number;
}

/**
 * Asks people who attended an event for feedback, once, after it has ended (ADR-0063). Each
 * pass locks a batch (other workers skip it), emails each person a personal link and marks
 * them. If a send fails, the whole batch rolls back and is tried on the next pass.
 *
 * The link's token is derived from the registration, so a retry sends a byte-identical email
 * under the same message ID, and only its SHA-256 hash is stored (as for other emailed links,
 * ADR-0008). Returns how many people were asked.
 */
export async function sendFeedbackRequestsOnce(
  pool: Pool,
  sender: EmailSender,
  options: EventFeedbackOptions,
): Promise<number> {
  // The email is only a link: with nowhere to point it, there is nothing to send.
  if (!options.publicSiteUrl) return 0;
  const siteTemplate = options.publicSiteUrl;
  return withTransaction(pool, {}, async (client) => {
    const { rows } = await client.query<{
      out_registration_id: string;
      out_organization_id: string;
      out_email: string;
      out_name: string;
      out_event_name: string;
      out_org_name: string;
      out_handle: string;
    }>('SELECT * FROM eventhub.event_feedback_due($1)', [options.batchSize ?? 100]);
    for (const r of rows) {
      const token = deriveEmailToken(options.tokenSecret, 'event-feedback', r.out_registration_id);
      const hash = createHash('sha256').update(token).digest();
      const link = `${siteTemplate.replace('{handle}', r.out_handle)}/feedback#token=${token}`;
      await sender.send({
        messageId: `event-feedback-${r.out_registration_id}`,
        to: r.out_email,
        template: 'event_feedback_request',
        subject: `How was ${r.out_event_name}?`,
        text: [
          `Hello ${r.out_name},`,
          '',
          `Thank you for coming to ${r.out_event_name}. How was it?`,
          `It takes a minute: ${link}`,
          '',
          'Your answer is shared with the organizer without your name. The link works for 30 days after the event.',
          '',
          '—',
          `Sent by ${r.out_org_name}.`,
        ].join('\n'),
      });
      await client.query('SELECT eventhub.event_feedback_mark($1, $2, $3)', [
        r.out_registration_id,
        r.out_organization_id,
        hash,
      ]);
    }
    return rows.length;
  });
}
