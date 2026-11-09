import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EmailSender } from '@eventhub/kernel';
import type { EventConsumer } from './consumer.ts';
import { deriveEmailToken } from './verification-token.ts';

export const REGISTRATION_CONFIRMATION_REQUESTED = 'registration.confirmation_requested';
export const REGISTRATION_CANCELLED = 'registration.cancelled';

const confirmationPayload = z.object({
  registrationId: z.uuid(),
  eventId: z.uuid(),
  kind: z.enum(['new', 'repeat']),
});
const cancelledPayload = z.object({
  registrationId: z.uuid(),
  by: z.enum(['attendee', 'organizer']),
});

export interface RegistrationEmailOptions {
  /** {handle} template of public sites (ADR-0021), or null: no cancel link. */
  publicSiteUrl: string | null;
  tokenSecret: string;
}

/** "1 Mar 2027, 09:00 GMT+7" in the event's time zone. */
function when(startsAt: Date, timeZone: string): string {
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
 * Registration confirmation with a cancel link (ADR-0023). As with other emailed links
 * (ADR-0008), the token is derived from the outbox event, so a retry sends a byte-identical email,
 * and only its SHA-256 hash is stored. A repeat sign-up re-sends the confirmation to the address
 * itself and replaces the link; the visitor's screen never says whether the address was new.
 */
export function sendRegistrationConfirmationConsumer(
  sender: EmailSender,
  options: RegistrationEmailOptions,
): EventConsumer {
  return {
    name: 'registration.send_confirmation_email',
    eventTypes: [REGISTRATION_CONFIRMATION_REQUESTED],
    async handle(event, client) {
      const payload = confirmationPayload.parse(event.payload);
      if (!event.organizationId) return;
      const token = deriveEmailToken(options.tokenSecret, 'registration-cancel', event.eventId);
      const hash = createHash('sha256').update(token).digest();
      const { rows } = await client.query<{
        out_email: string;
        out_name: string;
        out_event_name: string;
        out_starts_at: Date;
        out_timezone: string;
        out_handle: string | null;
        out_event_slug: string;
      }>('SELECT * FROM eventhub.registration_issue_cancel_token($1, $2, $3)', [
        payload.registrationId,
        event.organizationId,
        hash,
      ]);
      const r = rows[0];
      if (!r) return; // cancelled meanwhile: nothing to confirm
      const site =
        options.publicSiteUrl && r.out_handle
          ? options.publicSiteUrl.replace('{handle}', r.out_handle)
          : null;
      await sender.send({
        messageId: event.eventId,
        to: r.out_email,
        template: payload.kind === 'new' ? 'registration_confirmed' : 'registration_reminder',
        subject: `You're registered: ${r.out_event_name}`,
        text: [
          `Hello ${r.out_name},`,
          '',
          payload.kind === 'new'
            ? `You're registered for ${r.out_event_name}.`
            : `You're already registered for ${r.out_event_name}; here are your details again.`,
          `When: ${when(r.out_starts_at, r.out_timezone)}`,
          ...(site ? [`Event page: ${site}/${r.out_event_slug}`] : []),
          '',
          site
            ? `Can't come? Cancel your registration: ${site}/cancel-registration#token=${token}`
            : "Can't come? Reply to the organizer to cancel.",
        ].join('\n'),
      });
    },
  };
}

export function sendRegistrationCancelledConsumer(sender: EmailSender): EventConsumer {
  return {
    name: 'registration.send_cancelled_email',
    eventTypes: [REGISTRATION_CANCELLED],
    async handle(event, client) {
      const payload = cancelledPayload.parse(event.payload);
      if (!event.organizationId) return;
      const { rows } = await client.query<{
        out_email: string;
        out_name: string;
        out_event_name: string;
      }>('SELECT * FROM eventhub.registration_notice_details($1, $2)', [
        payload.registrationId,
        event.organizationId,
      ]);
      const r = rows[0];
      if (!r) return;
      await sender.send({
        messageId: event.eventId,
        to: r.out_email,
        template: 'registration_cancelled',
        subject: `Registration cancelled: ${r.out_event_name}`,
        text: [
          `Hello ${r.out_name},`,
          '',
          payload.by === 'attendee'
            ? `Your registration for ${r.out_event_name} is cancelled, as you asked.`
            : `The organizer cancelled your registration for ${r.out_event_name}.`,
        ].join('\n'),
      });
    },
  };
}
