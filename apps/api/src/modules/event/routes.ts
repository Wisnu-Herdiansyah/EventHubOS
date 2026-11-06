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
]);

const slugSchema = z
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

const eventSchema = z
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
  })
  .meta({ id: 'Event' });

const orgParams = z.object({ organizationId: uuid }).strict();
const eventParams = z.object({ organizationId: uuid, eventId: uuid }).strict();

const CURSOR_RE = /^[A-Za-z0-9_-]{1,200}$/;
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().regex(CURSOR_RE).optional(),
  })
  .strict();

interface EventRow {
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
}

const EVENT_COLUMNS = `id, organization_id, name, slug, lifecycle, timezone, starts_at, ends_at, venue_mode,
  primary_language, created_at, version,
  (extract(epoch from created_at) * 1000000)::bigint::text AS created_us`;

function toEventDto(r: EventRow) {
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
      method: 'GET',
      path: '/v1/organizations/:organizationId/events',
      operationId: 'listEvents',
      summary: 'List events in the organization, newest first (cursor pagination).',
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
              ORDER BY created_at DESC, id DESC
              LIMIT $4`,
              [
                access.organizationId,
                cursor?.createdUs ?? null,
                cursor?.id ?? null,
                query.limit + 1,
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
