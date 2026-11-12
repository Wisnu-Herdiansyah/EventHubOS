import { z } from 'zod';
import { AppError, createDomainEvent, notFound } from '@eventhub/kernel';
import {
  enqueueEvent,
  pgConstraint,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
  writeAudit,
  type Pool,
} from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { ianaTimeZone, languageTag, uuid } from '../../http/schemas.ts';
import { withOrganization } from '../tenancy/access.ts';
import type { ArchivableFrom } from './lifecycle.ts';
import { eventSettingsSchema, type EventSettings } from './settings.ts';

export const EVENT_LIFECYCLES = [
  'draft',
  'scheduled',
  'published',
  'live',
  'ended',
  'archived',
] as const;
export const VENUE_MODES = ['in_person', 'virtual', 'hybrid'] as const;

/**
 * Slugs that would collide with platform paths under the baseline `{domain}/{event-slug}`
 * routing convention (pending confirmation; see open decisions).
 */
export const RESERVED_EVENT_SLUGS = new Set([
  'api',
  'admin',
  'app',
  'assets',
  'static',
  'public',
  'preview',
  'draft',
  'health',
  'login',
  'logout',
  'auth',
  'oauth',
  'sso',
  'robots-txt',
  'sitemap',
  'well-known',
  'favicon-ico',
  'webhooks',
  'v1',
  'internal',
  'platform',
  'support',
  'status',
  // Public site path for cancelling a registration (ADR-0023).
  'cancel-registration',
]);

export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/,
    'Use lowercase letters, digits and single hyphens (1-64 chars).',
  )
  .refine((s) => !RESERVED_EVENT_SLUGS.has(s), 'This slug is reserved by the platform.');

const createEventBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: slugSchema,
    timezone: ianaTimeZone,
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    venueMode: z.enum(VENUE_MODES),
    primaryLanguage: languageTag,
  })
  .strict()
  .refine((b) => Date.parse(b.endsAt) > Date.parse(b.startsAt), {
    path: ['endsAt'],
    message: 'endsAt must be after startsAt.',
  })
  .meta({ id: 'CreateEventRequest' });

export const eventSchema = z
  .object({
    id: uuid,
    organizationId: uuid,
    name: z.string(),
    slug: z.string(),
    lifecycle: z.enum(EVENT_LIFECYCLES),
    timezone: z.string(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    venueMode: z.enum(VENUE_MODES),
    primaryLanguage: z.string(),
    createdAt: z.iso.datetime(),
    version: z.number().int(),
    settings: eventSettingsSchema,
    lifecycleChangedAt: z.iso.datetime().nullable(),
    archivedFrom: z.enum(['draft', 'scheduled', 'ended']).nullable(),
    /** Set once the event is cancelled (ADR-0050); final. */
    cancellation: z.object({ cancelledAt: z.iso.datetime(), reason: z.string() }).nullable(),
  })
  .meta({ id: 'Event' });

const duplicateEventBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: slugSchema,
    /** The copy's start; it keeps the original's length, and its registration window moves along. */
    startsAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .meta({ id: 'DuplicateEventRequest' });

/** Moves the registration window by the same amount as the event (ADR-0036). */
export function shiftSettings(settings: EventSettings, deltaMs: number): EventSettings {
  const reg = settings.registration;
  if (!reg || (!reg.opensAt && !reg.closesAt)) return settings;
  const shift = (iso?: string) =>
    iso === undefined ? undefined : new Date(Date.parse(iso) + deltaMs).toISOString();
  const registration = { ...reg, opensAt: shift(reg.opensAt), closesAt: shift(reg.closesAt) };
  for (const k of ['opensAt', 'closesAt'] as const) {
    if (registration[k] === undefined) delete registration[k];
  }
  return { ...settings, registration };
}

const orgParams = z.object({ organizationId: uuid }).strict();
const eventParams = z.object({ organizationId: uuid, eventId: uuid }).strict();

const CURSOR_RE = /^[A-Za-z0-9_-]{1,200}$/;
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().regex(CURSOR_RE).optional(),
    lifecycle: z.enum(EVENT_LIFECYCLES).optional(),
    /** Name or slug contains this, case-insensitive; `%` and `_` are literal. */
    q: z
      .string()
      .trim()
      .min(1)
      .max(100)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f\u007f]*$/, 'Use plain text.')
      .optional(),
    /** upcoming: not over yet; past: over (by end time, whatever the lifecycle). */
    when: z.enum(['upcoming', 'past']).optional(),
  })
  .strict();

/** `%`, `_` and `\\` are literal in a search, not patterns. */
const likeEscape = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface EventRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  lifecycle: (typeof EVENT_LIFECYCLES)[number];
  timezone: string;
  starts_at: Date;
  ends_at: Date;
  venue_mode: (typeof VENUE_MODES)[number];
  primary_language: string;
  created_at: Date;
  created_us: string;
  version: number;
  settings: EventSettings;
  lifecycle_changed_at: Date | null;
  archived_from: ArchivableFrom | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
}

export const EVENT_COLUMNS = `id, organization_id, name, slug, lifecycle, timezone, starts_at, ends_at, venue_mode,
  primary_language, created_at, version, settings, lifecycle_changed_at, archived_from,
  cancelled_at, cancellation_reason,
  (extract(epoch from created_at) * 1000000)::bigint::text AS created_us`;

export function toEventDto(r: EventRow) {
  return {
    id: r.id,
    organizationId: r.organization_id,
    name: r.name,
    slug: r.slug,
    lifecycle: r.lifecycle,
    timezone: r.timezone,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
    venueMode: r.venue_mode,
    primaryLanguage: r.primary_language,
    createdAt: r.created_at.toISOString(),
    version: r.version,
    settings: r.settings,
    lifecycleChangedAt: r.lifecycle_changed_at?.toISOString() ?? null,
    archivedFrom: r.archived_from,
    cancellation:
      r.cancelled_at && r.cancellation_reason !== null
        ? { cancelledAt: r.cancelled_at.toISOString(), reason: r.cancellation_reason }
        : null,
  };
}

/** Opaque keyset cursor (microsecond timestamp + id). Not an access control; RLS scopes rows. */
export function encodeCursor(createdUs: string, id: string): string {
  return Buffer.from(`${createdUs}.${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdUs: string; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^(\d{1,20})\.([0-9a-f-]{36})$/.exec(raw);
  if (!match || !z.uuid().safeParse(match[2]).success) {
    throw new AppError('validation_failed', 'Invalid request query.', {
      details: { fields: [{ path: 'query.cursor', message: 'Malformed cursor.' }] },
    });
  }
  return { createdUs: match[1]!, id: match[2]! };
}

export function eventRoutes(pool: Pool): AnyRoute[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/events',
      operationId: 'createEvent',
      summary: 'Create a draft event in the organization (EVT-01).',
      tags: ['events'],
      requires: 'event.create',
      idempotent: true,
      schemas: {
        params: orgParams,
        body: createEventBody,
        response: { status: 201, schema: eventSchema },
      },
      async handler({ principal, params, body, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.create',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                let row: EventRow;
                try {
                  const result = await client.query<EventRow>(
                    `INSERT INTO eventhub.event (organization_id, name, slug, timezone, starts_at, ends_at,
                                               venue_mode, primary_language, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                   RETURNING ${EVENT_COLUMNS}`,
                    [
                      access.organizationId,
                      body.name,
                      body.slug,
                      body.timezone,
                      body.startsAt,
                      body.endsAt,
                      body.venueMode,
                      body.primaryLanguage,
                      principal.userId,
                    ],
                  );
                  row = result.rows[0]!;
                } catch (error) {
                  if (
                    pgErrorCode(error) === PG_UNIQUE_VIOLATION &&
                    pgConstraint(error) === 'event_organization_id_slug_key'
                  ) {
                    throw new AppError(
                      'conflict',
                      'An event with this slug already exists in the organization.',
                      {
                        details: {
                          reason: 'event_slug_taken',
                          fields: [{ path: 'body.slug', message: 'Already in use.' }],
                        },
                      },
                    );
                  }
                  throw error;
                }
                const actor = { type: 'user' as const, id: principal.userId };
                await writeAudit(client, {
                  organizationId: access.organizationId,
                  actor,
                  action: 'event.created',
                  targetType: 'event',
                  targetId: row.id,
                  correlationId,
                  metadata: { slug: row.slug, lifecycle: row.lifecycle },
                });
                await enqueueEvent(
                  client,
                  createDomainEvent({
                    eventType: 'event.created',
                    schemaVersion: 1,
                    actor,
                    organizationId: access.organizationId,
                    aggregateType: 'event',
                    aggregateId: row.id,
                    correlationId,
                    payload: { eventId: row.id, slug: row.slug, lifecycle: row.lifecycle },
                  }),
                );
                return { status: 201, body: toEventDto(row) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/events/:eventId/duplicate',
      operationId: 'duplicateEvent',
      summary:
        'Copy an event into a new draft (ADR-0036): its details, settings and draft page, with new dates. Attendees and published pages are never copied.',
      tags: ['events'],
      requires: 'event.create',
      idempotent: true,
      schemas: {
        params: eventParams,
        body: duplicateEventBody,
        response: { status: 201, schema: eventSchema },
      },
      async handler({ principal, params, body, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.create',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                const src = await client.query<EventRow & { settings_version: number }>(
                  `SELECT ${EVENT_COLUMNS}, settings_version FROM eventhub.event
                    WHERE organization_id = $1 AND id = $2`,
                  [access.organizationId, params.eventId],
                );
                const source = src.rows[0];
                if (!source) throw notFound('Event');
                const startsAt = new Date(body.startsAt);
                const delta = startsAt.getTime() - source.starts_at.getTime();
                const endsAt = new Date(source.ends_at.getTime() + delta);
                const settings = shiftSettings(source.settings, delta);
                let row: EventRow;
                try {
                  const result = await client.query<EventRow>(
                    `INSERT INTO eventhub.event (organization_id, name, slug, timezone, starts_at, ends_at,
                                               venue_mode, primary_language, created_by, settings,
                                               settings_version)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                   RETURNING ${EVENT_COLUMNS}`,
                    [
                      access.organizationId,
                      body.name,
                      body.slug,
                      source.timezone,
                      startsAt,
                      endsAt,
                      source.venue_mode,
                      source.primary_language,
                      principal.userId,
                      JSON.stringify(settings),
                      source.settings_version,
                    ],
                  );
                  row = result.rows[0]!;
                } catch (error) {
                  if (
                    pgErrorCode(error) === PG_UNIQUE_VIOLATION &&
                    pgConstraint(error) === 'event_organization_id_slug_key'
                  ) {
                    throw new AppError(
                      'conflict',
                      'An event with this slug already exists in the organization.',
                      {
                        details: {
                          reason: 'event_slug_taken',
                          fields: [{ path: 'body.slug', message: 'Already in use.' }],
                        },
                      },
                    );
                  }
                  throw error;
                }
                // The working draft of each page, never a published revision: the copy starts
                // unpublished, and its page goes live only when someone publishes it.
                const pages = await client.query(
                  `INSERT INTO eventhub.event_page
                     (organization_id, event_id, page_key, draft_sections, draft_schema_version,
                      draft_updated_by)
                   SELECT organization_id, $3, page_key, draft_sections, draft_schema_version, $4
                     FROM eventhub.event_page
                    WHERE organization_id = $1 AND event_id = $2`,
                  [access.organizationId, source.id, row.id, principal.userId],
                );
                const actor = { type: 'user' as const, id: principal.userId };
                await writeAudit(client, {
                  organizationId: access.organizationId,
                  actor,
                  action: 'event.created',
                  targetType: 'event',
                  targetId: row.id,
                  correlationId,
                  metadata: {
                    slug: row.slug,
                    lifecycle: row.lifecycle,
                    duplicatedFrom: source.id,
                    pagesCopied: pages.rowCount ?? 0,
                  },
                });
                await enqueueEvent(
                  client,
                  createDomainEvent({
                    eventType: 'event.created',
                    schemaVersion: 1,
                    actor,
                    organizationId: access.organizationId,
                    aggregateType: 'event',
                    aggregateId: row.id,
                    correlationId,
                    payload: { eventId: row.id, slug: row.slug, lifecycle: row.lifecycle },
                  }),
                );
                return { status: 201, body: toEventDto(row) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events',
      operationId: 'listEvents',
      summary:
        'List events in the organization, newest first (cursor pagination). Filter by lifecycle, by name or slug, and by upcoming or past.',
      tags: ['events'],
      requires: 'event.read',
      idempotent: false,
      schemas: {
        params: orgParams,
        query: listQuery,
        response: {
          status: 200,
          schema: z
            .object({ data: z.array(eventSchema), nextCursor: z.string().nullable() })
            .meta({ id: 'EventList' }),
        },
      },
      async handler({ principal, params, query }) {
        const cursor = query.cursor ? decodeCursor(query.cursor) : null;
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.read',
          async (client, access) => {
            const { rows } = await client.query<EventRow>(
              `SELECT ${EVENT_COLUMNS}
               FROM eventhub.event
              WHERE organization_id = $1
                AND ($2::bigint IS NULL
                     OR (created_at, id) < (timestamptz 'epoch' + $2::bigint * interval '1 microsecond', $3::uuid))
                AND ($5::text IS NULL OR lifecycle = $5)
                AND ($6::text IS NULL OR lower(name) LIKE '%' || $6 || '%' OR slug LIKE '%' || $6 || '%')
                AND ($7::text IS NULL
                     OR ($7 = 'upcoming' AND ends_at > now())
                     OR ($7 = 'past' AND ends_at <= now()))
              ORDER BY created_at DESC, id DESC
              LIMIT $4`,
              [
                access.organizationId,
                cursor?.createdUs ?? null,
                cursor?.id ?? null,
                query.limit + 1,
                query.lifecycle ?? null,
                query.q ? likeEscape(query.q.toLowerCase()) : null,
                query.when ?? null,
              ],
            );
            const page = rows.slice(0, query.limit);
            const last = page.at(-1);
            return {
              status: 200,
              body: {
                data: page.map(toEventDto),
                nextCursor:
                  rows.length > query.limit && last ? encodeCursor(last.created_us, last.id) : null,
              },
            };
          },
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events/:eventId',
      operationId: 'getEvent',
      summary: 'Read one event in the organization.',
      tags: ['events'],
      requires: 'event.read',
      idempotent: false,
      schemas: { params: eventParams, response: { status: 200, schema: eventSchema } },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.read',
          async (client, access) => {
            // Object-level check: the event must belong to the authorized tenant (also enforced by RLS).
            const { rows } = await client.query<EventRow>(
              `SELECT ${EVENT_COLUMNS} FROM eventhub.event WHERE organization_id = $1 AND id = $2`,
              [access.organizationId, params.eventId],
            );
            if (!rows[0]) throw notFound('Event');
            return { status: 200, body: toEventDto(rows[0]) };
          },
        );
      },
    }),
  ];
}
