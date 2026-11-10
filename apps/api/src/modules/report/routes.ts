import { z } from 'zod';
import { notFound } from '@eventhub/kernel';
import type { Pool } from '@eventhub/db';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { withOrganization } from '../tenancy/access.ts';

/** Days in one report; registrations rarely span more than a year (ADR-0030). */
export const REPORT_MAX_DAYS = 366;

const dayCount = z
  .object({
    /** Calendar day in the event's time zone, YYYY-MM-DD. */
    date: z.string(),
    registered: z.number().int(),
    cancelled: z.number().int(),
  })
  .meta({ id: 'ReportDay' });

const hourCount = z
  .object({
    /** Start of the hour in the event's time zone, YYYY-MM-DDTHH:00. */
    hour: z.string(),
    checkedIn: z.number().int(),
  })
  .meta({ id: 'ReportHour' });

const reportSchema = z
  .object({
    timezone: z.string(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    ended: z.boolean(),
    capacity: z.number().int().nullable(),
    totals: z.object({
      /** Registrations ever made, cancelled ones included. */
      signUps: z.number().int(),
      registered: z.number().int(),
      cancelled: z.number().int(),
      checkedIn: z.number().int(),
      /** Registered but not checked in; only meaningful once the event has ended. */
      noShows: z.number().int(),
    }),
    /** Every day from the first sign-up to the last sign-up or cancellation (gaps are zeros). */
    byDay: z.array(dayCount),
    /** Hours with at least one check-in. */
    checkInsByHour: z.array(hourCount),
    /** More days of activity exist than one report holds; the earliest are left out. */
    truncated: z.boolean(),
  })
  .meta({ id: 'EventReport' });

/**
 * Event reports (ADR-0030): counts only, never attendees. report.read lets Analysts see how an
 * event went without seeing who came.
 */
export function reportRoutes(pool: Pool): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events/:eventId/report',
      operationId: 'getEventReport',
      summary: 'Registration and attendance figures for an event. Counts only. report.read.',
      tags: ['reports'],
      requires: 'report.read',
      idempotent: false,
      schemas: {
        params: z.object({ organizationId: uuid, eventId: uuid }).strict(),
        response: { status: 200, schema: reportSchema },
      },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'report.read',
          async (client, access) => {
            const ev = await client.query<{
              timezone: string;
              starts_at: Date;
              ends_at: Date;
              capacity: number | null;
              sign_ups: number;
              registered: number;
              cancelled: number;
              checked_in: number;
            }>(
              `SELECT e.timezone, e.starts_at, e.ends_at,
                      (e.settings->'registration'->>'capacity')::int AS capacity,
                      count(r.id)::int AS sign_ups,
                      count(r.id) FILTER (WHERE r.status = 'confirmed')::int AS registered,
                      count(r.id) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
                      count(r.id) FILTER (WHERE r.status = 'confirmed'
                                            AND r.checked_in_at IS NOT NULL)::int AS checked_in
                 FROM eventhub.event e
                 LEFT JOIN eventhub.registration r
                   ON r.organization_id = e.organization_id AND r.event_id = e.id
                WHERE e.organization_id = $1 AND e.id = $2
                GROUP BY e.id`,
              [access.organizationId, params.eventId],
            );
            const e = ev.rows[0];
            if (!e) throw notFound('Event');

            // Daily counts in the event's own calendar, gaps filled, newest REPORT_MAX_DAYS kept.
            const days = await client.query<{
              day: string;
              registered: number;
              cancelled: number;
              total_days: number;
            }>(
              `WITH r AS (
                 SELECT (created_at AT TIME ZONE $3)::date AS made,
                        (cancelled_at AT TIME ZONE $3)::date AS gone
                   FROM eventhub.registration
                  WHERE organization_id = $1 AND event_id = $2
               ), span AS (
                 SELECT min(made) AS first, greatest(max(made), max(gone)) AS last FROM r
               ), series AS (
                 SELECT d::date AS day, count(*) OVER () AS total_days
                   FROM span, generate_series(span.first, span.last, interval '1 day') AS d
                  WHERE span.first IS NOT NULL
               )
               SELECT to_char(s.day, 'YYYY-MM-DD') AS day, s.total_days::int AS total_days,
                      (SELECT count(*) FROM r WHERE r.made = s.day)::int AS registered,
                      (SELECT count(*) FROM r WHERE r.gone = s.day)::int AS cancelled
                 FROM series s
                ORDER BY s.day DESC
                LIMIT ${REPORT_MAX_DAYS}`,
              [access.organizationId, params.eventId, e.timezone],
            );
            const hours = await client.query<{ hour: string; checked_in: number }>(
              `SELECT to_char(date_trunc('hour', checked_in_at AT TIME ZONE $3),
                              'YYYY-MM-DD"T"HH24:00') AS hour,
                      count(*)::int AS checked_in
                 FROM eventhub.registration
                WHERE organization_id = $1 AND event_id = $2
                  AND status = 'confirmed' AND checked_in_at IS NOT NULL
                GROUP BY 1 ORDER BY 1
                LIMIT 500`,
              [access.organizationId, params.eventId, e.timezone],
            );
            const ended = e.ends_at.getTime() <= Date.now();
            return {
              status: 200,
              body: {
                timezone: e.timezone,
                startsAt: e.starts_at.toISOString(),
                endsAt: e.ends_at.toISOString(),
                ended,
                capacity: e.capacity,
                totals: {
                  signUps: e.sign_ups,
                  registered: e.registered,
                  cancelled: e.cancelled,
                  checkedIn: e.checked_in,
                  noShows: e.registered - e.checked_in,
                },
                byDay: days.rows
                  .map((d) => ({ date: d.day, registered: d.registered, cancelled: d.cancelled }))
                  .reverse(),
                checkInsByHour: hours.rows.map((h) => ({ hour: h.hour, checkedIn: h.checked_in })),
                truncated: (days.rows[0]?.total_days ?? 0) > REPORT_MAX_DAYS,
              },
            };
          },
        );
      },
    }),
  ];
}
