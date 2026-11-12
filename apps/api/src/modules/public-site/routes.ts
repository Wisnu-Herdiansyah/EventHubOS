import { createHash } from 'node:crypto';
import { z } from 'zod';
import { uuid } from '../../http/schemas.ts';
import { questionSchema, storedQuestions } from '../registration/questions.ts';
import { EVENT_THEMES, notFound } from '@eventhub/kernel';
import { withTransaction, type Pool } from '@eventhub/db';
import { definePublicRoute, type AnyRoute } from '../../http/route.ts';
import { slugSchema } from '../event/routes.ts';
import { sectionSchema, type Section } from '../page/sections.ts';

/**
 * Public event site data (ADR-0021). Anonymous, read-only, and narrow: one SECURITY DEFINER
 * lookup returns the published revision of a public or unlisted event that is published, live or
 * ended. Every other case (unknown handle, draft-only page, private or unpublished event,
 * suspended organization) is the same 404, so nothing about non-public events leaks.
 */
const params = z
  .object({
    handle: z.string().regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/),
    eventSlug: slugSchema,
  })
  .strict();

const publicEventPageSchema = z
  .object({
    handle: z.string(),
    eventSlug: z.string(),
    name: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    timezone: z.string(),
    venueMode: z.string(),
    language: z.string(),
    lifecycle: z.enum(['published', 'live', 'ended']),
    /** Unlisted events are reachable by link but must not be indexed by search engines. */
    indexable: z.boolean(),
    sharing: z.object({
      title: z.string().nullable(),
      description: z.string().nullable(),
      /** Library image for link previews (ADR-0046), served at /images/{id}/large.webp. */
      imageAssetId: uuid.nullable(),
    }),
    /** Colour preset of the page (ADR-0046). */
    theme: z.enum(EVENT_THEMES),
    revision: z.number().int(),
    publishedAt: z.string(),
    /** Set when the event is cancelled (ADR-0050): the page says so, with the reason. */
    cancellation: z.object({ cancelledAt: z.string(), reason: z.string() }).nullable(),
    /** Visible sections only, in page order. */
    sections: z.array(sectionSchema),
    /** Shown with the consent checkbox of the registration form. */
    privacyPolicyUrl: z.string().nullable(),
    /** Whether visitors can register now (ADR-0023). */
    registration: z.object({
      /** 'waitlist': full, and sign-ups join the waitlist (ADR-0035). */
      /** cancelled: the event was cancelled (ADR-0050). */
      state: z.enum(['open', 'not_open_yet', 'closed', 'full', 'waitlist', 'cancelled']),
      opensAt: z.string().nullable(),
      closesAt: z.string(),
      /** Extra questions on the sign-up form (ADR-0041). */
      questions: z.array(questionSchema),
    }),
  })
  .meta({ id: 'PublicEventPage' });

const publicEventCalendarSchema = z
  .object({
    /** Stable and opaque: derived from the event, not its slug, so renaming keeps the entry. */
    uid: z.string(),
    /** Rises whenever the event changes, so a re-imported file replaces the entry. */
    sequence: z.number().int().min(0),
    updatedAt: z.string(),
    name: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    timezone: z.string(),
    venueMode: z.string(),
    description: z.string().nullable(),
    /** The event was cancelled (ADR-0050): the file says STATUS:CANCELLED. */
    cancelled: z.boolean(),
  })
  .meta({ id: 'PublicEventCalendar' });

/** Calendar UID of an event (ADR-0048): a one-way digest, so the event's ID is not published. */
export function calendarUid(eventId: string): string {
  const digest = createHash('sha256').update(`eventhub-calendar:${eventId}`).digest('hex');
  return `${digest.slice(0, 32)}@eventhub`;
}

function cancellationDto(r?: { out_cancelled_at: Date | null; out_reason: string | null }) {
  return r?.out_cancelled_at && r.out_reason !== null
    ? { cancelledAt: r.out_cancelled_at.toISOString(), reason: r.out_reason }
    : null;
}

interface Row {
  out_event_name: string;
  out_starts_at: Date;
  out_ends_at: Date;
  out_timezone: string;
  out_venue_mode: string;
  out_primary_language: string;
  out_lifecycle: 'published' | 'live' | 'ended';
  out_visibility: string;
  out_sharing_title: string | null;
  out_sharing_description: string | null;
  out_revision: number;
  out_sections: Section[];
  out_published_at: Date;
}

export function publicSiteRoutes(pool: Pool): AnyRoute[] {
  return [
    definePublicRoute({
      method: 'GET',
      path: '/v1/public/sites/:handle/events/:eventSlug',
      operationId: 'getPublicEventPage',
      summary:
        'Public microsite of an event: its published revision only. Unknown, private, unpublished and draft-only all answer 404.',
      tags: ['public'],
      idempotent: false,
      // Generous: requests arrive through the site server; edge caching and per-visitor limits
      // belong to the CDN in front of it (D1).
      rateLimit: { max: 600, timeWindow: '1 minute' },
      schemas: { params, response: { status: 200, schema: publicEventPageSchema } },
      async handler({ params: p }) {
        const found = await withTransaction(pool, {}, async (client) => {
          const { rows } = await client.query<Row>(
            'SELECT * FROM eventhub.public_event_page($1, $2)',
            [p.handle, p.eventSlug],
          );
          if (!rows[0]) return null;
          const reg = await client.query<{
            out_state: 'open' | 'not_open_yet' | 'closed' | 'full' | 'waitlist' | 'cancelled';
            out_opens_at: Date | null;
            out_closes_at: Date;
            out_privacy_policy_url: string | null;
          }>('SELECT * FROM eventhub.public_registration_state($1, $2)', [p.handle, p.eventSlug]);
          const look = await client.query<{
            out_theme: (typeof EVENT_THEMES)[number];
            out_sharing_image_id: string | null;
          }>('SELECT * FROM eventhub.public_event_presentation($1, $2)', [p.handle, p.eventSlug]);
          const cancel = await client.query<{
            out_cancelled_at: Date | null;
            out_reason: string | null;
          }>('SELECT * FROM eventhub.public_event_cancellation($1, $2)', [p.handle, p.eventSlug]);
          const q = await client.query<{ questions: unknown }>(
            'SELECT eventhub.public_registration_questions($1, $2) AS questions',
            [p.handle, p.eventSlug],
          );
          return {
            row: rows[0],
            reg: reg.rows[0]!,
            look: look.rows[0],
            cancellation: cancellationDto(cancel.rows[0]),
            questions: storedQuestions(q.rows[0]?.questions),
          };
        });
        if (!found) throw notFound('Page');
        const { row, reg, look, cancellation, questions } = found;
        return {
          status: 200,
          body: {
            handle: p.handle,
            eventSlug: p.eventSlug,
            name: row.out_event_name,
            startsAt: row.out_starts_at.toISOString(),
            endsAt: row.out_ends_at.toISOString(),
            timezone: row.out_timezone,
            venueMode: row.out_venue_mode,
            language: row.out_primary_language,
            lifecycle: row.out_lifecycle,
            indexable: row.out_visibility === 'public',
            sharing: {
              title: row.out_sharing_title,
              description: row.out_sharing_description,
              imageAssetId: look?.out_sharing_image_id ?? null,
            },
            theme: EVENT_THEMES.includes(look?.out_theme as (typeof EVENT_THEMES)[number])
              ? look!.out_theme
              : 'default',
            revision: row.out_revision,
            publishedAt: row.out_published_at.toISOString(),
            cancellation,
            sections: row.out_sections.filter((s) => s.visible),
            privacyPolicyUrl: reg.out_privacy_policy_url,
            registration: {
              state: reg.out_state,
              opensAt: reg.out_opens_at?.toISOString() ?? null,
              closesAt: reg.out_closes_at.toISOString(),
              questions,
            },
          },
        };
      },
    }),

    definePublicRoute({
      method: 'POST',
      path: '/v1/public/sites/:handle/events/:eventSlug/views',
      operationId: 'countPublicPageView',
      summary:
        'Counts one view of a public event page (ADR-0044). Called by the site server after serving the page; stores a daily count only, nothing about the visitor.',
      tags: ['public'],
      idempotent: false,
      idempotencyExempt:
        'Counts are approximate by design: a retried request counts again, like a reload.',
      // Per visitor (the site forwards the visitor's address): a reload loop cannot inflate the
      // counts much.
      rateLimit: { max: 30, timeWindow: '1 minute' },
      schemas: { params, response: { status: 204 } },
      async handler({ params: p }) {
        const counted = await withTransaction(pool, {}, async (client) => {
          const { rows } = await client.query<{ counted: boolean }>(
            'SELECT eventhub.record_public_page_view($1, $2) AS counted',
            [p.handle, p.eventSlug],
          );
          return rows[0]?.counted === true;
        });
        if (!counted) throw notFound('Page');
        return { status: 204, body: null };
      },
    }),

    definePublicRoute({
      method: 'GET',
      path: '/v1/public/sites/:handle/events/:eventSlug/calendar',
      operationId: 'getPublicEventCalendar',
      summary:
        'What an Add to calendar file needs for a public event page (ADR-0048). Same visibility as the page: everything else is 404.',
      tags: ['public'],
      idempotent: false,
      rateLimit: { max: 600, timeWindow: '1 minute' },
      schemas: { params, response: { status: 200, schema: publicEventCalendarSchema } },
      async handler({ params: p }) {
        const row = await withTransaction(pool, {}, async (client) => {
          const { rows } = await client.query<{
            out_event_id: string;
            out_version: number;
            out_updated_at: Date;
            out_event_name: string;
            out_starts_at: Date;
            out_ends_at: Date;
            out_timezone: string;
            out_venue_mode: string;
            out_description: string | null;
          }>('SELECT * FROM eventhub.public_event_calendar($1, $2)', [p.handle, p.eventSlug]);
          if (!rows[0]) return undefined;
          const c = await client.query<{ out_cancelled_at: Date | null }>(
            'SELECT out_cancelled_at FROM eventhub.public_event_cancellation($1, $2)',
            [p.handle, p.eventSlug],
          );
          return { ...rows[0], cancelled: Boolean(c.rows[0]?.out_cancelled_at) };
        });
        if (!row) throw notFound('Page');
        return {
          status: 200,
          body: {
            uid: calendarUid(row.out_event_id),
            sequence: Math.max(0, row.out_version - 1),
            updatedAt: row.out_updated_at.toISOString(),
            name: row.out_event_name,
            startsAt: row.out_starts_at.toISOString(),
            endsAt: row.out_ends_at.toISOString(),
            timezone: row.out_timezone,
            venueMode: row.out_venue_mode,
            description: row.out_description,
            cancelled: row.cancelled,
          },
        };
      },
    }),
  ];
}
