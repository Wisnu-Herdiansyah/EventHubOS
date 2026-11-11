import { z } from 'zod';
import { notFound } from '@eventhub/kernel';
import type { Pool } from '@eventhub/db';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { withOrganization } from '../tenancy/access.ts';

/** Events in one organization report (ADR-0032); the newest by start date are kept. */
export const ORG_REPORT_MAX_EVENTS = 500;

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

const orgReportSchema = z
  .object({
    timezone: z.string(),
    totals: z.object({
      /** All events, including any beyond the listed ones. */
      events: z.number().int(),
      registered: z.number().int(),
      cancelled: z.number().int(),
      checkedIn: z.number().int(),
      /** Attendance counts only events that have ended, so the rate is not diluted by future ones. */
      endedEvents: z.number().int(),
      endedRegistered: z.number().int(),
      endedCheckedIn: z.number().int(),
    }),
    /** Sign-ups per calendar month in the organization's time zone, the last 12 months. */
    signUpsByMonth: z.array(
      z.object({ month: z.string(), signUps: z.number().int() }).meta({ id: 'ReportMonth' }),
    ),
    /** Newest first by start date. */
    events: z.array(
      z
        .object({
          id: uuid,
          name: z.string(),
          lifecycle: z.string(),
          startsAt: z.iso.datetime(),
          ended: z.boolean(),
          capacity: z.number().int().nullable(),
          registered: z.number().int(),
          cancelled: z.number().int(),
          checkedIn: z.number().int(),
        })
        .meta({ id: 'ReportEventRow' }),
    ),
    truncated: z.boolean(),
  })
  .meta({ id: 'OrganizationReport' });

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

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/report',
      operationId: 'getOrganizationReport',
      summary:
        'Sign-ups and attendance across all events of an organization. Counts only. report.read.',
      tags: ['reports'],
      requires: 'report.read',
      idempotent: false,
      schemas: {
        params: z.object({ organizationId: uuid }).strict(),
        response: { status: 200, schema: orgReportSchema },
      },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'report.read',
          async (client, access) => {
            const org = await client.query<{ timezone: string }>(
              'SELECT timezone FROM eventhub.organization WHERE id = $1',
              [access.organizationId],
            );
            const timezone = org.rows[0]!.timezone;
            const events = await client.query<{
              id: string;
              name: string;
              lifecycle: string;
              starts_at: Date;
              ends_at: Date;
              capacity: number | null;
              registered: number;
              cancelled: number;
              checked_in: number;
            }>(
              `SELECT e.id, e.name, e.lifecycle, e.starts_at, e.ends_at,
                      (e.settings->'registration'->>'capacity')::int AS capacity,
                      count(r.id) FILTER (WHERE r.status = 'confirmed')::int AS registered,
                      count(r.id) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
                      count(r.id) FILTER (WHERE r.status = 'confirmed'
                                            AND r.checked_in_at IS NOT NULL)::int AS checked_in
                 FROM eventhub.event e
                 LEFT JOIN eventhub.registration r
                   ON r.organization_id = e.organization_id AND r.event_id = e.id
                WHERE e.organization_id = $1
                GROUP BY e.id
                ORDER BY e.starts_at DESC, e.id
                LIMIT ${ORG_REPORT_MAX_EVENTS}`,
              [access.organizationId],
            );
            // The last 12 calendar months in the organization's time zone, this month included.
            const months = await client.query<{ month: string; sign_ups: number }>(
              `WITH bounds AS (
                 SELECT date_trunc('month', now() AT TIME ZONE $2)::date AS this_month
               ), series AS (
                 SELECT generate_series(this_month - interval '11 months', this_month,
                                        interval '1 month')::date AS m
                   FROM bounds
               )
               SELECT to_char(s.m, 'YYYY-MM') AS month,
                      (SELECT count(*) FROM eventhub.registration r
                        WHERE r.organization_id = $1
                          AND date_trunc('month', r.created_at AT TIME ZONE $2)::date = s.m)::int
                        AS sign_ups
                 FROM series s ORDER BY s.m`,
              [access.organizationId, timezone],
            );
            const now = Date.now();
            const rows = events.rows.map((e) => ({
              id: e.id,
              name: e.name,
              lifecycle: e.lifecycle,
              startsAt: e.starts_at.toISOString(),
              ended: e.ends_at.getTime() <= now,
              capacity: e.capacity,
              registered: e.registered,
              cancelled: e.cancelled,
              checkedIn: e.checked_in,
            }));
            // Totals over every event, not only the listed ones.
            const totals = await client.query<{
              events: number;
              registered: number;
              cancelled: number;
              checked_in: number;
              ended_events: number;
              ended_registered: number;
              ended_checked_in: number;
            }>(
              `SELECT count(DISTINCT e.id)::int AS events,
                      count(r.id) FILTER (WHERE r.status = 'confirmed')::int AS registered,
                      count(r.id) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
                      count(r.id) FILTER (WHERE r.status = 'confirmed'
                                            AND r.checked_in_at IS NOT NULL)::int AS checked_in,
                      count(DISTINCT e.id) FILTER (WHERE e.ends_at <= now())::int AS ended_events,
                      count(r.id) FILTER (WHERE e.ends_at <= now()
                                            AND r.status = 'confirmed')::int AS ended_registered,
                      count(r.id) FILTER (WHERE e.ends_at <= now() AND r.status = 'confirmed'
                                            AND r.checked_in_at IS NOT NULL)::int AS ended_checked_in
                 FROM eventhub.event e
                 LEFT JOIN eventhub.registration r
                   ON r.organization_id = e.organization_id AND r.event_id = e.id
                WHERE e.organization_id = $1`,
              [access.organizationId],
            );
            const t = totals.rows[0]!;
            return {
              status: 200,
              body: {
                timezone,
                totals: {
                  events: t.events,
                  registered: t.registered,
                  cancelled: t.cancelled,
                  checkedIn: t.checked_in,
                  endedEvents: t.ended_events,
                  endedRegistered: t.ended_registered,
                  endedCheckedIn: t.ended_checked_in,
                },
                signUpsByMonth: months.rows.map((m) => ({ month: m.month, signUps: m.sign_ups })),
                events: rows,
                truncated: t.events > ORG_REPORT_MAX_EVENTS,
              },
            };
          },
        );
      },
    }),
  ];
}
