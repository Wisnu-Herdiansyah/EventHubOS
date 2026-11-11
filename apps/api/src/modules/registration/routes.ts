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
import { answersInput, checkAnswers, questionSchema, storedQuestions } from './questions.ts';

/**
 * Free event registration (ADR-0023). Visitors sign up on the public page and cancel with the
 * emailed link; staff with registration.manage see and cancel registrations. Attendee details are
 * personal data: they never enter audit records, outbox payloads or logs.
 */
export const REGISTRATION_CONFIRMATION_REQUESTED = 'registration.confirmation_requested';
export const REGISTRATION_CANCELLED = 'registration.cancelled';

const STATUSES = ['confirmed', 'cancelled', 'waitlisted'] as const;
type Status = (typeof STATUSES)[number];

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
    /** Answers to the event's questions, by question ID (ADR-0041). */
    answers: answersInput.optional(),
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
    status: z.enum(STATUSES),
    createdAt: z.iso.datetime(),
    cancelledAt: z.iso.datetime().nullable(),
    cancelledBy: z.enum(['attendee', 'organizer']).nullable(),
    /** When the attendee was checked in at the event (ADR-0028), or null. */
    checkedInAt: z.iso.datetime().nullable(),
    /** When a waitlisted person got a seat (ADR-0035), or null. */
    promotedAt: z.iso.datetime().nullable(),
    promotedBy: z.enum(['waitlist', 'organizer']).nullable(),
    /** When a waiting person was told the waitlist closed (ADR-0038), or null. */
    waitlistClosedAt: z.iso.datetime().nullable(),
    /**
     * Answers to the registration questions (ADR-0041). Personal data: only in the attendee list
     * and export (registration.manage), never at the door.
     */
    answers: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  })
  .meta({ id: 'Registration' });

const summarySchema = z
  .object({
    confirmed: z.number().int(),
    cancelled: z.number().int(),
    /** People waiting for a seat (ADR-0035); not those told the waitlist closed (ADR-0038). */
    waitlisted: z.number().int(),
    /** Confirmed attendees who have been checked in (ADR-0028). */
    checkedIn: z.number().int(),
    capacity: z.number().int().nullable(),
    /** Whether sign-ups join a waitlist once the event is full. */
    waitlist: z.boolean(),
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
  status: Status;
  created_at: Date;
  cancelled_at: Date | null;
  cancelled_by: 'attendee' | 'organizer' | null;
  checked_in_at: Date | null;
  promoted_at: Date | null;
  promoted_by: 'waitlist' | 'organizer' | null;
  waitlist_closed_at: Date | null;
  answers: Record<string, string | boolean>;
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
  promotedAt: r.promoted_at?.toISOString() ?? null,
  promotedBy: r.promoted_by,
  waitlistClosedAt: r.waitlist_closed_at?.toISOString() ?? null,
  answers: r.answers,
});

/** For the door: the same row without the answers (data minimization, ADR-0041). */
const toDoorDto = (r: RegistrationRow) => {
  const { answers: _answers, ...rest } = toDto(r);
  return rest;
};

const REGISTRATION_COLUMNS =
  'id, name, email, status, created_at, cancelled_at, cancelled_by, checked_in_at, promoted_at, promoted_by, waitlist_closed_at, answers';

/** For the door: no email confirmation, just who and when (ADR-0028). */
const checkInResultSchema = z
  .object({
    id: uuid,
    status: z.enum(STATUSES),
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

/**
 * Gives freed seats to the waitlist in joining order (ADR-0035), recording each promotion with an
 * audit entry and a confirmation email. Call it in the same transaction as whatever freed seats
 * (a cancellation, a larger capacity), with the tenant context set.
 */
export async function fillWaitlist(
  client: PoolClient,
  organizationId: string,
  eventId: string,
  correlationId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ out_registration_id: string }>(
    'SELECT out_registration_id FROM eventhub.fill_waitlist($1, $2)',
    [organizationId, eventId],
  );
  for (const r of rows) {
    await record(
      client,
      organizationId,
      SYSTEM,
      'registration.promoted',
      r.out_registration_id,
      correlationId,
      { eventId, by: 'waitlist' },
      { eventType: REGISTRATION_CONFIRMATION_REQUESTED, payload: { eventId, kind: 'promoted' } },
    );
  }
  return rows.map((r) => r.out_registration_id);
}

export function registrationRoutes(pool: Pool): AnyRoute[] {
  return [
    definePublicRoute({
      method: 'POST',
      path: '/v1/public/sites/:handle/events/:eventSlug/registrations',
      operationId: 'registerForEvent',
      summary:
        'Register for a published event, or join its waitlist when it is full and takes one (ADR-0035). Answers the same whether or not the address was already registered or waiting (no enumeration); 409 when registration is not open or the event is full without a waitlist.',
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
          // The event's current questions decide which answers are valid (ADR-0041).
          const q = await client.query<{ questions: unknown }>(
            'SELECT eventhub.public_registration_questions($1, $2) AS questions',
            [params.handle, params.eventSlug],
          );
          const { answers, issues } = checkAnswers(
            storedQuestions(q.rows[0]?.questions),
            body.answers ?? {},
          );
          if (issues.length > 0) {
            throw new AppError('validation_failed', 'Check your answers.', {
              details: { fields: issues },
            });
          }
          const { rows } = await client.query<{
            out_outcome: string;
            out_registration_id: string | null;
            out_organization_id: string | null;
            out_event_id: string | null;
          }>('SELECT * FROM eventhub.public_register_with_answers($1, $2, $3, $4, $5)', [
            params.handle,
            params.eventSlug,
            body.email,
            body.name,
            JSON.stringify(answers),
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
            } else if (r.out_outcome === 'waitlisted') {
              await record(
                client,
                r.out_organization_id,
                SYSTEM,
                'registration.waitlisted',
                r.out_registration_id,
                correlationId,
                { eventId: r.out_event_id, source: 'public_site' },
                {
                  eventType: REGISTRATION_CONFIRMATION_REQUESTED,
                  payload: { eventId: r.out_event_id, kind: 'waitlisted' },
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
          case 'waitlisted':
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
        'Cancel a registration, or leave the waitlist, with the link from its email. Invalid, used and stale links all answer the same. A freed seat goes to the waitlist.',
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
            .object({
              status: z.literal('cancelled'),
              eventName: z.string(),
              /** The link was for a place on the waitlist, not a seat. */
              wasWaitlisted: z.boolean(),
            })
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
            out_previous_status: 'confirmed' | 'waitlisted';
          }>('SELECT * FROM eventhub.public_leave_registration($1)', [hash]);
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
            { eventId: r.out_event_id, by: 'attendee', from: r.out_previous_status },
            {
              eventType: REGISTRATION_CANCELLED,
              payload: { by: 'attendee', from: r.out_previous_status },
            },
          );
          if (r.out_previous_status === 'confirmed') {
            await fillWaitlist(client, r.out_organization_id, r.out_event_id, correlationId);
          }
          return {
            eventName: r.out_event_name,
            wasWaitlisted: r.out_previous_status === 'waitlisted',
          };
        });
        if (result === null) {
          throw new AppError(
            'validation_failed',
            'This link is no longer valid. The registration may already be cancelled.',
            { details: { reason: 'invalid_or_used_link' } },
          );
        }
        return { status: 200, body: { status: 'cancelled', ...result } };
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
              waitlisted: number;
              checked_in: number;
              capacity: number | null;
              waitlist: boolean;
              state: 'open' | 'not_open_yet' | 'closed' | 'full';
              opens_at: Date | null;
              closes_at: Date;
            }>(
              `SELECT c.confirmed, c.cancelled, c.waitlisted, c.checked_in,
                      (e.settings->'registration'->>'capacity')::int AS capacity,
                      coalesce((e.settings->'registration'->>'waitlist')::boolean, false)
                        AS waitlist,
                      eventhub.registration_state(e, c.confirmed, now()) AS state,
                      (e.settings->'registration'->>'opensAt')::timestamptz AS opens_at,
                      coalesce((e.settings->'registration'->>'closesAt')::timestamptz, e.ends_at)
                        AS closes_at
                 FROM eventhub.event e
                 CROSS JOIN LATERAL (
                   SELECT count(*) FILTER (WHERE r.status = 'confirmed')::int AS confirmed,
                          count(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
                          count(*) FILTER (WHERE r.status = 'waitlisted'
                                             AND r.waitlist_closed_at IS NULL)::int AS waitlisted,
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
                waitlisted: r.waitlisted,
                checkedIn: r.checked_in,
                capacity: r.capacity,
                waitlist: r.waitlist,
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
        'Attendees of an event, newest first (up to 1,000); the waitlist in joining order. Personal data: registration.manage.',
      tags: ['registrations'],
      requires: 'registration.manage',
      idempotent: false,
      schemas: {
        params: eventParams,
        query: z.object({ status: z.enum(STATUSES).optional() }).strict(),
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
                ORDER BY CASE WHEN $3 = 'waitlisted' THEN created_at END,
                         CASE WHEN $3 = 'waitlisted' THEN id END,
                         created_at DESC, id DESC
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
          .object({ status: z.enum(STATUSES).optional() })
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
              /** The event's current questions, for the answer columns (ADR-0041). */
              questions: z.array(questionSchema),
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
            const ev = await client.query<{
              name: string;
              slug: string;
              timezone: string;
              questions: unknown;
            }>(
              `SELECT name, slug, timezone, settings->'registration'->'questions' AS questions
                 FROM eventhub.event WHERE organization_id = $1 AND id = $2`,
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
                questions: storedQuestions(event.questions),
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
      summary:
        'Cancel an attendee’s registration or remove someone from the waitlist. They are told by email; a freed seat goes to the waitlist.',
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
                // Event first, then the entry: the lock order of every path that changes seats.
                await client.query(
                  'SELECT 1 FROM eventhub.event WHERE organization_id = $1 AND id = $2 FOR UPDATE',
                  [access.organizationId, params.eventId],
                );
                const current = await client.query<{ status: Status }>(
                  `SELECT status FROM eventhub.registration
                    WHERE organization_id = $1 AND event_id = $2 AND id = $3 FOR UPDATE`,
                  [access.organizationId, params.eventId, params.registrationId],
                );
                const previous = current.rows[0]?.status;
                if (!previous) throw notFound('Registration');
                if (previous === 'cancelled') {
                  throw new AppError('conflict', 'This registration is already cancelled.', {
                    details: { reason: 'already_cancelled' },
                  });
                }
                const { rows } = await client.query<RegistrationRow>(
                  `UPDATE eventhub.registration
                      SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'organizer'
                    WHERE organization_id = $1 AND event_id = $2 AND id = $3
                RETURNING ${REGISTRATION_COLUMNS}`,
                  [access.organizationId, params.eventId, params.registrationId],
                );
                const row = rows[0]!;
                await record(
                  client,
                  access.organizationId,
                  { type: 'user', id: access.userId },
                  'registration.cancelled',
                  row.id,
                  correlationId,
                  { eventId: params.eventId, by: 'organizer', from: previous },
                  {
                    eventType: REGISTRATION_CANCELLED,
                    payload: { by: 'organizer', from: previous },
                  },
                );
                if (previous === 'confirmed') {
                  await fillWaitlist(client, access.organizationId, params.eventId, correlationId);
                }
                return { status: 200, body: toDto(row) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/events/:eventId/registrations/:registrationId/promote',
      operationId: 'promoteRegistration',
      summary:
        'Give a seat to someone on the waitlist, out of turn and even beyond capacity (ADR-0035). They are emailed their confirmation.',
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
                // The event lock orders this with sign-ups and automatic promotions.
                const ev = await client.query<{ capacity: number | null }>(
                  `SELECT (settings->'registration'->>'capacity')::int AS capacity
                     FROM eventhub.event WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
                  [access.organizationId, params.eventId],
                );
                const event = ev.rows[0];
                if (!event) throw notFound('Registration');
                const { rows } = await client.query<RegistrationRow>(
                  `UPDATE eventhub.registration
                      SET status = 'confirmed', promoted_at = now(), promoted_by = 'organizer'
                    WHERE organization_id = $1 AND event_id = $2 AND id = $3
                      AND status = 'waitlisted'
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
                  throw new AppError('conflict', 'This person is not on the waitlist.', {
                    details: { reason: 'not_waitlisted' },
                  });
                }
                const confirmed = await client.query<{ n: number }>(
                  `SELECT count(*)::int AS n FROM eventhub.registration
                    WHERE organization_id = $1 AND event_id = $2 AND status = 'confirmed'`,
                  [access.organizationId, params.eventId],
                );
                const overCapacity =
                  event.capacity !== null && confirmed.rows[0]!.n > event.capacity;
                await record(
                  client,
                  access.organizationId,
                  { type: 'user', id: access.userId },
                  'registration.promoted',
                  row.id,
                  correlationId,
                  { eventId: params.eventId, by: 'organizer', overCapacity },
                  {
                    eventType: REGISTRATION_CONFIRMATION_REQUESTED,
                    payload: { eventId: params.eventId, kind: 'promoted' },
                  },
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
        'Door list: confirmed attendees matching a name or email (up to 25), or the one registration a scanned ticket names (any status), with check-in counts. attendee.checkin.',
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
            /** A scanned ticket: the registration ID from the QR code (ADR-0029). */
            ticket: uuid.optional(),
          })
          .strict()
          .refine((v) => !(v.q && v.ticket), { message: 'Search by name or by ticket, not both.' }),
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
            if (query.ticket) {
              // Any status, so the door can say "cancelled"; only this organization's event.
              const t = await client.query<RegistrationRow>(
                `SELECT ${REGISTRATION_COLUMNS} FROM eventhub.registration
                  WHERE organization_id = $1 AND event_id = $2 AND id = $3`,
                [access.organizationId, params.eventId, query.ticket],
              );
              return {
                status: 200,
                body: {
                  confirmed: c.confirmed,
                  checkedIn: c.checked_in,
                  data: t.rows.map(toDoorDto),
                },
              };
            }
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
              body: { confirmed: c.confirmed, checkedIn: c.checked_in, data: rows.map(toDoorDto) },
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
                    status: Status;
                    checked_in_at: Date | null;
                  }>(
                    `SELECT status, checked_in_at FROM eventhub.registration
                      WHERE organization_id = $1 AND event_id = $2 AND id = $3 FOR UPDATE`,
                    [access.organizationId, params.eventId, params.registrationId],
                  );
                  const reg = current.rows[0];
                  if (!reg) throw notFound('Registration');
                  if (action === 'check-in') {
                    if (reg.status === 'waitlisted') {
                      throw new AppError('conflict', 'This person is on the waitlist.', {
                        details: { reason: 'registration_waitlisted' },
                      });
                    }
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
