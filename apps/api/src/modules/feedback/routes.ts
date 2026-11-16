import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, notFound } from '@eventhub/kernel';
import { withTransaction, type Pool } from '@eventhub/db';
import { definePublicRoute, defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { withOrganization } from '../tenancy/access.ts';

/**
 * Post-event feedback (ADR-0063). Attendees answer from the personal link in their email; staff
 * read the figures (report.read) and the comments (registration.manage). An answer is never
 * returned with who gave it.
 */
const PUBLIC_FEEDBACK_LIMIT = { max: 20, timeWindow: '1 minute' };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Comments shown on one page of the report; the newest are kept. */
export const FEEDBACK_MAX_COMMENTS = 200;
export const FEEDBACK_COMMENT_MAX = 2000;

const token = z.string().regex(TOKEN_RE, 'Malformed link.');
const hashOf = (value: string) => createHash('sha256').update(value).digest();
const invalidLink = () =>
  new AppError('validation_failed', 'This link is no longer valid.', {
    details: { reason: 'invalid_or_expired_link' },
  });

export const feedbackInput = z
  .object({
    token,
    rating: z.number().int().min(1).max(5),
    /** Plain text. Leading and trailing space is dropped; empty means no comment. */
    comment: z.string().max(FEEDBACK_COMMENT_MAX).optional(),
  })
  .strict()
  .meta({ id: 'SubmitFeedbackRequest' });

const summarySchema = z
  .object({
    /** Whether the event asks for feedback at all. */
    enabled: z.boolean(),
    /** People emailed a link so far. */
    asked: z.number().int(),
    responses: z.number().int(),
    /** Mean rating to one decimal place; null with no responses. */
    average: z.number().nullable(),
    /** How many gave each rating, from 1 to 5. */
    ratings: z.array(z.number().int()).length(5),
  })
  .meta({ id: 'EventFeedbackSummary' });

const commentsSchema = z
  .object({
    items: z.array(
      z.object({
        rating: z.number().int(),
        comment: z.string(),
        submittedAt: z.iso.datetime(),
      }),
    ),
    /** More comments exist than are listed. */
    truncated: z.boolean(),
  })
  .meta({ id: 'EventFeedbackComments' });

export function feedbackRoutes(pool: Pool): AnyRoute[] {
  return [
    definePublicRoute({
      method: 'POST',
      path: '/v1/public/feedback/lookup',
      operationId: 'lookUpFeedbackLink',
      summary:
        'What a feedback link is for. Unknown, expired and cancelled links all answer the same.',
      tags: ['public'],
      idempotent: false,
      idempotencyExempt: 'Reads only: it is a POST so the token stays out of URLs and logs.',
      rateLimit: PUBLIC_FEEDBACK_LIMIT,
      schemas: {
        body: z.object({ token }).strict().meta({ id: 'FeedbackLinkRequest' }),
        response: {
          status: 200,
          schema: z
            .object({
              eventName: z.string(),
              organizationName: z.string(),
              /** This person has already answered; sending again replaces it. */
              answered: z.boolean(),
            })
            .meta({ id: 'FeedbackLink' }),
        },
      },
      async handler({ body }) {
        const { rows } = await pool.query<{
          out_event_name: string;
          out_org_name: string;
          out_answered: boolean;
        }>('SELECT * FROM eventhub.public_feedback_lookup($1)', [hashOf(body.token)]);
        const r = rows[0];
        if (!r) throw invalidLink();
        return {
          status: 200,
          body: {
            eventName: r.out_event_name,
            organizationName: r.out_org_name,
            answered: r.out_answered,
          },
        };
      },
    }),

    definePublicRoute({
      method: 'POST',
      path: '/v1/public/feedback',
      operationId: 'submitFeedback',
      summary:
        'Give feedback on an event with the link from its email: a rating from 1 to 5 and an optional comment. Sending again replaces the earlier answer.',
      tags: ['public'],
      idempotent: false,
      idempotencyExempt:
        'One answer per link: a repeat stores the same answer again and sends nothing.',
      rateLimit: PUBLIC_FEEDBACK_LIMIT,
      schemas: {
        body: feedbackInput,
        response: {
          status: 200,
          schema: z
            .object({ status: z.literal('received'), eventName: z.string() })
            .meta({ id: 'FeedbackReceived' }),
        },
      },
      async handler({ body }) {
        const eventName = await withTransaction(pool, {}, async (client) => {
          const { rows } = await client.query<{ out_event_name: string }>(
            'SELECT * FROM eventhub.public_feedback_submit($1, $2, $3)',
            [hashOf(body.token), body.rating, body.comment ?? null],
          );
          return rows[0]?.out_event_name ?? null;
        });
        if (eventName === null) throw invalidLink();
        return { status: 200, body: { status: 'received', eventName } };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events/:eventId/feedback',
      operationId: 'getEventFeedbackSummary',
      summary: 'How attendees rated an event. Figures only. report.read.',
      tags: ['reports'],
      requires: 'report.read',
      idempotent: false,
      schemas: {
        params: z.object({ organizationId: uuid, eventId: uuid }).strict(),
        response: { status: 200, schema: summarySchema },
      },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'report.read',
          async (client, access) => {
            const { rows } = await client.query<{
              enabled: boolean;
              asked: number;
              responses: number;
              average: string | null;
              ratings: number[];
            }>(
              `SELECT coalesce(e.settings->'feedback'->>'enabled', 'false') = 'true' AS enabled,
                      (SELECT count(*)::int FROM eventhub.registration r
                        WHERE r.organization_id = e.organization_id AND r.event_id = e.id
                          AND r.feedback_requested_at IS NOT NULL) AS asked,
                      count(f.rating)::int AS responses,
                      round(avg(f.rating), 1)::text AS average,
                      ARRAY(SELECT count(f2.rating)::int
                              FROM generate_series(1, 5) AS n
                              LEFT JOIN eventhub.event_feedback f2
                                ON f2.organization_id = e.organization_id AND f2.event_id = e.id
                               AND f2.rating = n
                             GROUP BY n ORDER BY n) AS ratings
                 FROM eventhub.event e
                 LEFT JOIN eventhub.event_feedback f
                   ON f.organization_id = e.organization_id AND f.event_id = e.id
                WHERE e.organization_id = $1 AND e.id = $2
                GROUP BY e.id`,
              [access.organizationId, params.eventId],
            );
            const r = rows[0];
            if (!r) throw notFound('Event');
            return {
              status: 200,
              body: {
                enabled: r.enabled,
                asked: r.asked,
                responses: r.responses,
                average: r.average === null ? null : Number(r.average),
                ratings: r.ratings,
              },
            };
          },
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events/:eventId/feedback/comments',
      operationId: 'listEventFeedbackComments',
      summary:
        'What attendees wrote about an event, newest first, without names. registration.manage.',
      tags: ['reports'],
      requires: 'registration.manage',
      idempotent: false,
      schemas: {
        params: z.object({ organizationId: uuid, eventId: uuid }).strict(),
        response: { status: 200, schema: commentsSchema },
      },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'registration.manage',
          async (client, access) => {
            const ev = await client.query(
              'SELECT 1 FROM eventhub.event WHERE organization_id = $1 AND id = $2',
              [access.organizationId, params.eventId],
            );
            if (ev.rowCount === 0) throw notFound('Event');
            const { rows } = await client.query<{
              rating: number;
              comment: string;
              updated_at: Date;
            }>(
              `SELECT rating, comment, updated_at FROM eventhub.event_feedback
                WHERE organization_id = $1 AND event_id = $2 AND comment IS NOT NULL
                ORDER BY updated_at DESC, registration_id
                LIMIT $3`,
              [access.organizationId, params.eventId, FEEDBACK_MAX_COMMENTS + 1],
            );
            return {
              status: 200,
              body: {
                items: rows.slice(0, FEEDBACK_MAX_COMMENTS).map((r) => ({
                  rating: r.rating,
                  comment: r.comment,
                  submittedAt: r.updated_at.toISOString(),
                })),
                truncated: rows.length > FEEDBACK_MAX_COMMENTS,
              },
            };
          },
        );
      },
    }),
  ];
}
