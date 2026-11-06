import { z } from 'zod';
import type { Pool } from '@eventhub/db';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { decodeCursor, encodeCursor } from '../event/routes.ts';
import { withOrganization } from '../tenancy/access.ts';

/**
 * Audit log viewer (ADR-0013). Read-only view over `audit_event` for one organization. Tenant RLS
 * is the hard boundary; platform-scoped `identity.*` rows (no organization) are never visible.
 * Metadata is PII-minimised at write time (masked emails, field names only).
 */

const ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ACTION_PREFIX_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,200}$/;

const orgParams = z.object({ organizationId: uuid }).strict();

export const auditQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().regex(CURSOR_RE).optional(),
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
  })
  .strict()
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
                access.organizationId,
                cursor?.createdUs ?? null,
                cursor?.id ?? null,
                query.action ?? null,
                query.actionPrefix ?? null,
                query.actorId ?? null,
                query.targetType ?? null,
                query.targetId ?? null,
                query.from ?? null,
                query.to ?? null,
                query.limit + 1,
              ],
            );
            const page = rows.slice(0, query.limit);

            // Actor emails come from this tenant's memberships only (tenant-bound function).
            const actorIds = [
              ...new Set(page.map((r) => r.actor_id).filter((id): id is string => id !== null)),
            ];
            const emails = new Map<string, string>();
            if (actorIds.length > 0) {
              const members = await client.query<{ out_user_id: string; out_email: string }>(
                `SELECT out_user_id, out_email FROM eventhub.organization_members($1)
                WHERE out_user_id = ANY($2::uuid[])`,
                [access.organizationId, actorIds],
              );
              for (const m of members.rows) emails.set(m.out_user_id, m.out_email);
            }

            const last = page.at(-1);
            return {
              status: 200,
              body: {
                data: page.map((r) => ({
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
                })),
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
  ];
}
