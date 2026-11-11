import { z } from 'zod';
import { AppError, createDomainEvent } from '@eventhub/kernel';
import { enqueueEvent, writeAudit, type Pool, type PoolClient } from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { withOrganization, type OrganizationAccess } from '../tenancy/access.ts';

/**
 * Support access (ADR-0045): an Owner or Admin lets EventHub support read the organization for a
 * limited time (at most 72 hours), read-only and without attendee data. Granting and revoking need
 * organization.manage, which the support role itself never has, so staff cannot extend their own
 * access. Every change is audited and emailed to the Owners.
 */
export const MAX_SUPPORT_HOURS = 72;
export const SUPPORT_ACCESS_CHANGED = 'organization.support_access_changed';

const params = z.object({ organizationId: uuid }).strict();

const grantSchema = z
  .object({
    id: uuid,
    grantedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    status: z.enum(['active', 'expired', 'revoked']),
    grantedByYou: z.boolean(),
  })
  .meta({ id: 'SupportGrant' });

const stateSchema = z
  .object({
    /** The grant in effect now, if any. */
    active: grantSchema.nullable(),
    /** The latest grants, newest first (up to 10), including the active one. */
    recent: z.array(grantSchema),
    maxHours: z.number().int(),
  })
  .meta({ id: 'SupportAccess' });

interface GrantRow {
  id: string;
  granted_by: string;
  granted_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

function toDto(r: GrantRow, userId: string, now = Date.now()) {
  return {
    id: r.id,
    grantedAt: r.granted_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    revokedAt: r.revoked_at?.toISOString() ?? null,
    status: r.revoked_at
      ? ('revoked' as const)
      : r.expires_at.getTime() <= now
        ? ('expired' as const)
        : ('active' as const),
    grantedByYou: r.granted_by === userId,
  };
}

const GRANT_COLUMNS = 'id, granted_by, granted_at, expires_at, revoked_at';

/** The active grant, locked (FOR UPDATE) when changing it. */
async function activeGrant(client: PoolClient, organizationId: string, lock: boolean) {
  const { rows } = await client.query<GrantRow>(
    `SELECT ${GRANT_COLUMNS} FROM eventhub.support_grant
      WHERE organization_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY expires_at DESC LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
    [organizationId],
  );
  return rows[0];
}

async function record(
  client: PoolClient,
  access: OrganizationAccess,
  correlationId: string,
  grantId: string,
  granted: boolean,
  expiresAt: Date,
): Promise<void> {
  const actor = { type: 'user' as const, id: access.userId };
  await writeAudit(client, {
    organizationId: access.organizationId,
    actor,
    action: granted ? 'organization.support_access_granted' : 'organization.support_access_revoked',
    targetType: 'support_grant',
    targetId: grantId,
    correlationId,
    metadata: { expiresAt: expiresAt.toISOString() },
  });
  await enqueueEvent(
    client,
    createDomainEvent({
      eventType: SUPPORT_ACCESS_CHANGED,
      schemaVersion: 1,
      actor,
      organizationId: access.organizationId,
      aggregateType: 'organization',
      aggregateId: access.organizationId,
      correlationId,
      payload: {
        organizationId: access.organizationId,
        granted,
        expiresAt: expiresAt.toISOString(),
      },
    }),
  );
}

export function supportRoutes(pool: Pool): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/support-access',
      operationId: 'getSupportAccess',
      summary: 'Whether EventHub support can read this organization now, and recent grants.',
      tags: ['support'],
      requires: 'organization.manage',
      idempotent: false,
      schemas: { params, response: { status: 200, schema: stateSchema } },
      async handler({ principal, params: p }) {
        return withOrganization(
          pool,
          principal,
          p.organizationId,
          'organization.manage',
          async (client, access) => {
            const { rows } = await client.query<GrantRow>(
              `SELECT ${GRANT_COLUMNS} FROM eventhub.support_grant
                WHERE organization_id = $1 ORDER BY granted_at DESC, id DESC LIMIT 10`,
              [access.organizationId],
            );
            const active = await activeGrant(client, access.organizationId, false);
            return {
              status: 200,
              body: {
                active: active ? toDto(active, access.userId) : null,
                recent: rows.map((r) => toDto(r, access.userId)),
                maxHours: MAX_SUPPORT_HOURS,
              },
            };
          },
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/support-access',
      operationId: 'grantSupportAccess',
      summary: `Let EventHub support read this organization (read-only, no attendee data) for 1–${MAX_SUPPORT_HOURS} hours. Owners are emailed.`,
      tags: ['support'],
      requires: 'organization.manage',
      idempotent: true,
      schemas: {
        params,
        body: z
          .object({ hours: z.number().int().min(1).max(MAX_SUPPORT_HOURS) })
          .strict()
          .meta({ id: 'GrantSupportAccessRequest' }),
        response: { status: 201, schema: grantSchema },
      },
      async handler({
        principal,
        params: p,
        body,
        correlationId,
        idempotencyKey,
        idempotencyScope,
      }) {
        return withOrganization(
          pool,
          principal,
          p.organizationId,
          'organization.manage',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                // One grant at a time; the lock serialises two Admins granting at once.
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
                  `support-grant:${access.organizationId}`,
                ]);
                if (await activeGrant(client, access.organizationId, true)) {
                  throw new AppError(
                    'conflict',
                    'Support access is already on. Revoke it first to change how long it lasts.',
                    { details: { reason: 'support_access_active' } },
                  );
                }
                const { rows } = await client.query<GrantRow>(
                  `INSERT INTO eventhub.support_grant (organization_id, granted_by, expires_at)
                   VALUES ($1, $2, now() + make_interval(hours => $3))
                   RETURNING ${GRANT_COLUMNS}`,
                  [access.organizationId, access.userId, body.hours],
                );
                const g = rows[0]!;
                await record(client, access, correlationId, g.id, true, g.expires_at);
                return { status: 201, body: toDto(g, access.userId) };
              },
            ),
        );
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/organizations/:organizationId/support-access/revoke',
      operationId: 'revokeSupportAccess',
      summary: 'End support access now. Owners are emailed.',
      tags: ['support'],
      requires: 'organization.manage',
      idempotent: true,
      schemas: { params, response: { status: 204 } },
      async handler({ principal, params: p, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          p.organizationId,
          'organization.manage',
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
                const active = await activeGrant(client, access.organizationId, true);
                if (!active) {
                  throw new AppError('conflict', 'Support access is not on.', {
                    details: { reason: 'no_active_support_access' },
                  });
                }
                await client.query(
                  `UPDATE eventhub.support_grant SET revoked_at = now(), revoked_by = $3
                    WHERE organization_id = $1 AND id = $2`,
                  [access.organizationId, active.id, access.userId],
                );
                await record(client, access, correlationId, active.id, false, new Date());
                return { status: 204, body: null };
              },
            ),
        );
      },
    }),
  ];
}
