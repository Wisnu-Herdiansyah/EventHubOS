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
  /**
   * new: registered; repeat: signed up again; waitlisted: joined the waitlist; promoted: got a
   * seat from the waitlist (ADR-0035).
   */
  kind: z.enum(['new', 'repeat', 'waitlisted', 'promoted']),
});
const cancelledPayload = z.object({
  registrationId: z.uuid(),
  by: z.enum(['attendee', 'organizer']),
  /** What was cancelled; absent on events from before the waitlist. */
  from: z.enum(['confirmed', 'waitlisted']).optional(),
});

/** Each kind is sent only while the entry is still in the state it announces. */
const SENDABLE: Record<z.infer<typeof confirmationPayload>['kind'], string[]> = {
  new: ['confirmed'],
  promoted: ['confirmed'],
  waitlisted: ['waitlisted'],
  repeat: ['confirmed', 'waitlisted'],
};

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
 * Registration confirmation with a cancel link (ADR-0023), and the waitlist emails (ADR-0035):
 * joining (with a link to leave, and no ticket) and getting a seat (a full confirmation). As with other emailed links
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
        out_status: 'confirmed' | 'waitlisted';
      }>('SELECT * FROM eventhub.registration_issue_link_token($1, $2, $3)', [
        payload.registrationId,
        event.organizationId,
        hash,
      ]);
      const r = rows[0];
      // Cancelled meanwhile, or moved on (promoted before the waitlist email went out): the
      // later event sends the email that matches.
      if (!r || !SENDABLE[payload.kind].includes(r.out_status)) return;
      const site =
        options.publicSiteUrl && r.out_handle
          ? options.publicSiteUrl.replace('{handle}', r.out_handle)
          : null;
      const eventPage = site ? [`Event page: ${site}/${r.out_event_slug}`] : [];
      const link = site ? `${site}/cancel-registration#token=${token}` : null;
      if (r.out_status === 'waitlisted') {
        await sender.send({
          messageId: event.eventId,
          to: r.out_email,
          template: 'registration_waitlisted',
          subject: `You're on the waitlist: ${r.out_event_name}`,
          text: [
            `Hello ${r.out_name},`,
            '',
            payload.kind === 'repeat'
              ? `You're already on the waitlist for ${r.out_event_name}.`
              : `${r.out_event_name} is full, so you're on the waitlist.`,
            "If a seat opens up, it goes to the next person waiting and we'll email you; you don't need to do anything.",
            `When: ${when(r.out_starts_at, r.out_timezone)}`,
            ...eventPage,
            '',
            link
              ? `Changed your mind? Leave the waitlist: ${link}`
              : 'Changed your mind? Reply to the organizer.',
          ].join('\n'),
        });
        return;
      }
      await sender.send({
        messageId: event.eventId,
        to: r.out_email,
        template:
          payload.kind === 'new'
            ? 'registration_confirmed'
            : payload.kind === 'promoted'
              ? 'registration_promoted'
              : 'registration_reminder',
        subject:
          payload.kind === 'promoted'
            ? `A seat opened up: you're registered for ${r.out_event_name}`
            : `You're registered: ${r.out_event_name}`,
        text: [
          `Hello ${r.out_name},`,
          '',
          payload.kind === 'new'
            ? `You're registered for ${r.out_event_name}.`
            : payload.kind === 'promoted'
              ? `Good news: a seat opened up, and you're now registered for ${r.out_event_name}.`
              : `You're already registered for ${r.out_event_name}; here are your details again.`,
          `When: ${when(r.out_starts_at, r.out_timezone)}`,
          ...eventPage,
          // ADR-0029: the QR code is drawn from the fragment, which browsers never send.
          ...(site
            ? [
                '',
                `Your ticket (show its QR code at the door): ${site}/${r.out_event_slug}/ticket#id=${payload.registrationId}`,
                // ADR-0048: the same file as the page's Add to calendar link.
                `Add it to your calendar: ${site}/${r.out_event_slug}/calendar.ics`,
              ]
            : []),
          '',
          link
            ? `Can't come? Cancel your registration: ${link}`
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
      const waiting = payload.from === 'waitlisted';
      await sender.send({
        messageId: event.eventId,
        to: r.out_email,
        template: waiting ? 'registration_waitlist_left' : 'registration_cancelled',
        subject: waiting
          ? `Waitlist place cancelled: ${r.out_event_name}`
          : `Registration cancelled: ${r.out_event_name}`,
        text: [
          `Hello ${r.out_name},`,
          '',
          waiting
            ? payload.by === 'attendee'
              ? `You've left the waitlist for ${r.out_event_name}, as you asked.`
              : `The organizer removed you from the waitlist for ${r.out_event_name}.`
            : payload.by === 'attendee'
              ? `Your registration for ${r.out_event_name} is cancelled, as you asked.`
              : `The organizer cancelled your registration for ${r.out_event_name}.`,
        ].join('\n'),
      });
    },
  };
}
