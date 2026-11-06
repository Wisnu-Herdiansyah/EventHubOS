import {
  AppError,
  isRole,
  notFound,
  roleHasPermission,
  type Permission,
  type Role,
} from '@eventhub/kernel';
import { setTenantContext, withTransaction, type Pool, type PoolClient } from '@eventhub/db';
import type { Principal } from '../identity/authenticator.ts';

export interface OrganizationAccess {
  organizationId: string;
  userId: string;
  role: Role;
}

/**
 * Resolves tenant context server-side and runs `fn` in one transaction:
 *  1. set app.user_id (RLS then exposes only the caller's own memberships);
 *  2. look up an *active* membership for the URL locator — the URL value is never trusted as
 *     authorization evidence; a non-member gets the same 404 as a non-existent organization;
 *  3. deny by default unless the role explicitly grants `permission` (403 for members);
 *  4. set app.organization_id so every subsequent statement is RLS-scoped to this tenant.
 */
export async function withOrganization<T>(
  pool: Pool,
  principal: Principal,
  organizationLocator: string,
  permission: Permission,
  fn: (client: PoolClient, access: OrganizationAccess) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, { userId: principal.userId }, async (client) => {
    const { rows } = await client.query<{ role: string }>(
      `SELECT m.role
         FROM eventhub.membership m
         JOIN eventhub.organization o ON o.id = m.organization_id
        WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
      [organizationLocator, principal.userId],
    );
    const role = rows[0]?.role;
    if (!isRole(role)) throw notFound('Organization');
    if (!roleHasPermission(role, permission)) {
      throw new AppError('forbidden', 'You do not have permission to perform this action.', {
        details: { reason: `missing_permission:${permission}` },
      });
    }
    await setTenantContext(client, organizationLocator);
    return fn(client, { organizationId: organizationLocator, userId: principal.userId, role });
  });
}
