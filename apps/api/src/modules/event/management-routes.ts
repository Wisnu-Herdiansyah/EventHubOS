import { z } from 'zod';
import { ANNOUNCEMENT_MAX_RECIPIENTS } from '../announcement/routes.ts';
import { createAnnouncement } from '../announcement/send.ts';
import { lockPageImages } from '../asset/routes.ts';
import {
  AppError,
  createDomainEvent,
  notFound,
  roleHasPermission,
  type FieldIssue,
} from '@eventhub/kernel';
import {
  enqueueEvent,
  pgConstraint,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
  writeAudit,
  type Pool,
  type PoolClient,
} from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { ianaTimeZone, languageTag, uuid } from '../../http/schemas.ts';
import { fillWaitlist } from '../registration/routes.ts';
import { withOrganization, type OrganizationAccess } from '../tenancy/access.ts';
import { buildChecklist, evaluateForScheduling } from './checklist.ts';
import { checkTransition, LIFECYCLES, TRANSITIONS, type Lifecycle } from './lifecycle.ts';
import {
  EVENT_COLUMNS,
  eventSchema,
  slugSchema,
  toEventDto,
  VENUE_MODES,
  type EventRow,
} from './routes.ts';
import {
  applySettingsPatch,
  eventSettingsPatchSchema,
  settingsIssues,
  SETTINGS_VERSION,
} from './settings.ts';

const eventParams = z.object({ organizationId: uuid, eventId: uuid }).strict();

const updateEventBody = z
  .object({
    expectedVersion: z.number().int().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    slug: slugSchema.optional(),
    timezone: ianaTimeZone.optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
    venueMode: z.enum(VENUE_MODES).optional(),
    primaryLanguage: languageTag.optional(),
    settings: eventSettingsPatchSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).some((k) => k !== 'expectedVersion'), {
    message: 'Provide at least one field to change.',
  })
  .meta({ id: 'UpdateEventRequest' });

const transitionBody = z
  .object({
    to: z.enum(LIFECYCLES),
    expectedVersion: z.number().int().min(1),
    acknowledgedWarnings: z.array(z.string().max(64)).max(20).default([]),
  })
  .strict()
  .meta({ id: 'EventTransitionRequest' });

const checklistSchema = z
  .object({
    eventId: uuid,
    lifecycle: z.enum(LIFECYCLES),
    version: z.number().int(),
    items: z.array(
      z.object({
        id: z.string(),
        severity: z.enum(['blocking', 'recommended']),
        complete: z.boolean(),
        message: z.string(),
      }),
    ),
    canSchedule: z.boolean(),
    availableTransitions: z.array(z.enum(LIFECYCLES)),
    /** What the public site needs (ADR-0021): a published page revision and an org handle. */
    publicSite: z.object({
      pagePublished: z.boolean(),
      handle: z.string().nullable(),
      eventSlug: z.string(),
    }),
  })
  .meta({ id: 'EventChecklist' });

function conflict(reason: string, message: string, fields?: FieldIssue[]): AppError {
  return new AppError('conflict', message, { details: { reason, ...(fields ? { fields } : {}) } });
}

async function lockEvent(
  client: PoolClient,
  access: OrganizationAccess,
  eventId: string,
): Promise<EventRow> {
  const { rows } = await client.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM eventhub.event WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
    [access.organizationId, eventId],
  );
  if (!rows[0]) throw notFound('Event');
  return rows[0];
}

function assertVersion(row: EventRow, expected: number): void {
  if (row.version !== expected) {
    throw conflict(
      'version_conflict',
      `The event changed since you loaded it (now version ${row.version}). Reload and retry.`,
    );
  }
}

function checklistFor(row: Pick<EventRow, 'name' | 'starts_at' | 'settings'>) {
  return buildChecklist({
    name: row.name,
    startsAt: row.starts_at,
    settings: row.settings,
    now: new Date(),
  });
}

function checklistFields(ids: string[], items: ReturnType<typeof checklistFor>): FieldIssue[] {
  return ids.map((id) => ({
    path: `checklist.${id}`,
    message: items.find((i) => i.id === id)?.message ?? id,
  }));
}

async function record(
  client: PoolClient,
  access: OrganizationAccess,
  correlationId: string,
  action: 'event.updated' | 'event.lifecycle_changed' | 'event.cancelled',
  eventId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const actor = { type: 'user' as const, id: access.userId };
  await writeAudit(client, {
    organizationId: access.organizationId,
    actor,
    action,
    targetType: 'event',
    targetId: eventId,
    correlationId,
    metadata,
  });
  await enqueueEvent(
    client,
    createDomainEvent({
      eventType: action,
      schemaVersion: 1,
      actor,
      organizationId: access.organizationId,
      aggregateType: 'event',
      aggregateId: eventId,
      correlationId,
      payload: { eventId, ...metadata },
    }),
  );
}

/**
 * Going public (ADR-0021): the required checklist still holds, the event is not private, a page
 * revision is published, and the organization has a public handle to address the site.
 */
async function assertPublishable(
  client: PoolClient,
  access: OrganizationAccess,
  row: EventRow,
): Promise<void> {
  const items = checklistFor(row);
  const { blockingIncomplete } = evaluateForScheduling(items, []);
  if (blockingIncomplete.length > 0) {
    throw conflict(
      'checklist_blocking',
      'Complete the required setup items before publishing.',
      checklistFields(blockingIncomplete, items),
    );
  }
  if ((row.settings as { visibility?: string }).visibility === 'private') {
    throw conflict(
      'event_private',
      'Private events have no public site. Change the visibility to Public or Unlisted first.',
    );
  }
  const { rows } = await client.query<{ published: boolean; handle: string | null }>(
    `SELECT EXISTS (SELECT 1 FROM eventhub.event_page p
                     WHERE p.organization_id = $1 AND p.event_id = $2
                       AND p.published_revision IS NOT NULL) AS published,
            (SELECT public_handle FROM eventhub.organization WHERE id = $1) AS handle`,
    [access.organizationId, row.id],
  );
  if (!rows[0]?.published) {
    throw conflict('page_not_published', 'Publish a revision of the microsite page first.');
  }
  if (!rows[0].handle) {
    throw conflict(
      'public_handle_missing',
      'Choose a public address for the organization in Settings first.',
    );
  }
}

/** Events that can be cancelled (ADR-0050): announced, not over, not drafts. */
const CANCELLABLE: readonly Lifecycle[] = ['scheduled', 'published', 'live'];

const cancelEventBody = z
  .object({
    expectedVersion: z.number().int().min(1),
    /** Shown on the public page and in the email. */
    reason: z.string().trim().min(1).max(2000),
    /** Email everyone registered or waiting (needs communication.send). */
    notifyAttendees: z.boolean(),
  })
  .strict()
  .meta({ id: 'CancelEventRequest' });

export function eventManagementRoutes(pool: Pool): AnyRoute[] {
  return [
    defineRoute({
      method: 'PATCH',
      path: '/v1/organizations/:organizationId/events/:eventId',
      operationId: 'updateEvent',
      summary:
        'Update event details and settings (EVT-02). Requires expectedVersion; archived events are read-only.',
      tags: ['events'],
      requires: 'event.update',
      idempotent: true,
      schemas: {
        params: eventParams,
        body: updateEventBody,
        response: { status: 200, schema: eventSchema },
      },
      async handler({ principal, params, body, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.update',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                const row = await lockEvent(client, access, params.eventId);
                if (row.lifecycle === 'archived') {
                  throw conflict(
                    'event_archived',
                    'Archived events are read-only. Restore the event to edit it.',
                  );
                }
                // ADR-0050: cancellation is final; the page can still be edited to explain.
                if (row.cancelled_at) {
                  throw conflict(
                    'event_cancelled',
                    'This event is cancelled and can no longer change.',
                  );
                }
                assertVersion(row, body.expectedVersion);
                if (
                  body.slug !== undefined &&
                  body.slug !== row.slug &&
                  row.lifecycle !== 'draft'
                ) {
                  throw conflict(
                    'slug_locked',
                    'The slug can only change while the event is a draft.',
                  );
                }

                const settings = applySettingsPatch(row.settings, body.settings ?? {});
                // The sharing image must be in this organization's library (ADR-0046); the row
                // stays locked until commit, so it cannot be deleted meanwhile.
                const sharingImage = settings.sharing?.imageAssetId;
                if (body.settings?.sharing && sharingImage) {
                  const missing = await lockPageImages(
                    client,
                    access.organizationId,
                    [{ assetId: sharingImage, path: ['settings', 'sharing', 'imageAssetId'] }],
                    'body',
                  );
                  if (missing.length > 0) {
                    throw new AppError(
                      'validation_failed',
                      'The sharing image is not in the library.',
                      {
                        details: { fields: missing },
                      },
                    );
                  }
                }
                const startsAt = body.startsAt ? new Date(body.startsAt) : row.starts_at;
                const endsAt = body.endsAt ? new Date(body.endsAt) : row.ends_at;
                const issues = settingsIssues(settings, { startsAt, endsAt });
                if (issues.length > 0) {
                  throw new AppError('validation_failed', 'The event settings are inconsistent.', {
                    details: { fields: issues },
                  });
                }
                // A scheduled or public event must keep satisfying the blocking checklist.
                if (['scheduled', 'published', 'live'].includes(row.lifecycle)) {
                  const items = checklistFor({
                    name: body.name ?? row.name,
                    starts_at: startsAt,
                    settings,
                  });
                  const { blockingIncomplete } = evaluateForScheduling(items, []);
                  if (blockingIncomplete.length > 0) {
                    throw conflict(
                      'checklist_regression',
                      'This change would break a required setup item for a scheduled event. Unschedule it first.',
                      checklistFields(blockingIncomplete, items),
                    );
                  }
                }

                const changes: Record<string, unknown> = {
                  name: body.name,
                  slug: body.slug,
                  timezone: body.timezone,
                  starts_at: body.startsAt,
                  ends_at: body.endsAt,
                  venue_mode: body.venueMode,
                  primary_language: body.primaryLanguage,
                };
                const columns = Object.entries(changes).filter(([, v]) => v !== undefined);
                const fields = [
                  ...columns.map(([k]) => k),
                  ...(body.settings ? Object.keys(body.settings).map((k) => `settings.${k}`) : []),
                ];
                const assignments = [
                  ...columns.map(([k], i) => `${k} = $${i + 3}`),
                  `settings = $${columns.length + 3}`,
                  `settings_version = $${columns.length + 4}`,
                ];
                let updated: EventRow;
                try {
                  const r = await client.query<EventRow>(
                    `UPDATE eventhub.event SET ${assignments.join(', ')}
                    WHERE organization_id = $1 AND id = $2
                    RETURNING ${EVENT_COLUMNS}`,
                    [
                      access.organizationId,
                      row.id,
                      ...columns.map(([, v]) => v),
                      JSON.stringify(settings),
                      SETTINGS_VERSION,
                    ],
                  );
                  updated = r.rows[0]!;
                } catch (error) {
                  if (
                    pgErrorCode(error) === PG_UNIQUE_VIOLATION &&
                    pgConstraint(error) === 'event_organization_id_slug_key'
                  ) {
                    throw conflict(
                      'event_slug_taken',
                      'An event with this slug already exists in the organization.',
                    );
                  }
                  throw error;
                }
                // Field names only: values may contain contact details.
                await record(client, access, correlationId, 'event.updated', row.id, { fields });
                // A larger (or removed) capacity frees seats for the waitlist (ADR-0035).
                if (body.settings?.registration !== undefined) {
                  await fillWaitlist(client, access.organizationId, row.id, correlationId);
                }
                return { status: 200, body: toEventDto(updated) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events/:eventId/checklist',
      operationId: 'getEventChecklist',
      summary:
        'Setup checklist (EVT-03): blocking and recommended items, and the transitions you may make now.',
      tags: ['events'],
      requires: 'event.read',
      idempotent: false,
      schemas: { params: eventParams, response: { status: 200, schema: checklistSchema } },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.read',
          async (client, access) => {
            const { rows } = await client.query<EventRow>(
              `SELECT ${EVENT_COLUMNS} FROM eventhub.event WHERE organization_id = $1 AND id = $2`,
              [access.organizationId, params.eventId],
            );
            const row = rows[0];
            if (!row) throw notFound('Event');
            const items = checklistFor(row);
            const { blockingIncomplete } = evaluateForScheduling(items, []);
            const site = await client.query<{ published: boolean; handle: string | null }>(
              `SELECT EXISTS (SELECT 1 FROM eventhub.event_page p
                               WHERE p.organization_id = $1 AND p.event_id = $2
                                 AND p.published_revision IS NOT NULL) AS published,
                      (SELECT public_handle FROM eventhub.organization WHERE id = $1) AS handle`,
              [access.organizationId, row.id],
            );
            const permitted = TRANSITIONS.filter(
              (t) =>
                t.from === row.lifecycle &&
                roleHasPermission(access.role, t.permission) &&
                checkTransition(row.lifecycle, t.to, row.archived_from).ok,
            ).map((t) => t.to);
            return {
              status: 200,
              body: {
                eventId: row.id,
                lifecycle: row.lifecycle,
                version: row.version,
                items,
                canSchedule: row.lifecycle === 'draft' && blockingIncomplete.length === 0,
                availableTransitions: permitted,
                publicSite: {
                  pagePublished: site.rows[0]?.published ?? false,
                  handle: site.rows[0]?.handle ?? null,
                  eventSlug: row.slug,
                },
              },
            };
          },
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/events/:eventId/cancel',
      operationId: 'cancelEvent',
      summary:
        'Cancel a scheduled, published or live event (ADR-0050). Final: registration closes, the public page and calendar file say it is cancelled, and everyone registered or waiting can be emailed the reason.',
      tags: ['events'],
      requires: 'event.publish',
      idempotent: true,
      schemas: {
        params: eventParams,
        body: cancelEventBody,
        response: { status: 200, schema: eventSchema },
      },
      async handler({ principal, params, body, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.publish',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                const row = await lockEvent(client, access, params.eventId);
                if (row.cancelled_at) {
                  throw conflict('event_cancelled', 'This event is already cancelled.');
                }
                if (!CANCELLABLE.includes(row.lifecycle)) {
                  throw conflict(
                    'not_cancellable',
                    row.lifecycle === 'draft'
                      ? 'Draft events are not public: archive the event instead.'
                      : `A ${row.lifecycle} event cannot be cancelled.`,
                  );
                }
                assertVersion(row, body.expectedVersion);
                if (body.notifyAttendees && !roleHasPermission(access.role, 'communication.send')) {
                  throw new AppError(
                    'forbidden',
                    'You do not have permission to email attendees.',
                    {
                      details: { reason: 'missing_permission:communication.send' },
                    },
                  );
                }
                const count = await client.query<{ n: number }>(
                  `SELECT count(*)::int AS n FROM eventhub.registration
                    WHERE organization_id = $1 AND event_id = $2
                      AND status IN ('confirmed', 'waitlisted')`,
                  [access.organizationId, row.id],
                );
                const people = count.rows[0]!.n;
                if (body.notifyAttendees && people > ANNOUNCEMENT_MAX_RECIPIENTS) {
                  throw conflict(
                    'too_many_recipients',
                    `The cancellation email can reach at most ${ANNOUNCEMENT_MAX_RECIPIENTS.toLocaleString('en')} people for now.`,
                  );
                }
                const reason = body.reason.replace(/\r\n?/g, '\n');
                const { rows } = await client.query<EventRow>(
                  `UPDATE eventhub.event
                      SET cancelled_at = now(), cancelled_by = $3, cancellation_reason = $4
                    WHERE organization_id = $1 AND id = $2
                    RETURNING ${EVENT_COLUMNS}`,
                  [access.organizationId, row.id, access.userId, reason],
                );
                // The cancellation email tells waitlisted people too; the waitlist sweep must not
                // send them a second, different email (ADR-0038).
                await client.query(
                  `UPDATE eventhub.registration SET waitlist_closed_at = now()
                    WHERE organization_id = $1 AND event_id = $2
                      AND status = 'waitlisted' AND waitlist_closed_at IS NULL`,
                  [access.organizationId, row.id],
                );
                let notified = 0;
                if (body.notifyAttendees && people > 0) {
                  // Not counted against the daily announcement limit: people must hear of this.
                  notified = (
                    await createAnnouncement(client, {
                      organizationId: access.organizationId,
                      eventId: row.id,
                      userId: access.userId,
                      correlationId,
                      subject: 'This event is cancelled',
                      body: [
                        reason,
                        '',
                        'Your registration needs nothing more from you. Please don’t come to the venue.',
                      ].join('\n'),
                      audience: 'registered_and_waitlist',
                      purpose: 'cancellation',
                    })
                  ).recipients;
                }
                await record(client, access, correlationId, 'event.cancelled', row.id, {
                  lifecycle: row.lifecycle,
                  notified,
                });
                return { status: 200, body: toEventDto(rows[0]!) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/events/:eventId/transitions',
      operationId: 'transitionEvent',
      summary:
        'Move an event through its lifecycle. Scheduling runs the checklist; recommendations must be acknowledged.',
      tags: ['events'],
      // Entry needs event.read; each transition then requires its own permission (event.publish/archive).
      requires: 'event.read',
      idempotent: true,
      schemas: {
        params: eventParams,
        body: transitionBody,
        response: { status: 200, schema: eventSchema },
      },
      async handler({ principal, params, body, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.read',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                const row = await lockEvent(client, access, params.eventId);
                const from: Lifecycle = row.lifecycle;
                const check = checkTransition(from, body.to, row.archived_from);
                if (!check.ok) {
                  const messages = {
                    invalid_transition: `An event cannot move from ${from} to ${body.to}.`,
                    restore_target_mismatch: `This archived event can only be restored to ${row.archived_from === 'ended' ? 'ended' : 'draft'}.`,
                  } as const;
                  throw conflict(check.reason, messages[check.reason]);
                }
                if (!roleHasPermission(access.role, check.rule.permission)) {
                  throw new AppError(
                    'forbidden',
                    'You do not have permission to perform this action.',
                    {
                      details: { reason: `missing_permission:${check.rule.permission}` },
                    },
                  );
                }
                assertVersion(row, body.expectedVersion);

                let acknowledged: string[] = [];
                if (check.rule.requiresChecklist) {
                  const items = checklistFor(row);
                  const evaluation = evaluateForScheduling(items, body.acknowledgedWarnings);
                  if (evaluation.blockingIncomplete.length > 0) {
                    throw conflict(
                      'checklist_blocking',
                      'Complete the required setup items before scheduling.',
                      checklistFields(evaluation.blockingIncomplete, items),
                    );
                  }
                  if (evaluation.unacknowledgedWarnings.length > 0) {
                    throw conflict(
                      'warnings_unacknowledged',
                      'Acknowledge the recommended setup items you are skipping.',
                      checklistFields(evaluation.unacknowledgedWarnings, items),
                    );
                  }
                  acknowledged = items
                    .filter((i) => i.severity === 'recommended' && !i.complete)
                    .map((i) => i.id);
                }

                if (check.rule.requiresPublicPage) {
                  await assertPublishable(client, access, row);
                }

                const { rows } = await client.query<EventRow>(
                  `UPDATE eventhub.event
                    SET lifecycle = $3, lifecycle_changed_at = now(),
                        archived_from = CASE WHEN $3 = 'archived' THEN $4 ELSE NULL END
                  WHERE organization_id = $1 AND id = $2
                  RETURNING ${EVENT_COLUMNS}`,
                  [access.organizationId, row.id, body.to, from],
                );
                await record(client, access, correlationId, 'event.lifecycle_changed', row.id, {
                  from,
                  to: body.to,
                  acknowledgedWarnings: acknowledged,
                });
                return { status: 200, body: toEventDto(rows[0]!) };
              },
            ),
        );
      },
    }),
  ];
}
