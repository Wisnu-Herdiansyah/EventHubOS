import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AppError,
  createDomainEvent,
  ROLES,
  roleHasPermission,
  type Permission,
  type FieldIssue,
} from '@eventhub/kernel';
import { enqueueEvent, withTransaction, writeAudit, type Pool } from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { ianaTimeZone, languageTag, uuid } from '../../http/schemas.ts';
import { emailSchema } from '../identity/password.ts';
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
    version: z.number().int(),
    /** Present only for roles with billing.read (personal data). */
    billingContact: z
      .object({ name: z.string().nullable(), email: z.string().nullable() })
      .optional(),
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
  version: number;
  billing_contact_name: string | null;
  billing_contact_email: string | null;
}

const ORGANIZATION_COLUMNS =
  'id, display_name, legal_name, locale, timezone, status, created_at, version, billing_contact_name, billing_contact_email';

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
    version: row.version,
    ...(roleHasPermission(role, 'billing.read')
      ? { billingContact: { name: row.billing_contact_name, email: row.billing_contact_email } }
      : {}),
  };
}

const updateOrganizationBody = z
  .object({
    expectedVersion: z.number().int().min(1),
    displayName: z.string().trim().min(1).max(200).optional(),
    legalName: z.string().trim().min(1).max(300).nullable().optional(),
    locale: languageTag.optional(),
    timezone: ianaTimeZone.optional(),
    billingContact: z
      .object({ name: z.string().trim().min(1).max(200), email: emailSchema })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).some((k) => k !== 'expectedVersion'), {
    message: 'Provide at least one field to change.',
  })
  .meta({ id: 'UpdateOrganizationRequest' });

/** Each field names the permission it needs: billing details are separate from the org profile. */
const FIELD_PERMISSIONS: Record<string, Permission> = {
  displayName: 'organization.manage',
  legalName: 'organization.manage',
  locale: 'organization.manage',
  timezone: 'organization.manage',
  billingContact: 'billing.manage',
};

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
                 RETURNING ${ORGANIZATION_COLUMNS}`,
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
              `SELECT ${ORGANIZATION_COLUMNS}
               FROM eventhub.organization WHERE id = $1`,
              [access.organizationId],
            );
            return { status: 200, body: toOrganizationDto(rows[0]!, access.role) };
          },
        );
      },
    }),
    defineRoute({
      method: 'PATCH',
      path: '/v1/organizations/:organizationId',
      operationId: 'updateOrganization',
      summary:
        'Update organization settings (ORG-04). Profile fields need organization.manage; the billing contact needs billing.manage.',
      tags: ['organizations'],
      requires: 'organization.read',
      idempotent: true,
      schemas: {
        params: orgParams,
        body: updateOrganizationBody,
        response: { status: 200, schema: organizationSchema },
      },
      async handler({ principal, params, body, correlationId, idempotencyKey, idempotencyScope }) {
        return withOrganization(
          pool,
          principal,
          params.organizationId,
          'organization.read',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                const fields = Object.keys(body).filter(
                  (k) => k !== 'expectedVersion' && body[k as keyof typeof body] !== undefined,
                );
                // Deny the whole request if any field needs a permission the caller lacks.
                const missing = [...new Set(fields.map((f) => FIELD_PERMISSIONS[f]!))].filter(
                  (perm) => !roleHasPermission(access.role, perm),
                );
                if (missing.length > 0) {
                  throw new AppError(
                    'forbidden',
                    'You do not have permission to change some of these settings.',
                    {
                      details: {
                        reason: 'missing_permission:' + missing[0],
                        fields: fields
                          .filter((f) => missing.includes(FIELD_PERMISSIONS[f]!))
                          .map((f): FieldIssue => ({
                            path: 'body.' + f,
                            message: 'Requires ' + FIELD_PERMISSIONS[f] + '.',
                          })),
                      },
                    },
                  );
                }
                const current = await client.query<{ version: number }>(
                  'SELECT version FROM eventhub.organization WHERE id = $1 FOR UPDATE',
                  [access.organizationId],
                );
                const currentVersion = current.rows[0]!.version;
                if (currentVersion !== body.expectedVersion) {
                  throw new AppError(
                    'conflict',
                    'The organization changed since you loaded it (now version ' +
                      currentVersion +
                      '). Reload and retry.',
                    { details: { reason: 'version_conflict' } },
                  );
                }
                const columns: Array<[string, unknown]> = [];
                if (body.displayName !== undefined)
                  columns.push(['display_name', body.displayName]);
                if (body.legalName !== undefined) columns.push(['legal_name', body.legalName]);
                if (body.locale !== undefined) columns.push(['locale', body.locale]);
                if (body.timezone !== undefined) columns.push(['timezone', body.timezone]);
                if (body.billingContact !== undefined) {
                  columns.push(['billing_contact_name', body.billingContact?.name ?? null]);
                  columns.push(['billing_contact_email', body.billingContact?.email ?? null]);
                }
                const assignments = columns.map(([c], i) => c + ' = $' + String(i + 2)).join(', ');
                const { rows } = await client.query<OrganizationRow>(
                  'UPDATE eventhub.organization SET ' +
                    assignments +
                    ' WHERE id = $1 RETURNING ' +
                    ORGANIZATION_COLUMNS,
                  [access.organizationId, ...columns.map(([, v]) => v)],
                );
                const actor = { type: 'user' as const, id: principal.userId };
                // Field names only: the billing contact is personal data.
                await writeAudit(client, {
                  organizationId: access.organizationId,
                  actor,
                  action: 'organization.updated',
                  targetType: 'organization',
                  targetId: access.organizationId,
                  correlationId,
                  metadata: { fields },
                });
                await enqueueEvent(
                  client,
                  createDomainEvent({
                    eventType: 'organization.updated',
                    schemaVersion: 1,
                    actor,
                    organizationId: access.organizationId,
                    aggregateType: 'organization',
                    aggregateId: access.organizationId,
                    correlationId,
                    payload: { organizationId: access.organizationId, fields },
                  }),
                );
                return { status: 200, body: toOrganizationDto(rows[0]!, access.role) };
              },
            ),
        );
      },
    }),
  ];
}
