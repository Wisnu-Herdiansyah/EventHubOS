import { z } from 'zod';
import { AppError, SUPPORT_ROLE } from '@eventhub/kernel';
import { writeAudit, type Pool, type PoolClient } from '@eventhub/db';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { decodeCursor, encodeCursor } from '../event/routes.ts';
import { withOrganization } from '../tenancy/access.ts';
import { enqueueDataDownload } from '../notifications/data-download.ts';

/**
 * Audit log viewer (ADR-0013). Read-only view over `audit_event` for one organization. Tenant RLS
 * is the hard boundary; platform-scoped `identity.*` rows (no organization) are never visible.
 * Metadata is PII-minimised at write time (masked emails, field names only).
 */

const ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ACTION_PREFIX_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,200}$/;

const orgParams = z.object({ organizationId: uuid }).strict();

const filterFields = {
  action: z
    .string()
    .max(100)
    .regex(ACTION_RE, 'Use a full action name, e.g. event.created')
    .optional(),
  actionPrefix: z
    .string()
    .max(100)
    .regex(ACTION_PREFIX_RE, 'Use a category ending in a dot, e.g. membership.')
    .optional(),
  actorId: uuid.optional(),
  targetType: z.enum(['organization', 'membership', 'invitation', 'event']).optional(),
  targetId: uuid.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
};

interface Filters {
  action?: string | undefined;
  actionPrefix?: string | undefined;
  actorId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

function filterRules<T extends z.ZodType<Filters>>(schema: T) {
  return schema
    .refine((q) => !(q.action && q.actionPrefix), {
      path: ['actionPrefix'],
      message: 'Use either action or actionPrefix, not both.',
    })
    .refine((q) => !q.targetId || q.targetType, {
      path: ['targetType'],
      message: 'targetType is required with targetId.',
    })
    .refine((q) => !(q.from && q.to) || Date.parse(q.to) > Date.parse(q.from), {
      path: ['to'],
      message: 'to must be after from.',
    });
}

export const auditQuery = filterRules(
  z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().regex(CURSOR_RE).optional(),
      ...filterFields,
    })
    .strict(),
);

/** The audit log export (ADR-0047): the same filters, newest first, up to EXPORT_LIMIT entries. */
export const AUDIT_EXPORT_LIMIT = 10_000;
const exportBody = filterRules(z.object(filterFields).strict()).meta({
  id: 'AuditExportRequest',
});

/** Rows matching the filters, newest first, after the cursor (occurred_at, id), at most `limit`. */
async function selectAuditRows(
  client: PoolClient,
  organizationId: string,
  f: Filters,
  limit: number,
  cursor: { createdUs: string; id: string } | null,
): Promise<AuditRow[]> {
  const { rows } = await client.query<AuditRow>(
    `SELECT id, occurred_at, (extract(epoch from occurred_at) * 1000000)::bigint::text AS occurred_us,
            actor_type, actor_id, action, target_type, target_id, correlation_id, metadata
       FROM eventhub.audit_event
      WHERE organization_id = $1
        AND ($2::bigint IS NULL
             OR (occurred_at, id) < (timestamptz 'epoch' + $2::bigint * interval '1 microsecond', $3::uuid))
        AND ($4::text IS NULL OR action = $4)
        AND ($5::text IS NULL OR starts_with(action, $5))
        AND ($6::uuid IS NULL OR actor_id = $6)
        AND ($7::text IS NULL OR target_type = $7)
        AND ($8::uuid IS NULL OR target_id = $8)
        AND ($9::timestamptz IS NULL OR occurred_at >= $9)
        AND ($10::timestamptz IS NULL OR occurred_at < $10)
      ORDER BY occurred_at DESC, id DESC
      LIMIT $11`,
    [
      organizationId,
      cursor?.createdUs ?? null,
      cursor?.id ?? null,
      f.action ?? null,
      f.actionPrefix ?? null,
      f.actorId ?? null,
      f.targetType ?? null,
      f.targetId ?? null,
      f.from ?? null,
      f.to ?? null,
      limit,
    ],
  );
  return rows;
}

/** Actor emails from this tenant's memberships only (tenant-bound function), then the DTOs. */
async function toAuditDtos(client: PoolClient, organizationId: string, page: AuditRow[]) {
  const actorIds = [
    ...new Set(page.map((r) => r.actor_id).filter((id): id is string => id !== null)),
  ];
  const emails = new Map<string, string>();
  if (actorIds.length > 0) {
    const members = await client.query<{ out_user_id: string; out_email: string }>(
      `SELECT out_user_id, out_email FROM eventhub.organization_members($1)
        WHERE out_user_id = ANY($2::uuid[])`,
      [organizationId, actorIds],
    );
    for (const m of members.rows) emails.set(m.out_user_id, m.out_email);
  }
  return page.map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at.toISOString(),
    actor: {
      type: r.actor_type,
      id: r.actor_id,
      email: r.actor_id ? (emails.get(r.actor_id) ?? null) : null,
    },
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    correlationId: r.correlation_id,
    metadata: r.metadata,
  }));
}

const auditEventSchema = z
  .object({
    id: uuid,
    occurredAt: z.iso.datetime(),
    actor: z.object({
      type: z.enum(['user', 'system', 'platform_support']),
      id: uuid.nullable(),
      /** Resolved for current or former members of this organization; otherwise null. */
      email: z.string().nullable(),
    }),
    action: z.string(),
    targetType: z.string(),
    targetId: uuid.nullable(),
    correlationId: z.string(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'AuditEvent' });

interface AuditRow {
  id: string;
  occurred_at: Date;
  occurred_us: string;
  actor_type: 'user' | 'system' | 'platform_support';
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  correlation_id: string;
  metadata: Record<string, unknown>;
}

export function auditRoutes(pool: Pool): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/audit-events',
      operationId: 'listAuditEvents',
      summary:
        'Who changed what, newest first. Filter by action or category, actor, object, and time range.',
      tags: ['audit'],
      requires: 'audit.read',
      idempotent: false,
      schemas: {
        params: orgParams,
        query: auditQuery,
        response: {
          status: 200,
          schema: z
            .object({ data: z.array(auditEventSchema), nextCursor: z.string().nullable() })
            .meta({ id: 'AuditEventList' }),
        },
      },
      async handler({ principal, params, query }) {
        const cursor = query.cursor ? decodeCursor(query.cursor) : null;
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'audit.read',
          async (client, access) => {
            const rows = await selectAuditRows(
              client,
              access.organizationId,
              query,
              query.limit + 1,
              cursor,
            );
            const page = rows.slice(0, query.limit);
            const last = page.at(-1);
            return {
              status: 200,
              body: {
                data: await toAuditDtos(client, access.organizationId, page),
                nextCursor:
                  rows.length > query.limit && last
                    ? encodeCursor(last.occurred_us, last.id)
                    : null,
              },
            };
          },
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/audit-events/export',
      operationId: 'exportAuditEvents',
      summary: `The audit log for download: the same filters as the list, newest first, up to ${AUDIT_EXPORT_LIMIT.toLocaleString('en')} entries. The export is itself audited. Not for support access.`,
      tags: ['audit'],
      requires: 'audit.read',
      idempotent: false,
      idempotencyExempt:
        'A read: exporting twice gives the same entries (plus the first export’s own entry), and each export is audited.',
      rateLimit: { max: 10, timeWindow: '1 minute' },
      schemas: {
        params: orgParams,
        body: exportBody,
        response: {
          status: 200,
          schema: z
            .object({
              generatedAt: z.iso.datetime(),
              timezone: z.string(),
              data: z.array(auditEventSchema),
              /** More entries match than one export holds; the oldest are left out. */
              truncated: z.boolean(),
            })
            .meta({ id: 'AuditExport' }),
        },
      },
      async handler({ principal, params, body, correlationId }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'audit.read',
          async (client, access) => {
            // Support access (ADR-0045) is for looking, not for taking copies.
            if (access.role === SUPPORT_ROLE) {
              throw new AppError('forbidden', 'Support access cannot download the audit log.', {
                details: { reason: 'support_read_only' },
              });
            }
            const rows = await selectAuditRows(
              client,
              access.organizationId,
              body,
              AUDIT_EXPORT_LIMIT + 1,
              null,
            );
            const page = rows.slice(0, AUDIT_EXPORT_LIMIT);
            const tz = await client.query<{ timezone: string }>(
              'SELECT timezone FROM eventhub.organization WHERE id = $1',
              [access.organizationId],
            );
            // Recorded after reading, so the file does not contain its own export entry.
            await writeAudit(client, {
              organizationId: access.organizationId,
              actor: { type: 'user', id: access.userId },
              action: 'audit.exported',
              targetType: 'organization',
              targetId: access.organizationId,
              correlationId,
              metadata: {
                count: page.length,
                filters: Object.keys(body)
                  .filter((k) => body[k as keyof Filters] !== undefined)
                  .sort(),
              },
            });
            await enqueueDataDownload(client, {
              organizationId: access.organizationId,
              userId: access.userId,
              correlationId,
              what: 'audit_log',
              count: page.length,
              truncated: rows.length > AUDIT_EXPORT_LIMIT,
            });
            return {
              status: 200,
              body: {
                generatedAt: new Date().toISOString(),
                timezone: tz.rows[0]!.timezone,
                data: await toAuditDtos(client, access.organizationId, page),
                truncated: rows.length > AUDIT_EXPORT_LIMIT,
              },
            };
          },
        );
      },
    }),
  ];
}
