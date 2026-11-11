import { z } from 'zod';
import { AppError } from '@eventhub/kernel';
import { withTransaction, type Pool, type PoolClient } from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import type { Principal } from '../identity/authenticator.ts';

/**
 * Platform staff routes (ADR-0045). Staff are made only by an operator (`pnpm platform:staff`),
 * never through the API. Every route here also needs two-step verification; the database
 * functions check both again, so a mistake here cannot widen access.
 */
const EMAIL = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+$/, 'Enter an email address.');

function staffOnly(): AppError {
  return new AppError(
    'forbidden',
    'This is for EventHub staff with two-step verification turned on.',
    { details: { reason: 'platform_staff_required' } },
  );
}

async function staffStatus(client: PoolClient, userId: string) {
  const { rows } = await client.query<{ staff: boolean; mfa: boolean }>(
    `SELECT eventhub.is_platform_staff($1) AS staff, eventhub.auth_mfa_required($1) AS mfa`,
    [userId],
  );
  return { staff: rows[0]?.staff === true, mfa: rows[0]?.mfa === true };
}

/** Runs `fn` for staff with two-step verification; everyone else gets 403. */
async function asStaff<T>(
  pool: Pool,
  principal: Principal,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, { userId: principal.userId }, async (client) => {
    const s = await staffStatus(client, principal.userId);
    if (!s.staff || !s.mfa) throw staffOnly();
    return fn(client);
  });
}

const orgRow = z
  .object({
    id: uuid,
    displayName: z.string(),
    publicHandle: z.string().nullable(),
    status: z.string(),
    createdAt: z.iso.datetime(),
    members: z.number().int(),
    events: z.number().int(),
    /** Until when the organization lets support read it; null when it does not. */
    supportAccessUntil: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PlatformOrganization' });

export function platformRoutes(pool: Pool): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/v1/platform/me',
      operationId: 'getPlatformStatus',
      summary:
        'Whether the caller is EventHub staff, and whether their two-step verification is on.',
      tags: ['platform'],
      requires: 'authenticated',
      idempotent: false,
      schemas: {
        response: {
          status: 200,
          schema: z
            .object({ staff: z.boolean(), mfaEnabled: z.boolean() })
            .meta({ id: 'PlatformStatus' }),
        },
      },
      async handler({ principal }) {
        const s = await withTransaction(pool, { userId: principal.userId }, (client) =>
          staffStatus(client, principal.userId),
        );
        return { status: 200, body: { staff: s.staff, mfaEnabled: s.mfa } };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/platform/organizations',
      operationId: 'listPlatformOrganizations',
      summary:
        'All organizations with counts and support-access status (newest 500). No member or attendee details. Staff only.',
      tags: ['platform'],
      requires: 'platform_staff',
      idempotent: false,
      schemas: {
        response: {
          status: 200,
          schema: z.object({ data: z.array(orgRow) }).meta({ id: 'PlatformOrganizationList' }),
        },
      },
      async handler({ principal }) {
        return asStaff(pool, principal, async (client) => {
          const { rows } = await client.query<{
            out_id: string;
            out_display_name: string;
            out_public_handle: string | null;
            out_status: string;
            out_created_at: Date;
            out_members: number;
            out_events: number;
            out_support_until: Date | null;
          }>('SELECT * FROM eventhub.platform_organizations($1)', [principal.userId]);
          return {
            status: 200,
            body: {
              data: rows.map((r) => ({
                id: r.out_id,
                displayName: r.out_display_name,
                publicHandle: r.out_public_handle,
                status: r.out_status,
                createdAt: r.out_created_at.toISOString(),
                members: r.out_members,
                events: r.out_events,
                supportAccessUntil: r.out_support_until?.toISOString() ?? null,
              })),
            },
          };
        });
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/platform/email-suppressions',
      operationId: 'getEmailSuppression',
      summary:
        'Whether email to one address is suppressed (ADR-0043), and why. Staff only; 404 when it is not.',
      tags: ['platform'],
      requires: 'platform_staff',
      idempotent: false,
      schemas: {
        query: z.object({ address: EMAIL }).strict(),
        response: {
          status: 200,
          schema: z
            .object({
              reason: z.enum(['bounce', 'complaint']),
              lastEventAt: z.iso.datetime(),
              liftedAt: z.iso.datetime().nullable(),
            })
            .meta({ id: 'EmailSuppression' }),
        },
      },
      async handler({ principal, query }) {
        const row = await asStaff(pool, principal, async (client) => {
          const { rows } = await client.query<{
            out_reason: 'bounce' | 'complaint';
            out_last_event_at: Date;
            out_lifted_at: Date | null;
          }>('SELECT * FROM eventhub.platform_email_suppression($1, $2)', [
            principal.userId,
            query.address,
          ]);
          return rows[0];
        });
        if (!row) throw new AppError('not_found', 'Email to this address is not suppressed.');
        return {
          status: 200,
          body: {
            reason: row.out_reason,
            lastEventAt: row.out_last_event_at.toISOString(),
            liftedAt: row.out_lifted_at?.toISOString() ?? null,
          },
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/platform/email-suppressions/lift-bounce',
      operationId: 'liftEmailBounce',
      summary:
        'Lift a bounce suppression by hand, e.g. after the person fixed their mailbox. Complaints are never lifted. Staff only; audited.',
      tags: ['platform'],
      requires: 'platform_staff',
      idempotent: true,
      schemas: {
        body: z.object({ address: EMAIL }).strict().meta({ id: 'LiftEmailBounceRequest' }),
        response: {
          status: 200,
          schema: z.object({ lifted: z.boolean() }).meta({ id: 'LiftEmailBounceResult' }),
        },
      },
      async handler({ principal, body, correlationId, idempotencyKey, idempotencyScope }) {
        return asStaff(pool, principal, (client) =>
          runIdempotentCommand(
            client,
            { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
            async () => {
              const { rows } = await client.query<{ lifted: boolean }>(
                'SELECT eventhub.platform_lift_bounce($1, $2, $3) AS lifted',
                [principal.userId, body.address, correlationId],
              );
              return { status: 200, body: { lifted: rows[0]?.lifted === true } };
            },
          ),
        );
      },
    }),
  ];
}
