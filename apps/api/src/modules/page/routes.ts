import { z } from 'zod';
import { AppError, createDomainEvent, notFound } from '@eventhub/kernel';
import { enqueueEvent, writeAudit, type Pool, type PoolClient } from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { withOrganization, type OrganizationAccess } from '../tenancy/access.ts';
import {
  SECTIONS_SCHEMA_VERSION,
  sectionSchema,
  sectionsSchema,
  starterSections,
  type Section,
} from './sections.ts';

/**
 * Event microsite page (ADR-0020): one editable draft per event and immutable published
 * revisions. Editing needs page.edit; publishing needs event.publish. Archived events are
 * read-only. Nothing here is publicly routable.
 */
const PAGE_KEY = 'home';

const pageParams = z.object({ organizationId: uuid, eventId: uuid }).strict();

const saveDraftBody = z
  .object({
    /** The draft version you edited; 0 when no draft has been saved yet. */
    expectedVersion: z.number().int().min(0),
    sections: sectionsSchema,
  })
  .strict()
  .meta({ id: 'SavePageDraftRequest' });

const publishBody = z
  .object({ expectedVersion: z.number().int().min(1) })
  .strict()
  .meta({ id: 'PublishPageRequest' });

const pageSchema = z
  .object({
    eventId: uuid,
    pageId: uuid.nullable(),
    key: z.string(),
    schemaVersion: z.number().int(),
    draft: z.object({
      sections: z.array(sectionSchema),
      /** 0 means nothing has been saved yet: these are the starter sections. */
      version: z.number().int(),
      updatedAt: z.string().nullable(),
    }),
    published: z.object({ revision: z.number().int(), publishedAt: z.string() }).nullable(),
    hasUnpublishedChanges: z.boolean(),
  })
  .meta({ id: 'EventPage' });

const revisionListSchema = z
  .object({
    data: z.array(
      z.object({
        revision: z.number().int(),
        publishedAt: z.string(),
        publishedByYou: z.boolean(),
        sectionCount: z.number().int(),
        visibleSectionCount: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'PageRevisionList' });

interface PageRow {
  id: string;
  draft_sections: Section[];
  draft_version: number;
  draft_updated_at: Date;
  published_revision: number | null;
  published_draft_version: number | null;
}

interface EventInfo {
  name: string;
  lifecycle: string;
}

const PAGE_COLUMNS =
  'id, draft_sections, draft_version, draft_updated_at, published_revision, published_draft_version';

function conflict(reason: string, message: string): AppError {
  return new AppError('conflict', message, { details: { reason } });
}

async function eventInfo(
  client: PoolClient,
  access: OrganizationAccess,
  eventId: string,
  lock: boolean,
): Promise<EventInfo> {
  const { rows } = await client.query<EventInfo>(
    `SELECT name, lifecycle FROM eventhub.event WHERE organization_id = $1 AND id = $2
     ${lock ? 'FOR UPDATE' : ''}`,
    [access.organizationId, eventId],
  );
  if (!rows[0]) throw notFound('Event');
  return rows[0];
}

async function loadPage(
  client: PoolClient,
  access: OrganizationAccess,
  eventId: string,
  lock: boolean,
): Promise<PageRow | undefined> {
  const { rows } = await client.query<PageRow>(
    `SELECT ${PAGE_COLUMNS} FROM eventhub.event_page
      WHERE organization_id = $1 AND event_id = $2 AND page_key = $3 ${lock ? 'FOR UPDATE' : ''}`,
    [access.organizationId, eventId, PAGE_KEY],
  );
  return rows[0];
}

async function publishedAt(client: PoolClient, row: PageRow): Promise<string | null> {
  if (!row.published_revision) return null;
  const { rows } = await client.query<{ published_at: Date }>(
    `SELECT published_at FROM eventhub.page_revision WHERE page_id = $1 AND revision = $2`,
    [row.id, row.published_revision],
  );
  return rows[0]?.published_at.toISOString() ?? null;
}

async function toPageDto(client: PoolClient, eventId: string, event: EventInfo, row?: PageRow) {
  if (!row) {
    return {
      eventId,
      pageId: null,
      key: PAGE_KEY,
      schemaVersion: SECTIONS_SCHEMA_VERSION,
      draft: { sections: starterSections(event.name), version: 0, updatedAt: null },
      published: null,
      hasUnpublishedChanges: false,
    };
  }
  const at = await publishedAt(client, row);
  return {
    eventId,
    pageId: row.id,
    key: PAGE_KEY,
    schemaVersion: SECTIONS_SCHEMA_VERSION,
    draft: {
      sections: row.draft_sections,
      version: row.draft_version,
      updatedAt: row.draft_updated_at.toISOString(),
    },
    published:
      row.published_revision && at ? { revision: row.published_revision, publishedAt: at } : null,
    hasUnpublishedChanges: row.published_draft_version !== row.draft_version,
  };
}

async function record(
  client: PoolClient,
  access: OrganizationAccess,
  correlationId: string,
  action: 'event.page_draft_saved' | 'event.page_published',
  eventId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const actor = { type: 'user' as const, id: access.userId };
  // Section counts and versions only: page text is content, not audit evidence.
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

export function pageRoutes(pool: Pool): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events/:eventId/page',
      operationId: 'getEventPage',
      summary:
        'The event microsite draft and its publication state. Before the first save, returns starter sections (version 0).',
      tags: ['pages'],
      requires: 'event.read',
      idempotent: false,
      schemas: { params: pageParams, response: { status: 200, schema: pageSchema } },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.read',
          async (client, access) => {
            const event = await eventInfo(client, access, params.eventId, false);
            const row = await loadPage(client, access, params.eventId, false);
            return { status: 200, body: await toPageDto(client, params.eventId, event, row) };
          },
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/events/:eventId/page/draft',
      operationId: 'saveEventPageDraft',
      summary:
        'Save the microsite draft (whole section list). Requires expectedVersion; archived events are read-only. Drafts are never public.',
      tags: ['pages'],
      requires: 'page.edit',
      idempotent: true,
      schemas: {
        params: pageParams,
        body: saveDraftBody,
        response: { status: 200, schema: pageSchema },
      },
      async handler({ principal, params, body, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'page.edit',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                // Locking the event serialises the first save, so two editors cannot both create it.
                const event = await eventInfo(client, access, params.eventId, true);
                if (event.lifecycle === 'archived') {
                  throw conflict(
                    'event_archived',
                    'Archived events are read-only. Restore the event to edit its page.',
                  );
                }
                const current = await loadPage(client, access, params.eventId, true);
                const currentVersion = current?.draft_version ?? 0;
                if (currentVersion !== body.expectedVersion) {
                  throw conflict(
                    'version_conflict',
                    `The page changed since you loaded it (now version ${currentVersion}). Reload and retry.`,
                  );
                }
                const sections = JSON.stringify(body.sections);
                const { rows } = current
                  ? await client.query<PageRow>(
                      `UPDATE eventhub.event_page
                          SET draft_sections = $3, draft_schema_version = $4,
                              draft_version = draft_version + 1, draft_updated_by = $5,
                              draft_updated_at = now()
                        WHERE organization_id = $1 AND id = $2
                    RETURNING ${PAGE_COLUMNS}`,
                      [
                        access.organizationId,
                        current.id,
                        sections,
                        SECTIONS_SCHEMA_VERSION,
                        access.userId,
                      ],
                    )
                  : await client.query<PageRow>(
                      `INSERT INTO eventhub.event_page
                         (organization_id, event_id, page_key, draft_sections, draft_schema_version,
                          draft_updated_by)
                       VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING ${PAGE_COLUMNS}`,
                      [
                        access.organizationId,
                        params.eventId,
                        PAGE_KEY,
                        sections,
                        SECTIONS_SCHEMA_VERSION,
                        access.userId,
                      ],
                    );
                const row = rows[0]!;
                await record(
                  client,
                  access,
                  correlationId,
                  'event.page_draft_saved',
                  params.eventId,
                  {
                    draftVersion: row.draft_version,
                    sectionCount: body.sections.length,
                  },
                );
                return { status: 200, body: await toPageDto(client, params.eventId, event, row) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/events/:eventId/page/publish',
      operationId: 'publishEventPage',
      summary:
        'Publish the saved draft as a new immutable revision. Requires the draft version you reviewed. Public routing arrives in a later phase.',
      tags: ['pages'],
      requires: 'event.publish',
      idempotent: true,
      schemas: {
        params: pageParams,
        body: publishBody,
        response: { status: 200, schema: pageSchema },
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
                const event = await eventInfo(client, access, params.eventId, true);
                if (event.lifecycle === 'archived') {
                  throw conflict(
                    'event_archived',
                    'Archived events are read-only. Restore the event to publish its page.',
                  );
                }
                const current = await loadPage(client, access, params.eventId, true);
                if (!current) {
                  throw conflict('draft_missing', 'Save the page before publishing it.');
                }
                if (current.draft_version !== body.expectedVersion) {
                  throw conflict(
                    'version_conflict',
                    `The page changed since you reviewed it (now version ${current.draft_version}). Review the latest draft and publish again.`,
                  );
                }
                if (current.published_draft_version === current.draft_version) {
                  throw conflict('nothing_to_publish', 'This draft is already published.');
                }
                if (!current.draft_sections.some((s) => s.visible)) {
                  throw conflict('page_empty', 'Show at least one section before publishing.');
                }
                const revision = (current.published_revision ?? 0) + 1;
                await client.query(
                  `INSERT INTO eventhub.page_revision
                     (organization_id, page_id, revision, sections, schema_version, draft_version,
                      published_by)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                  [
                    access.organizationId,
                    current.id,
                    revision,
                    JSON.stringify(current.draft_sections),
                    SECTIONS_SCHEMA_VERSION,
                    current.draft_version,
                    access.userId,
                  ],
                );
                const { rows } = await client.query<PageRow>(
                  `UPDATE eventhub.event_page
                      SET published_revision = $3, published_draft_version = draft_version
                    WHERE organization_id = $1 AND id = $2
                RETURNING ${PAGE_COLUMNS}`,
                  [access.organizationId, current.id, revision],
                );
                await record(
                  client,
                  access,
                  correlationId,
                  'event.page_published',
                  params.eventId,
                  {
                    revision,
                    draftVersion: current.draft_version,
                    sectionCount: current.draft_sections.length,
                  },
                );
                return {
                  status: 200,
                  body: await toPageDto(client, params.eventId, event, rows[0]),
                };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/events/:eventId/page/revisions',
      operationId: 'listEventPageRevisions',
      summary: 'Published revisions of the event microsite, newest first (up to 50).',
      tags: ['pages'],
      requires: 'event.read',
      idempotent: false,
      schemas: { params: pageParams, response: { status: 200, schema: revisionListSchema } },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.read',
          async (client, access) => {
            await eventInfo(client, access, params.eventId, false);
            const { rows } = await client.query<{
              revision: number;
              published_at: Date;
              published_by: string;
              section_count: number;
              visible_count: number;
            }>(
              `SELECT r.revision, r.published_at, r.published_by,
                      jsonb_array_length(r.sections) AS section_count,
                      (SELECT count(*)::int FROM jsonb_array_elements(r.sections) s
                        WHERE (s->>'visible')::boolean) AS visible_count
                 FROM eventhub.page_revision r
                 JOIN eventhub.event_page p ON p.id = r.page_id
                WHERE p.organization_id = $1 AND p.event_id = $2 AND p.page_key = $3
                ORDER BY r.revision DESC
                LIMIT 50`,
              [access.organizationId, params.eventId, PAGE_KEY],
            );
            return {
              status: 200,
              body: {
                data: rows.map((r) => ({
                  revision: r.revision,
                  publishedAt: r.published_at.toISOString(),
                  publishedByYou: r.published_by === access.userId,
                  sectionCount: r.section_count,
                  visibleSectionCount: r.visible_count,
                })),
              },
            };
          },
        );
      },
    }),
  ];
}
