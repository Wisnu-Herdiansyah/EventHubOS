import { z } from 'zod';
import {
  AppError,
  MANDATORY_NOTICES,
  NOTIFICATIONS,
  NOTIFICATION_KINDS,
  SUPPORT_ROLE,
  mandatoryNoticesFor,
  notificationsFor,
  type NotificationKind,
} from '@eventhub/kernel';
import { writeAudit, type Pool, type PoolClient } from '@eventhub/db';
import { runIdempotentCommand } from '../../http/idempotent-command.ts';
import { defineRoute, type AnyRoute } from '../../http/route.ts';
import { uuid } from '../../http/schemas.ts';
import { withOrganization, type OrganizationAccess } from '../tenancy/access.ts';

/**
 * Email notification settings (ADR-0049). Each member chooses, for this organization, whether
 * they get optional notices; security notices are always sent and are only listed. Everyone
 * reads and changes only their own settings: the service uses the caller's own ID, and RLS
 * limits the table to the caller in the organization of the request.
 */
const params = z.object({ organizationId: uuid }).strict();
const kindParams = z.object({ organizationId: uuid, kind: z.enum(NOTIFICATION_KINDS) }).strict();

const settingSchema = z
  .object({
    kind: z.enum(NOTIFICATION_KINDS),
    enabled: z.boolean(),
    defaultEnabled: z.boolean(),
  })
  .meta({ id: 'NotificationSetting' });

const settingsSchema = z
  .object({
    /** Notices this person may turn on or off, for their role. */
    settings: z.array(settingSchema),
    /** Security notices this person always gets, for their role. */
    alwaysSent: z.array(z.enum(MANDATORY_NOTICES)),
  })
  .meta({ id: 'NotificationSettings' });

function membersOnly(access: OrganizationAccess) {
  // Support access (ADR-0045) is not membership: there is nothing to receive or set.
  if (access.role === SUPPORT_ROLE) {
    throw new AppError('forbidden', 'Email settings are for members of the organization.', {
      details: { reason: 'members_only' },
    });
  }
}

async function stored(client: PoolClient, access: OrganizationAccess) {
  const { rows } = await client.query<{ kind: NotificationKind; enabled: boolean }>(
    `SELECT kind, enabled FROM eventhub.notification_preference
      WHERE organization_id = $1 AND user_id = $2`,
    [access.organizationId, access.userId],
  );
  return new Map(rows.map((r) => [r.kind, r.enabled]));
}

function setting(kind: NotificationKind, saved: Map<NotificationKind, boolean>) {
  const defaultEnabled = NOTIFICATIONS[kind].defaultEnabled;
  return { kind, enabled: saved.get(kind) ?? defaultEnabled, defaultEnabled };
}

export function notificationRoutes(pool: Pool): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/v1/organizations/:organizationId/notification-settings',
      operationId: 'getNotificationSettings',
      summary:
        'Your email settings in this organization: optional notices you can turn on or off, and security notices you always get.',
      tags: ['notifications'],
      requires: 'organization.read',
      idempotent: false,
      schemas: { params, response: { status: 200, schema: settingsSchema } },
      async handler({ principal, params: p }) {
        return withOrganization(
          pool,
          principal,
          p.organizationId,
          'organization.read',
          async (client, access) => {
            membersOnly(access);
            const saved = await stored(client, access);
            return {
              status: 200,
              body: {
                settings: notificationsFor(access.role).map((k) => setting(k, saved)),
                alwaysSent: mandatoryNoticesFor(access.role),
              },
            };
          },
        );
      },
    }),

    defineRoute({
      method: 'PATCH',
      path: '/v1/organizations/:organizationId/notification-settings/:kind',
      operationId: 'updateNotificationSetting',
      summary: 'Turn one optional notice on or off for yourself in this organization.',
      tags: ['notifications'],
      requires: 'organization.read',
      idempotent: true,
      schemas: {
        params: kindParams,
        body: z
          .object({ enabled: z.boolean() })
          .strict()
          .meta({ id: 'UpdateNotificationSettingRequest' }),
        response: { status: 200, schema: settingSchema },
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
          'organization.read',
          (client, access) =>
            runIdempotentCommand(
              client,
              { actorId: principal.userId, scope: idempotencyScope, key: idempotencyKey!, body },
              async () => {
                membersOnly(access);
                if (!notificationsFor(access.role).includes(p.kind)) {
                  throw new AppError('forbidden', 'This notice is not sent to your role.', {
                    details: { reason: 'notification_not_applicable' },
                  });
                }
                const before = setting(p.kind, await stored(client, access)).enabled;
                await client.query(
                  `INSERT INTO eventhub.notification_preference (organization_id, user_id, kind, enabled)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (organization_id, user_id, kind)
                   DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
                  [access.organizationId, access.userId, p.kind, body.enabled],
                );
                if (before !== body.enabled) {
                  const m = await client.query<{ id: string }>(
                    'SELECT id FROM eventhub.membership WHERE organization_id = $1 AND user_id = $2',
                    [access.organizationId, access.userId],
                  );
                  await writeAudit(client, {
                    organizationId: access.organizationId,
                    actor: { type: 'user', id: access.userId },
                    action: 'notification.setting_changed',
                    targetType: 'membership',
                    targetId: m.rows[0]!.id,
                    correlationId,
                    metadata: { kind: p.kind, enabled: body.enabled },
                  });
                }
                return { status: 200, body: setting(p.kind, new Map([[p.kind, body.enabled]])) };
              },
            ),
        );
      },
    }),
  ];
}
