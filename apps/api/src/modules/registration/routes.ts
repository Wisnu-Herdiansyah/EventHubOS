import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, createDomainEvent, notFound, type Actor } from '@eventhub/kernel';
import {
  enqueueEvent,
  setTenantContext,
  withTransaction,
  writeAudit,
  type Pool,
  type PoolClient,
} from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { definePublicRoute, defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { slugSchema } from '../event/routes.ts';
import { emailSchema } from '../identity/password.ts';
import { withOrganization, type OrganizationAccess } from '../tenancy/access.ts';

/**
 * Free event registration (ADR-0023). Visitors sign up on the public page and cancel with the
 * emailed link; staff with registration.manage see and cancel registrations. Attendee details are
 * personal data: they never enter audit records, outbox payloads or logs.
 */
export const REGISTRATION_CONFIRMATION_REQUESTED = 'registration.confirmation_requested';
export const REGISTRATION_CANCELLED = 'registration.cancelled';

const PUBLIC_REGISTER_LIMIT = { max: 5, timeWindow: '1 minute' };
const PUBLIC_CANCEL_LIMIT = { max: 10, timeWindow: '1 minute' };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SYSTEM: Actor = { type: 'system', id: null };
/** Rows in one export (ADR-0027). Larger events need a background export. */
export const EXPORT_LIMIT = 10_000;

const handle = z.string().regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/);

const registerBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Enter your name.')
      .max(120)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f\u007f]*$/, 'Use plain text.'),
    email: emailSchema,
    privacyConsent: z.literal(true, 'Agree to the privacy policy to register.'),
    /** Honeypot: hidden from people, filled in by naive bots. Must be empty. */
    website: z.string().max(200).optional(),
  })
  .strict()
  .meta({ id: 'PublicRegistrationRequest' });

const acceptedSchema = z
  .object({ status: z.literal('accepted'), message: z.string() })
  .meta({ id: 'RegistrationAccepted' });

const ACCEPTED = {
  status: 'accepted' as const,
  message: 'Thank you. Check your email for your confirmation.',
};

const registrationSchema = z
  .object({
    id: uuid,
    name: z.string(),
    email: z.string(),
    status: z.enum(['confirmed', 'cancelled']),
    createdAt: z.iso.datetime(),
    cancelledAt: z.iso.datetime().nullable(),
    cancelledBy: z.enum(['attendee', 'organizer']).nullable(),
    /** When the attendee was checked in at the event (ADR-0028), or null. */
    checkedInAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Registration' });

const summarySchema = z
  .object({
    confirmed: z.number().int(),
    cancelled: z.number().int(),
    /** Confirmed attendees who have been checked in (ADR-0028). */
    checkedIn: z.number().int(),
    capacity: z.number().int().nullable(),
    state: z.enum(['open', 'not_open_yet', 'closed', 'full']),
    opensAt: z.iso.datetime().nullable(),
    closesAt: z.iso.datetime(),
  })
  .meta({ id: 'RegistrationSummary' });

const eventParams = z.object({ organizationId: uuid, eventId: uuid }).strict();

interface RegistrationRow {
  id: string;
  name: string;
  email: string;
  status: 'confirmed' | 'cancelled';
  created_at: Date;
  cancelled_at: Date | null;
  cancelled_by: 'attendee' | 'organizer' | null;
  checked_in_at: Date | null;
}

const toDto = (r: RegistrationRow) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  cancelledAt: r.cancelled_at?.toISOString() ?? null,
  cancelledBy: r.cancelled_by,
  checkedInAt: r.checked_in_at?.toISOString() ?? null,
});

const REGISTRATION_COLUMNS =
  'id, name, email, status, created_at, cancelled_at, cancelled_by, checked_in_at';

/** For the door: no email confirmation, just who and when (ADR-0028). */
const checkInResultSchema = z
  .object({
    id: uuid,
    status: z.enum(['confirmed', 'cancelled']),
    checkedInAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'CheckInResult' });

/** `%`, `_` and `\\` are literal in a search, not patterns. */
const likeEscape = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

async function record(
  client: PoolClient,
  organizationId: string,
  actor: Actor,
  action: string,
  registrationId: string,
  correlationId: string,
  metadata: Record<string, unknown>,
  outbox?: { eventType: string; payload: Record<string, unknown> },
): Promise<void> {
  await writeAudit(client, {
    organizationId,
    actor,
    action,
    targetType: 'registration',
    targetId: registrationId,
    correlationId,
    metadata,
  });
  if (outbox) {
    await enqueueEvent(
      client,
      createDomainEvent({
        eventType: outbox.eventType,
        schemaVersion: 1,
        actor,
        organizationId,
        aggregateType: 'registration',
        aggregateId: registrationId,
        correlationId,
        payload: { registrationId, ...outbox.payload },
      }),
    );
  }
}

export function registrationRoutes(pool: Pool): AnyRoute[] {
  return [
    definePublicRoute({
      method: 'POST',
      path: '/v1/public/sites/:handle/events/:eventSlug/registrations',
      operationId: 'registerForEvent',
      summary:
        'Register for a published event. Answers the same whether or not the address was already registered (no enumeration); 409 when registration is not open or the event is full.',
      tags: ['public'],
      idempotent: false,
      idempotencyExempt:
        'Keyed by event and email: repeating it cannot create a second registration.',
      rateLimit: PUBLIC_REGISTER_LIMIT,
      schemas: {
        params: z.object({ handle, eventSlug: slugSchema }).strict(),
        body: registerBody,
        response: { status: 202, schema: acceptedSchema },
      },
      async handler({ params, body, correlationId }) {
        // A filled honeypot looks like success and does nothing.
        if (body.website) return { status: 202, body: ACCEPTED };
        const outcome = await withTransaction(pool, {}, async (client) => {
          const { rows } = await client.query<{
            out_outcome: string;
            out_registration_id: string | null;
            out_organization_id: string | null;
            out_event_id: string | null;
          }>('SELECT * FROM eventhub.public_register($1, $2, $3, $4)', [
            params.handle,
            params.eventSlug,
            body.email,
            body.name,
          ]);
          const r = rows[0]!;
          if (r.out_registration_id && r.out_organization_id) {
            await setTenantContext(client, r.out_organization_id);
            if (r.out_outcome === 'registered') {
              await record(
                client,
                r.out_organization_id,
                SYSTEM,
                'registration.created',
                r.out_registration_id,
                correlationId,
                { eventId: r.out_event_id, source: 'public_site' },
                {
                  eventType: REGISTRATION_CONFIRMATION_REQUESTED,
                  payload: { eventId: r.out_event_id, kind: 'new' },
                },
              );
            } else if (r.out_outcome === 'already_registered') {
              // Re-send the confirmation (with a fresh cancel link) to the address itself.
              await enqueueEvent(
                client,
                createDomainEvent({
                  eventType: REGISTRATION_CONFIRMATION_REQUESTED,
                  schemaVersion: 1,
                  actor: SYSTEM,
                  organizationId: r.out_organization_id,
                  aggregateType: 'registration',
                  aggregateId: r.out_registration_id,
                  correlationId,
                  payload: {
                    registrationId: r.out_registration_id,
                    eventId: r.out_event_id,
                    kind: 'repeat',
                  },
                }),
              );
            }
          }
          return r.out_outcome;
        });
        switch (outcome) {
          case 'registered':
          case 'already_registered':
          case 'already_registered_quiet':
            return { status: 202, body: ACCEPTED };
          case 'not_open_yet':
            throw new AppError('conflict', 'Registration has not opened yet.', {
              details: { reason: 'registration_not_open' },
            });
          case 'full':
            throw new AppError('conflict', 'This event is full.', {
              details: { reason: 'event_full' },
            });
          case 'closed':
            throw new AppError('conflict', 'Registration is closed.', {
              details: { reason: 'registration_closed' },
            });
          default:
            throw notFound('Page');
        }
      },
    }),

    definePublicRoute({
      method: 'POST',
      path: '/v1/public/registrations/cancel',
      operationId: 'cancelRegistrationByLink',
      summary:
        'Cancel a registration with the link from its confirmation email. Invalid, used and stale links all answer the same.',
      tags: ['public'],
      idempotent: false,
      idempotencyExempt: 'Single-use link: a repeat finds nothing to cancel.',
      rateLimit: PUBLIC_CANCEL_LIMIT,
      schemas: {
        body: z
          .object({ token: z.string().regex(TOKEN_RE, 'Malformed link.') })
          .strict()
          .meta({ id: 'CancelRegistrationRequest' }),
        response: {
          status: 200,
          schema: z
            .object({ status: z.literal('cancelled'), eventName: z.string() })
            .meta({ id: 'RegistrationCancelled' }),
        },
      },
      async handler({ body, correlationId }) {
        const hash = createHash('sha256').update(body.token).digest();
        const result = await withTransaction(pool, {}, async (client) => {
          const { rows } = await client.query<{
            out_registration_id: string;
            out_organization_id: string;
            out_event_id: string;
            out_event_name: string;
          }>('SELECT * FROM eventhub.public_cancel_registration($1)', [hash]);
          const r = rows[0];
          if (!r) return null;
          await setTenantContext(client, r.out_organization_id);
          await record(
            client,
            r.out_organization_id,
            SYSTEM,
            'registration.cancelled',
            r.out_registration_id,
            correlationId,
            { eventId: r.out_event_id, by: 'attendee' },
            { eventType: REGISTRATION_CANCELLED, payload: { by: 'attendee' } },
          );
          return r.out_event_name;
        });
        if (result === null) {
          throw new AppError(
            'validation_failed',
            'This link is no longer valid. The registration may already be cancelled.',
            { details: { reason: 'invalid_or_used_link' } },
          );
        }
        return { status: 200, body: { status: 'cancelled', eventName: result } };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events/:eventId/registrations/summary',
      operationId: 'getRegistrationSummary',
      summary: 'Counts, capacity and whether registration is open now. No personal data.',
      tags: ['registrations'],
      requires: 'event.read',
      idempotent: false,
      schemas: { params: eventParams, response: { status: 200, schema: summarySchema } },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.read',
          async (client, access) => {
            const { rows } = await client.query<{
              confirmed: number;
              cancelled: number;
              checked_in: number;
              capacity: number | null;
              state: 'open' | 'not_open_yet' | 'closed' | 'full';
              opens_at: Date | null;
              closes_at: Date;
            }>(
              `SELECT c.confirmed, c.cancelled, c.checked_in,
                      (e.settings->'registration'->>'capacity')::int AS capacity,
                      eventhub.registration_state(e, c.confirmed, now()) AS state,
                      (e.settings->'registration'->>'opensAt')::timestamptz AS opens_at,
                      coalesce((e.settings->'registration'->>'closesAt')::timestamptz, e.ends_at)
                        AS closes_at
                 FROM eventhub.event e
                 CROSS JOIN LATERAL (
                   SELECT count(*) FILTER (WHERE r.status = 'confirmed')::int AS confirmed,
                          count(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
                          count(*) FILTER (WHERE r.status = 'confirmed'
                                             AND r.checked_in_at IS NOT NULL)::int AS checked_in
                     FROM eventhub.registration r WHERE r.event_id = e.id
                 ) c
                WHERE e.organization_id = $1 AND e.id = $2`,
              [access.organizationId, params.eventId],
            );
            const r = rows[0];
            if (!r) throw notFound('Event');
            return {
              status: 200,
              body: {
                confirmed: r.confirmed,
                cancelled: r.cancelled,
                checkedIn: r.checked_in,
                capacity: r.capacity,
                state: r.state,
                opensAt: r.opens_at?.toISOString() ?? null,
                closesAt: r.closes_at.toISOString(),
              },
            };
          },
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events/:eventId/registrations',
      operationId: 'listRegistrations',
      summary:
        'Attendees of an event, newest first (up to 1,000). Personal data: registration.manage.',
      tags: ['registrations'],
      requires: 'registration.manage',
      idempotent: false,
      schemas: {
        params: eventParams,
        query: z.object({ status: z.enum(['confirmed', 'cancelled']).optional() }).strict(),
        response: {
          status: 200,
          schema: z.object({ data: z.array(registrationSchema) }).meta({ id: 'RegistrationList' }),
        },
      },
      async handler({ principal, params, query }) {
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
            const { rows } = await client.query<RegistrationRow>(
              `SELECT ${REGISTRATION_COLUMNS}
                 FROM eventhub.registration
                WHERE organization_id = $1 AND event_id = $2
                  AND ($3::text IS NULL OR status = $3)
                ORDER BY created_at DESC, id DESC
                LIMIT 1000`,
              [access.organizationId, params.eventId, query.status ?? null],
            );
            return { status: 200, body: { data: rows.map(toDto) } };
          },
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/events/:eventId/registrations/export',
      operationId: 'exportRegistrations',
      summary:
        'All registrations of an event for download (up to 10,000), oldest first. Personal data: registration.export_pii; every export is audited.',
      tags: ['registrations'],
      requires: 'registration.export_pii',
      idempotent: false,
      idempotencyExempt:
        'The response is personal data and must not be stored in the idempotency table; a retry is another audited export.',
      schemas: {
        params: eventParams,
        body: z
          .object({ status: z.enum(['confirmed', 'cancelled']).optional() })
          .strict()
          .meta({ id: 'RegistrationExportRequest' }),
        response: {
          status: 200,
          schema: z
            .object({
              eventName: z.string(),
              eventSlug: z.string(),
              timezone: z.string(),
              generatedAt: z.iso.datetime(),
              /** More registrations exist than one export holds. */
              truncated: z.boolean(),
              data: z.array(registrationSchema),
            })
            .meta({ id: 'RegistrationExport' }),
        },
      },
      async handler({ principal, params, body, correlationId }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'registration.export_pii',
          async (client, access) => {
            const ev = await client.query<{ name: string; slug: string; timezone: string }>(
              'SELECT name, slug, timezone FROM eventhub.event WHERE organization_id = $1 AND id = $2',
              [access.organizationId, params.eventId],
            );
            const event = ev.rows[0];
            if (!event) throw notFound('Event');
            const { rows } = await client.query<RegistrationRow>(
              `SELECT ${REGISTRATION_COLUMNS}
                 FROM eventhub.registration
                WHERE organization_id = $1 AND event_id = $2
                  AND ($3::text IS NULL OR status = $3)
                ORDER BY created_at, id
                LIMIT ${EXPORT_LIMIT + 1}`,
              [access.organizationId, params.eventId, body.status ?? null],
            );
            const truncated = rows.length > EXPORT_LIMIT;
            const data = rows.slice(0, EXPORT_LIMIT).map(toDto);
            // Who exported what, and how much: never the attendees themselves.
            await writeAudit(client, {
              organizationId: access.organizationId,
              actor: { type: 'user', id: principal.userId },
              action: 'registration.exported',
              targetType: 'event',
              targetId: params.eventId,
              correlationId,
              metadata: { count: data.length, status: body.status ?? 'all', truncated },
            });
            return {
              status: 200,
              body: {
                eventName: event.name,
                eventSlug: event.slug,
                timezone: event.timezone,
                generatedAt: new Date().toISOString(),
                truncated,
                data,
              },
            };
          },
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/events/:eventId/registrations/:registrationId/cancel',
      operationId: 'cancelRegistration',
      summary: 'Cancel an attendee’s registration. The attendee is told by email.',
      tags: ['registrations'],
      requires: 'registration.manage',
      idempotent: true,
      schemas: {
        params: z.object({ organizationId: uuid, eventId: uuid, registrationId: uuid }).strict(),
        response: { status: 200, schema: registrationSchema },
      },
      async handler({ principal, params, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'registration.manage',
          (client, access: OrganizationAccess) =>
            runIdempotentCommand(
              client,
              {
                actorId: principal.userId,
                scope: idempotencyScope,
                key: idempotencyKey!,
                body: {},
              },
              async () => {
                const { rows } = await client.query<RegistrationRow>(
                  `UPDATE eventhub.registration
                      SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'organizer'
                    WHERE organization_id = $1 AND event_id = $2 AND id = $3
                      AND status = 'confirmed'
                RETURNING ${REGISTRATION_COLUMNS}`,
                  [access.organizationId, params.eventId, params.registrationId],
                );
                const row = rows[0];
                if (!row) {
                  const exists = await client.query(
                    `SELECT 1 FROM eventhub.registration
                      WHERE organization_id = $1 AND event_id = $2 AND id = $3`,
                    [access.organizationId, params.eventId, params.registrationId],
                  );
                  if (exists.rowCount === 0) throw notFound('Registration');
                  throw new AppError('conflict', 'This registration is already cancelled.', {
                    details: { reason: 'already_cancelled' },
                  });
                }
                await record(
                  client,
                  access.organizationId,
                  { type: 'user', id: access.userId },
                  'registration.cancelled',
                  row.id,
                  correlationId,
                  { eventId: params.eventId, by: 'organizer' },
                  { eventType: REGISTRATION_CANCELLED, payload: { by: 'organizer' } },
                );
                return { status: 200, body: toDto(row) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events/:eventId/check-in',
      operationId: 'searchCheckIn',
      summary:
        'Door list: confirmed attendees matching a name or email (up to 25), with check-in counts. attendee.checkin.',
      tags: ['registrations'],
      requires: 'attendee.checkin',
      idempotent: false,
      schemas: {
        params: eventParams,
        query: z
          .object({
            q: z
              .string()
              .trim()
              .max(120)
              // eslint-disable-next-line no-control-regex
              .regex(/^[^\u0000-\u001f\u007f]*$/)
              .optional(),
          })
          .strict(),
        response: {
          status: 200,
          schema: z
            .object({
              confirmed: z.number().int(),
              checkedIn: z.number().int(),
              data: z.array(registrationSchema),
            })
            .meta({ id: 'CheckInList' }),
        },
      },
      async handler({ principal, params, query }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'attendee.checkin',
          async (client, access) => {
            const counts = await client.query<{ confirmed: number; checked_in: number }>(
              `SELECT count(*) FILTER (WHERE r.status = 'confirmed')::int AS confirmed,
                      count(*) FILTER (WHERE r.status = 'confirmed'
                                         AND r.checked_in_at IS NOT NULL)::int AS checked_in
                 FROM eventhub.event e
                 LEFT JOIN eventhub.registration r
                   ON r.organization_id = e.organization_id AND r.event_id = e.id
                WHERE e.organization_id = $1 AND e.id = $2
                GROUP BY e.id`,
              [access.organizationId, params.eventId],
            );
            const c = counts.rows[0];
            if (!c) throw notFound('Event');
            const q = query.q ?? '';
            const { rows } = await client.query<RegistrationRow>(
              `SELECT ${REGISTRATION_COLUMNS}
                 FROM eventhub.registration
                WHERE organization_id = $1 AND event_id = $2 AND status = 'confirmed'
                  AND ($3 = '' OR lower(name) LIKE '%' || $4 || '%' OR email LIKE $4 || '%')
                ORDER BY lower(name), id
                LIMIT 25`,
              [access.organizationId, params.eventId, q, likeEscape(q.toLowerCase())],
            );
            return {
              status: 200,
              body: { confirmed: c.confirmed, checkedIn: c.checked_in, data: rows.map(toDto) },
            };
          },
        );
      },
    }),

    ...(['check-in', 'undo-check-in'] as const).map((action) =>
      defineRoute({
        method: 'POST',
        path: `/v1/organizations/:organizationId/events/:eventId/registrations/:registrationId/${action}`,
        operationId: action === 'check-in' ? 'checkInRegistration' : 'undoCheckInRegistration',
        summary:
          action === 'check-in'
            ? 'Check a confirmed attendee in at the door. A second check-in is refused (409).'
            : 'Undo a check-in made by mistake.',
        tags: ['registrations'],
        requires: 'attendee.checkin',
        idempotent: true,
        schemas: {
          params: z.object({ organizationId: uuid, eventId: uuid, registrationId: uuid }).strict(),
          response: { status: 200, schema: checkInResultSchema },
        },
        async handler({ principal, params, correlationId, idempotencyKey, idempotencyScope }) {
          return withOrganization(
            pool,
            principal,
            params.organizationId,
            'attendee.checkin',
            (client, access: OrganizationAccess) =>
              runIdempotentCommand(
                client,
                {
                  actorId: principal.userId,
                  scope: idempotencyScope,
                  key: idempotencyKey!,
                  body: {},
                },
                async () => {
                  // Row lock: two doors scanning the same person at once check them in once.
                  const current = await client.query<{
                    status: 'confirmed' | 'cancelled';
                    checked_in_at: Date | null;
                  }>(
                    `SELECT status, checked_in_at FROM eventhub.registration
                      WHERE organization_id = $1 AND event_id = $2 AND id = $3 FOR UPDATE`,
                    [access.organizationId, params.eventId, params.registrationId],
                  );
                  const reg = current.rows[0];
                  if (!reg) throw notFound('Registration');
                  if (action === 'check-in') {
                    if (reg.status !== 'confirmed') {
                      throw new AppError('conflict', 'This registration was cancelled.', {
                        details: { reason: 'registration_cancelled' },
                      });
                    }
                    if (reg.checked_in_at) {
                      throw new AppError('conflict', 'This attendee is already checked in.', {
                        details: { reason: 'already_checked_in' },
                      });
                    }
                  } else if (!reg.checked_in_at) {
                    throw new AppError('conflict', 'This attendee is not checked in.', {
                      details: { reason: 'not_checked_in' },
                    });
                  }
                  const { rows } = await client.query<RegistrationRow>(
                    action === 'check-in'
                      ? `UPDATE eventhub.registration SET checked_in_at = now(), checked_in_by = $4
                          WHERE organization_id = $1 AND event_id = $2 AND id = $3
                        RETURNING ${REGISTRATION_COLUMNS}`
                      : `UPDATE eventhub.registration SET checked_in_at = NULL, checked_in_by = NULL
                          WHERE organization_id = $1 AND event_id = $2 AND id = $3 AND $4::uuid IS NOT NULL
                        RETURNING ${REGISTRATION_COLUMNS}`,
                    [access.organizationId, params.eventId, params.registrationId, access.userId],
                  );
                  const row = rows[0]!;
                  await record(
                    client,
                    access.organizationId,
                    { type: 'user', id: access.userId },
                    action === 'check-in'
                      ? 'registration.checked_in'
                      : 'registration.check_in_undone',
                    row.id,
                    correlationId,
                    { eventId: params.eventId },
                  );
                  return {
                    status: 200,
                    body: {
                      id: row.id,
                      status: row.status,
                      checkedInAt: row.checked_in_at?.toISOString() ?? null,
                    },
                  };
                },
              ),
          );
        },
      }),
    ),
  ];
}
