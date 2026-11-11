import { z } from 'zod';
import { AppError, createDomainEvent, notFound } from '@eventhub/kernel';
import { enqueueEvent, writeAudit, type Pool } from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { withOrganization } from '../tenancy/access.ts';

/**
 * Event announcements (ADR-0037): one plain-text email from the organizer to the people
 * registered for an event, and optionally its waitlist. Recipients are captured when it is sent;
 * the worker emails them. No attendee details enter audit or outbox records.
 */
export const ANNOUNCEMENT_REQUESTED = 'announcement.requested';
/** Announcements per event in any 24 hours. */
export const ANNOUNCEMENT_DAILY_LIMIT = 3;
/** Recipients of one announcement; larger events need batched sending first. */
export const ANNOUNCEMENT_MAX_RECIPIENTS = 5_000;

// Control characters other than line breaks and tabs are refused in the message.
// eslint-disable-next-line no-control-regex
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;

const AUDIENCES = ['registered', 'registered_and_waitlist'] as const;

const sendBody = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1, 'Enter a subject.')
      .max(150)
      .refine((s) => !ANY_CONTROL.test(s), 'Use one line of plain text.'),
    body: z
      .string()
      .trim()
      .min(1, 'Write a message.')
      .max(5000)
      .refine((s) => !BODY_CONTROL.test(s), 'Use plain text.'),
    audience: z.enum(AUDIENCES),
  })
  .strict()
  .meta({ id: 'SendAnnouncementRequest' });

const announcementSchema = z
  .object({
    id: uuid,
    subject: z.string(),
    body: z.string(),
    audience: z.enum(AUDIENCES),
    createdAt: z.iso.datetime(),
    /** Who sent it, while they are still known to the organization. */
    sentBy: z.string().nullable(),
    recipients: z.number().int(),
    /** Emailed so far. */
    delivered: z.number().int(),
    /** Cancelled before the email went out, so not emailed. */
    skipped: z.number().int(),
  })
  .meta({ id: 'Announcement' });

const eventParams = z.object({ organizationId: uuid, eventId: uuid }).strict();

interface AnnouncementRow {
  id: string;
  subject: string;
  body: string;
  audience: (typeof AUDIENCES)[number];
  created_at: Date;
  sent_by: string | null;
  recipients: number;
  delivered: number;
  skipped: number;
}

const toDto = (r: AnnouncementRow) => ({
  id: r.id,
  subject: r.subject,
  body: r.body,
  audience: r.audience,
  createdAt: r.created_at.toISOString(),
  sentBy: r.sent_by,
  recipients: r.recipients,
  delivered: r.delivered,
  skipped: r.skipped,
});

const SELECT_ANNOUNCEMENTS = `
  SELECT a.id, a.subject, a.body, a.audience, a.created_at,
         (SELECT m.out_email FROM eventhub.organization_members($1) m
           WHERE m.out_user_id = a.created_by) AS sent_by,
         count(ar.registration_id)::int AS recipients,
         count(ar.delivered_at)::int AS delivered,
         count(ar.skipped_at)::int AS skipped
    FROM eventhub.announcement a
    LEFT JOIN eventhub.announcement_recipient ar
      ON ar.announcement_id = a.id AND ar.organization_id = a.organization_id
   WHERE a.organization_id = $1 AND a.event_id = $2`;

export function announcementRoutes(pool: Pool): AnyRoute[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/events/:eventId/announcements',
      operationId: 'sendAnnouncement',
      summary: `Email everyone registered for an event (optionally the waitlist too). Plain text; at most ${ANNOUNCEMENT_DAILY_LIMIT} per event per 24 hours. communication.send.`,
      tags: ['announcements'],
      requires: 'communication.send',
      idempotent: true,
      schemas: {
        params: eventParams,
        body: sendBody,
        response: { status: 201, schema: announcementSchema },
      },
      async handler({ principal, params, body, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'communication.send',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                // The event lock serialises sends, so the daily limit cannot be raced.
                const ev = await client.query<{ lifecycle: string }>(
                  `SELECT lifecycle FROM eventhub.event
                    WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
                  [access.organizationId, params.eventId],
                );
                const event = ev.rows[0];
                if (!event) throw notFound('Event');
                if (event.lifecycle === 'archived') {
                  throw new AppError('conflict', 'Archived events are read-only.', {
                    details: { reason: 'event_archived' },
                  });
                }
                const recent = await client.query<{ n: number }>(
                  `SELECT count(*)::int AS n FROM eventhub.announcement
                    WHERE organization_id = $1 AND event_id = $2
                      AND created_at > now() - interval '24 hours'`,
                  [access.organizationId, params.eventId],
                );
                if (recent.rows[0]!.n >= ANNOUNCEMENT_DAILY_LIMIT) {
                  throw new AppError(
                    'conflict',
                    `An event can send at most ${ANNOUNCEMENT_DAILY_LIMIT} announcements in 24 hours.`,
                    { details: { reason: 'announcement_limit' } },
                  );
                }
                const statuses =
                  body.audience === 'registered_and_waitlist'
                    ? ['confirmed', 'waitlisted']
                    : ['confirmed'];
                const count = await client.query<{ n: number }>(
                  `SELECT count(*)::int AS n FROM eventhub.registration
                    WHERE organization_id = $1 AND event_id = $2 AND status = ANY($3)`,
                  [access.organizationId, params.eventId, statuses],
                );
                const n = count.rows[0]!.n;
                if (n === 0) {
                  throw new AppError('conflict', 'Nobody is registered yet.', {
                    details: { reason: 'no_recipients' },
                  });
                }
                if (n > ANNOUNCEMENT_MAX_RECIPIENTS) {
                  throw new AppError(
                    'conflict',
                    `Announcements can reach at most ${ANNOUNCEMENT_MAX_RECIPIENTS.toLocaleString('en')} people for now.`,
                    { details: { reason: 'too_many_recipients' } },
                  );
                }
                const ins = await client.query<{ id: string }>(
                  `INSERT INTO eventhub.announcement
                     (organization_id, event_id, subject, body, audience, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                  [
                    access.organizationId,
                    params.eventId,
                    body.subject,
                    // Browsers submit text areas with CRLF line breaks; emails use LF.
                    body.body.replace(/\r\n?/g, '\n'),
                    body.audience,
                    principal.userId,
                  ],
                );
                const id = ins.rows[0]!.id;
                await client.query(
                  `INSERT INTO eventhub.announcement_recipient
                     (organization_id, announcement_id, registration_id)
                   SELECT organization_id, $3, id FROM eventhub.registration
                    WHERE organization_id = $1 AND event_id = $2 AND status = ANY($4)`,
                  [access.organizationId, params.eventId, id, statuses],
                );
                const actor = { type: 'user' as const, id: principal.userId };
                // How many and to whom by group: never the people themselves.
                await writeAudit(client, {
                  organizationId: access.organizationId,
                  actor,
                  action: 'event.announcement_sent',
                  targetType: 'event',
                  targetId: params.eventId,
                  correlationId,
                  metadata: { announcementId: id, audience: body.audience, recipients: n },
                });
                await enqueueEvent(
                  client,
                  createDomainEvent({
                    eventType: ANNOUNCEMENT_REQUESTED,
                    schemaVersion: 1,
                    actor,
                    organizationId: access.organizationId,
                    aggregateType: 'event',
                    aggregateId: params.eventId,
                    correlationId,
                    payload: { announcementId: id },
                  }),
                );
                const { rows } = await client.query<AnnouncementRow>(
                  `${SELECT_ANNOUNCEMENTS} AND a.id = $3 GROUP BY a.id`,
                  [access.organizationId, params.eventId, id],
                );
                return { status: 201, body: toDto(rows[0]!) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events/:eventId/announcements',
      operationId: 'listAnnouncements',
      summary: 'Announcements sent for an event, newest first (up to 50), with delivery counts.',
      tags: ['announcements'],
      requires: 'communication.send',
      idempotent: false,
      schemas: {
        params: eventParams,
        response: {
          status: 200,
          schema: z.object({ data: z.array(announcementSchema) }).meta({ id: 'AnnouncementList' }),
        },
      },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'communication.send',
          async (client, access) => {
            const ev = await client.query(
              'SELECT 1 FROM eventhub.event WHERE organization_id = $1 AND id = $2',
              [access.organizationId, params.eventId],
            );
            if (ev.rowCount === 0) throw notFound('Event');
            const { rows } = await client.query<AnnouncementRow>(
              `${SELECT_ANNOUNCEMENTS} GROUP BY a.id ORDER BY a.created_at DESC, a.id DESC LIMIT 50`,
              [access.organizationId, params.eventId],
            );
            return { status: 200, body: { data: rows.map(toDto) } };
          },
        );
      },
    }),
  ];
}
