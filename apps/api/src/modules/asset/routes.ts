import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AppError,
  createDomainEvent,
  notFound,
  type FieldIssue,
  type ObjectStore,
} from '@eventhub/kernel';
import {
  enqueueEvent,
  withTransaction,
  writeAudit,
  type Pool,
  type PoolClient,
} from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { defineRoute, definePublicRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { withOrganization, type OrganizationAccess } from '../tenancy/access.ts';
import { ImageRejected, MAX_UPLOAD_BYTES, processImage } from './image.ts';

/**
 * Asset library (ADR-0042): images an organization uploads once and uses on its pages.
 *
 * - Upload needs asset.manage; viewing needs event.read (everyone who can preview pages).
 * - Bytes are re-encoded before storage (image.ts) and kept behind the ObjectStore port under a
 *   server-generated key. Without a configured store, uploads and image bytes answer 503.
 * - The public route serves an image only while the current published revision of a public
 *   page uses it (eventhub.public_asset); a draft never makes an image public.
 * - Deleting is refused while a draft or a published page uses the image; otherwise the row is
 *   soft-deleted and the worker removes the bytes through the outbox.
 */
export const MAX_ASSETS_PER_ORGANIZATION = 500;
/** Base64 of the largest upload, plus padding. */
const MAX_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
const UPLOAD_BODY_LIMIT = MAX_BASE64_CHARS + 16 * 1024;
const VARIANTS = ['large', 'small'] as const;
type Variant = (typeof VARIANTS)[number];
const CONTENT_TYPE = 'image/webp';

/** One line of plain text. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f\u007f]*$/, 'Use a single line of plain text.');

const orgParams = z.object({ organizationId: uuid }).strict();
const assetParams = z.object({ organizationId: uuid, assetId: uuid }).strict();
const contentParams = z
  .object({ organizationId: uuid, assetId: uuid, variant: z.enum(VARIANTS) })
  .strict();
const publicParams = z
  .object({
    handle: z.string().regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/),
    assetId: uuid,
    variant: z.enum(VARIANTS),
  })
  .strict();

const uploadBody = z
  .object({
    name: line(200).min(1, 'Add a name.'),
    altText: line(300).default(''),
    /** The image file, base64-encoded: JPEG, PNG or WebP, up to 8 MB. */
    data: z
      .string()
      .min(4)
      .max(MAX_BASE64_CHARS, 'Images can be up to 8 MB.')
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Send the file as base64.'),
  })
  .strict()
  .meta({ id: 'UploadAssetRequest' });

const updateBody = z
  .object({ name: line(200).min(1, 'Add a name.').optional(), altText: line(300).optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.altText !== undefined, 'Change the name or the text.')
  .meta({ id: 'UpdateAssetRequest' });

const assetSchema = z
  .object({
    id: uuid,
    name: z.string(),
    /** Empty when the image is decorative. */
    altText: z.string(),
    contentType: z.literal(CONTENT_TYPE),
    /** Of the large rendition (fits 2400 px); the small one fits 480 px. */
    width: z.number().int(),
    height: z.number().int(),
    byteSize: z.number().int(),
    createdAt: z.string(),
  })
  .meta({ id: 'Asset' });

const assetListSchema = z
  .object({
    data: z.array(assetSchema),
    /** How many images an organization can keep. */
    limit: z.number().int(),
    /** False when this server has no image storage: uploads are refused. */
    uploadsAvailable: z.boolean(),
  })
  .meta({ id: 'AssetList' });

interface AssetRow {
  id: string;
  name: string;
  alt_text: string;
  content_type: typeof CONTENT_TYPE;
  width: number;
  height: number;
  byte_size: number;
  storage_key: string;
  created_at: Date;
}

const COLUMNS =
  'id, name, alt_text, content_type, width, height, byte_size, storage_key, created_at';

function toDto(r: AssetRow) {
  return {
    id: r.id,
    name: r.name,
    altText: r.alt_text,
    contentType: r.content_type,
    width: r.width,
    height: r.height,
    byteSize: r.byte_size,
    createdAt: r.created_at.toISOString(),
  };
}

export function objectKey(storageKey: string, variant: Variant): string {
  return `${storageKey}/${variant}.webp`;
}

function unavailable(): AppError {
  return new AppError('service_unavailable', 'Image uploads are not available on this server.', {
    details: { reason: 'storage_unavailable' },
  });
}

function rejected(error: ImageRejected): AppError {
  return new AppError('validation_failed', error.message, {
    details: { reason: error.reason, fields: [{ path: 'body.data', message: error.message }] },
  });
}

async function liveCount(client: PoolClient, organizationId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM eventhub.asset
      WHERE organization_id = $1 AND deleted_at IS NULL`,
    [organizationId],
  );
  return rows[0]!.n;
}

function quotaReached(): AppError {
  return new AppError(
    'conflict',
    `Your library is full (${MAX_ASSETS_PER_ORGANIZATION} images). Delete images you no longer use.`,
    { details: { reason: 'asset_limit_reached' } },
  );
}

async function record(
  client: PoolClient,
  access: OrganizationAccess,
  correlationId: string,
  action: 'asset.uploaded' | 'asset.updated' | 'asset.deleted',
  assetId: string,
  metadata: Record<string, unknown>,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const actor = { type: 'user' as const, id: access.userId };
  await writeAudit(client, {
    organizationId: access.organizationId,
    actor,
    action,
    targetType: 'asset',
    targetId: assetId,
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
      aggregateType: 'asset',
      aggregateId: assetId,
      correlationId,
      payload: { assetId, ...metadata, ...payload },
    }),
  );
}

/** Event names whose draft or current published page uses the image (at most 5). */
export async function assetUsage(
  client: PoolClient,
  organizationId: string,
  assetId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT DISTINCT e.name
       FROM eventhub.event_page p
       JOIN eventhub.event e ON e.organization_id = p.organization_id AND e.id = p.event_id
       LEFT JOIN eventhub.page_revision r
         ON r.organization_id = p.organization_id AND r.page_id = p.id
        AND r.revision = p.published_revision
      WHERE p.organization_id = $1
        AND (jsonb_path_exists(p.draft_sections, '$.** ? (@ == $id)', jsonb_build_object('id', $2::text))
             OR jsonb_path_exists(coalesce(r.sections, '[]'::jsonb), '$.** ? (@ == $id)',
                                  jsonb_build_object('id', $2::text)))
      ORDER BY e.name
      LIMIT 5`,
    [organizationId, assetId],
  );
  return rows.map((r) => r.name);
}

/**
 * Checks that every image a page uses is in the organization's library, and locks those rows
 * (FOR SHARE) until the transaction ends, so a concurrent delete waits and then sees the page
 * using them. Returns the field issues for missing images.
 */
export async function lockPageImages(
  client: PoolClient,
  organizationId: string,
  refs: Array<{ assetId: string; path: Array<string | number> }>,
  pathPrefix: string,
): Promise<FieldIssue[]> {
  if (refs.length === 0) return [];
  const ids = [...new Set(refs.map((r) => r.assetId))];
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM eventhub.asset
      WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL
      ORDER BY id
        FOR SHARE`,
    [organizationId, ids],
  );
  const found = new Set(rows.map((r) => r.id));
  return refs
    .filter((r) => !found.has(r.assetId))
    .map((r) => ({
      path: [pathPrefix, ...r.path.map(String)].join('.'),
      message: 'This image is not in the library.',
    }));
}

export function assetRoutes(pool: Pool, store: ObjectStore | null): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/assets',
      operationId: 'listAssets',
      summary: `The organization's image library, newest first (up to ${MAX_ASSETS_PER_ORGANIZATION}).`,
      tags: ['assets'],
      requires: 'event.read',
      idempotent: false,
      schemas: { params: orgParams, response: { status: 200, schema: assetListSchema } },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.read',
          async (client, access) => {
            const { rows } = await client.query<AssetRow>(
              `SELECT ${COLUMNS} FROM eventhub.asset
                WHERE organization_id = $1 AND deleted_at IS NULL
                ORDER BY created_at DESC, id DESC
                LIMIT $2`,
              [access.organizationId, MAX_ASSETS_PER_ORGANIZATION],
            );
            return {
              status: 200,
              body: {
                data: rows.map(toDto),
                limit: MAX_ASSETS_PER_ORGANIZATION,
                uploadsAvailable: store !== null,
              },
            };
          },
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/assets',
      operationId: 'uploadAsset',
      summary:
        'Upload an image (JPEG, PNG or WebP, base64, up to 8 MB). It is re-encoded as WebP without metadata.',
      tags: ['assets'],
      requires: 'asset.manage',
      idempotent: true,
      rateLimit: { max: 30, timeWindow: '1 minute' },
      bodyLimit: UPLOAD_BODY_LIMIT,
      schemas: {
        params: orgParams,
        body: uploadBody,
        response: { status: 201, schema: assetSchema },
      },
      async handler({ principal, params, body, correlationId, idempotencyKey, idempotencyScope }) {
        if (!store) throw unavailable();
        // A short first transaction: permission and room in the library, before spending CPU.
        await withOrganization(
          pool,
          principal,
          params.organizationId,
          'asset.manage',
          async (client, access) => {
            if ((await liveCount(client, access.organizationId)) >= MAX_ASSETS_PER_ORGANIZATION) {
              throw quotaReached();
            }
          },
        );
        let image;
        try {
          image = await processImage(Buffer.from(body.data, 'base64'));
        } catch (error) {
          if (error instanceof ImageRejected) throw rejected(error);
          throw error;
        }
        const processed = image;
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'asset.manage',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                // Serialises uploads per organization so the limit holds under concurrency.
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
                  `asset-quota:${access.organizationId}`,
                ]);
                if (
                  (await liveCount(client, access.organizationId)) >= MAX_ASSETS_PER_ORGANIZATION
                ) {
                  throw quotaReached();
                }
                const id = randomUUID();
                const storageKey = `organizations/${access.organizationId}/assets/${id}`;
                // Bytes first: if the commit then fails, an unreferenced object is left behind,
                // never a row without its image.
                await store.put(objectKey(storageKey, 'large'), {
                  data: processed.large.data,
                  contentType: CONTENT_TYPE,
                });
                await store.put(objectKey(storageKey, 'small'), {
                  data: processed.small.data,
                  contentType: CONTENT_TYPE,
                });
                const { rows } = await client.query<AssetRow>(
                  `INSERT INTO eventhub.asset
                     (id, organization_id, name, alt_text, content_type, width, height, byte_size,
                      storage_key, sha256, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                   RETURNING ${COLUMNS}`,
                  [
                    id,
                    access.organizationId,
                    body.name,
                    body.altText,
                    CONTENT_TYPE,
                    processed.large.width,
                    processed.large.height,
                    processed.large.data.length,
                    storageKey,
                    processed.sha256,
                    access.userId,
                  ],
                );
                // Sizes only: names and text are content, not audit evidence.
                await record(client, access, correlationId, 'asset.uploaded', id, {
                  byteSize: processed.large.data.length,
                  width: processed.large.width,
                  height: processed.large.height,
                });
                return { status: 201, body: toDto(rows[0]!) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'PATCH',
      path: '/v1/organizations/:organizationId/assets/:assetId',
      operationId: 'updateAsset',
      summary: "Rename an image or change its text alternative. Published pages don't change.",
      tags: ['assets'],
      requires: 'asset.manage',
      idempotent: true,
      schemas: {
        params: assetParams,
        body: updateBody,
        response: { status: 200, schema: assetSchema },
      },
      async handler({ principal, params, body, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'asset.manage',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                const { rows } = await client.query<AssetRow>(
                  `UPDATE eventhub.asset
                      SET name = coalesce($3, name), alt_text = coalesce($4, alt_text),
                          updated_at = now()
                    WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
                RETURNING ${COLUMNS}`,
                  [access.organizationId, params.assetId, body.name ?? null, body.altText ?? null],
                );
                if (!rows[0]) throw notFound('Image');
                await record(client, access, correlationId, 'asset.updated', params.assetId, {
                  fields: Object.keys(body).sort(),
                });
                return { status: 200, body: toDto(rows[0]) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/assets/:assetId/delete',
      operationId: 'deleteAsset',
      summary:
        'Delete an image. Refused (409 asset_in_use) while a draft or a published page uses it.',
      tags: ['assets'],
      requires: 'asset.manage',
      idempotent: true,
      schemas: { params: assetParams, response: { status: 204 } },
      async handler({ principal, params, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'asset.manage',
          (client, access) =>
            runIdempotentCommand(
              client,
              {
                actorId: principal.userId,
                scope: idempotencyScope,
                key: idempotencyKey!,
                body: {},
              },
              async () => {
                // The row lock makes a page save that uses this image wait, or makes this
                // delete wait for it and then see the page using it.
                const { rows } = await client.query<{ storage_key: string }>(
                  `SELECT storage_key FROM eventhub.asset
                    WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
                      FOR UPDATE`,
                  [access.organizationId, params.assetId],
                );
                if (!rows[0]) throw notFound('Image');
                const usedOn = await assetUsage(client, access.organizationId, params.assetId);
                if (usedOn.length > 0) {
                  throw new AppError(
                    'conflict',
                    `This image is used on ${usedOn.join(', ')}. Remove it from those pages (and publish them) first.`,
                    { details: { reason: 'asset_in_use' } },
                  );
                }
                await client.query(
                  `UPDATE eventhub.asset SET deleted_at = now(), deleted_by = $3
                    WHERE organization_id = $1 AND id = $2`,
                  [access.organizationId, params.assetId, access.userId],
                );
                await record(
                  client,
                  access,
                  correlationId,
                  'asset.deleted',
                  params.assetId,
                  {},
                  // For the worker, which removes the stored renditions.
                  { storageKey: rows[0].storage_key },
                );
                return { status: 204, body: null };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/assets/:assetId/:variant',
      operationId: 'getAssetContent',
      summary: 'The image bytes (WebP): large (fits 2400 px) or small (fits 480 px).',
      tags: ['assets'],
      requires: 'event.read',
      idempotent: false,
      schemas: {
        params: contentParams,
        response: { status: 200, contentType: CONTENT_TYPE },
      },
      async handler({ principal, params }) {
        if (!store) throw unavailable();
        const key = await withOrganization(
          pool,
          principal,
          params.organizationId,
          'event.read',
          async (client, access) => {
            const { rows } = await client.query<{ storage_key: string }>(
              `SELECT storage_key FROM eventhub.asset
                WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
              [access.organizationId, params.assetId],
            );
            return rows[0]?.storage_key ?? null;
          },
        );
        if (!key) throw notFound('Image');
        const object = await store.get(objectKey(key, params.variant));
        if (!object) throw notFound('Image');
        return {
          status: 200,
          body: object.data,
          binary: { contentType: CONTENT_TYPE, cacheControl: 'private, max-age=300' },
        };
      },
    }),

    definePublicRoute({
      method: 'GET',
      path: '/v1/public/sites/:handle/assets/:assetId/:variant',
      operationId: 'getPublicAsset',
      summary:
        'An image used on a public page (its current published revision). Anything else answers 404.',
      tags: ['public'],
      idempotent: false,
      rateLimit: { max: 1200, timeWindow: '1 minute' },
      schemas: { params: publicParams, response: { status: 200, contentType: CONTENT_TYPE } },
      async handler({ params: p }) {
        if (!store) throw notFound('Image');
        const key = await withTransaction(pool, {}, async (client) => {
          const { rows } = await client.query<{ out_storage_key: string }>(
            'SELECT * FROM eventhub.public_asset($1, $2)',
            [p.handle, p.assetId],
          );
          return rows[0]?.out_storage_key ?? null;
        });
        if (!key) throw notFound('Image');
        const object = await store.get(objectKey(key, p.variant));
        if (!object) throw notFound('Image');
        return {
          status: 200,
          body: object.data,
          // Short: unpublishing a page should stop serving its images soon (CDN rules: D1).
          binary: { contentType: CONTENT_TYPE, cacheControl: 'public, max-age=300' },
        };
      },
    }),
  ];
}
