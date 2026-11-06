import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, createDomainEvent, ROLES } from '@eventhub/kernel';
import { enqueueEvent, withTransaction, writeAudit, type Pool } from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { ianaTimeZone, languageTag, uuid } from '../../http/schemas.ts';
import { withOrganization } from '../tenancy/access.ts';

const createOrganizationBody = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    legalName: z.string().trim().min(1).max(300).optional(),
    locale: languageTag,
    timezone: ianaTimeZone,
  })
  .strict()
  .meta({ id: 'CreateOrganizationRequest' });

const organizationSchema = z
  .object({
    id: uuid,
    displayName: z.string(),
    legalName: z.string().nullable(),
    locale: z.string(),
    timezone: z.string(),
    status: z.enum(['active', 'suspended', 'pending_deletion']),
    role: z.enum(ROLES),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Organization' });

const membershipSummarySchema = z
  .object({ organizationId: uuid, displayName: z.string(), role: z.enum(ROLES) })
  .meta({ id: 'OrganizationMembershipSummary' });

const orgParams = z.object({ organizationId: uuid }).strict();

interface OrganizationRow {
  id: string;
  display_name: string;
  legal_name: string | null;
  locale: string;
  timezone: string;
  status: 'active' | 'suspended' | 'pending_deletion';
  created_at: Date;
}

function toOrganizationDto(row: OrganizationRow, role: (typeof ROLES)[number]) {
  return {
    id: row.id,
    displayName: row.display_name,
    legalName: row.legal_name,
    locale: row.locale,
    timezone: row.timezone,
    status: row.status,
    role,
    createdAt: row.created_at.toISOString(),
  };
}

export function organizationRoutes(pool: Pool): AnyRoute[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/organizations',
      operationId: 'createOrganization',
      summary: 'Create an organization; the caller becomes its Owner (ORG-01).',
      tags: ['organizations'],
      requires: 'authenticated',
      idempotent: true,
      schemas: {
        body: createOrganizationBody,
        response: { status: 201, schema: organizationSchema },
      },
      async handler({ principal, body, correlationId, idempotencyKey, idempotencyScope }) {
        if (!principal.emailVerified) {
          throw new AppError(
            'email_not_verified',
            'Verify your email address before creating an organization.',
          );
        }
        // The tenant ID is generated server-side and is immutable thereafter.
        const organizationId = randomUUID();
        return withTransaction(pool, { userId: principal.userId, organizationId }, (client) =>
          runIdempotentCommand(
            client,
            { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
            async () => {
              const { rows } = await client.query<OrganizationRow>(
                `INSERT INTO eventhub.organization (id, display_name, legal_name, locale, timezone, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, display_name, legal_name, locale, timezone, status, created_at`,
                [
                  organizationId,
                  body.displayName,
                  body.legalName ?? null,
                  body.locale,
                  body.timezone,
                  principal.userId,
                ],
              );
              await client.query(
                `INSERT INTO eventhub.membership (organization_id, user_id, role, status, accepted_at)
                 VALUES ($1, $2, 'owner', 'active', now())`,
                [organizationId, principal.userId],
              );
              const actor = { type: 'user' as const, id: principal.userId };
              await writeAudit(client, {
                organizationId,
                actor,
                action: 'organization.created',
                targetType: 'organization',
                targetId: organizationId,
                correlationId,
                metadata: { ownerMembership: true },
              });
              await enqueueEvent(
                client,
                createDomainEvent({
                  eventType: 'organization.created',
                  schemaVersion: 1,
                  actor,
                  organizationId,
                  aggregateType: 'organization',
                  aggregateId: organizationId,
                  correlationId,
                  payload: { organizationId },
                }),
              );
              return { status: 201, body: toOrganizationDto(rows[0]!, 'owner') };
            },
          ),
        );
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/me/organizations',
      operationId: 'listMyOrganizations',
      summary:
        'List organizations the caller is an active member of (for explicit switching, ORG-03).',
      tags: ['organizations'],
      requires: 'authenticated',
      idempotent: false,
      schemas: {
        response: {
          status: 200,
          schema: z
            .object({ data: z.array(membershipSummarySchema) })
            .meta({ id: 'MyOrganizationList' }),
        },
      },
      async handler({ principal }) {
        const rows = await withTransaction(
          pool,
          { userId: principal.userId },
          async (client) =>
            (
              await client.query<{
                organization_id: string;
                display_name: string;
                role: (typeof ROLES)[number];
              }>(
                `SELECT m.organization_id, o.display_name, m.role
                 FROM eventhub.membership m
                 JOIN eventhub.organization o ON o.id = m.organization_id
                WHERE m.user_id = $1 AND m.status = 'active'
                ORDER BY o.display_name, o.id`,
                [principal.userId],
              )
            ).rows,
        );
        return {
          status: 200,
          body: {
            data: rows.map((r) => ({
              organizationId: r.organization_id,
              displayName: r.display_name,
              role: r.role,
            })),
          },
        };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId',
      operationId: 'getOrganization',
      summary: 'Read an organization the caller belongs to.',
      tags: ['organizations'],
      requires: 'organization.read',
      idempotent: false,
      schemas: { params: orgParams, response: { status: 200, schema: organizationSchema } },
      async handler({ principal, params }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'organization.read',
          async (client, access) => {
            const { rows } = await client.query<OrganizationRow>(
              `SELECT id, display_name, legal_name, locale, timezone, status, created_at
               FROM eventhub.organization WHERE id = $1`,
              [access.organizationId],
            );
            return { status: 200, body: toOrganizationDto(rows[0]!, access.role) };
          },
        );
      },
    }),
  ];
}
